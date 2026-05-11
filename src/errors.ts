import process from "node:process";
import readline from "node:readline";
import { parseArgs } from "node:util";

import { Effect, Stream } from "effect";
import { ChildProcess } from "effect/unstable/process";
import farver from "farver";

export const ucdjsReleaseOverridesPath = ".github/ucdjs-release.overrides.json";

export interface CommandRunOptions {
  throwOnError?: boolean;
  nodeOptions?: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    stdio?: "inherit" | "pipe";
  };
}

export interface CommandRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export class CommandError extends Error {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode?: number;
  readonly shortMessage: string;

  constructor(params: {
    message: string;
    stdout?: string;
    stderr?: string;
    exitCode?: number;
    cause?: unknown;
  }) {
    super(params.message);
    this.name = "CommandError";
    this.stdout = params.stdout ?? "";
    this.stderr = params.stderr ?? "";
    this.exitCode = params.exitCode;
    this.shortMessage = [this.stderr, this.stdout, params.message].find((value) => value.trim()) ?? params.message;
    this.cause = params.cause;
  }
}

export function runCommandEffect(
  bin: string,
  args: string[],
  opts: CommandRunOptions = {},
) {
  const stdio = opts.nodeOptions?.stdio ?? "inherit";
  const shouldPipeOutput = stdio === "pipe";
  const command = ChildProcess.make(bin, args, {
    cwd: opts.nodeOptions?.cwd,
    env: opts.nodeOptions?.env,
    stdin: "inherit",
    stdout: shouldPipeOutput ? "pipe" : "inherit",
    stderr: shouldPipeOutput ? "pipe" : "inherit",
  });

  const makeFailure = (message: string, cause?: unknown, result?: Partial<CommandRunResult>) =>
    new CommandError({
      message,
      stdout: result?.stdout,
      stderr: result?.stderr,
      exitCode: result?.exitCode,
      cause,
    });

  const executeCommand = Effect.fn("executeCommand")(function* () {
    const handle = yield* command;
    const [stdout, stderr, exitCode] = yield* Effect.all([
      shouldPipeOutput
        ? Stream.mkString(Stream.decodeText(handle.stdout))
        : Effect.succeed(""),
      shouldPipeOutput
        ? Stream.mkString(Stream.decodeText(handle.stderr))
        : Effect.succeed(""),
      handle.exitCode,
    ]);

    const result: CommandRunResult = {
      stdout,
      stderr,
      exitCode: Number(exitCode),
    };

    if (result.exitCode !== 0 && opts.throwOnError !== false) {
      return yield* Effect.fail(
        makeFailure(`Process exited with non-zero status ${result.exitCode}`, undefined, result),
      );
    }

    return result;
  });

  return Effect.scoped(executeCommand()).pipe(
    Effect.mapError((error) =>
      error instanceof CommandError
        ? error
        : makeFailure(`Failed to run command: ${bin} ${args.join(" ")}`, error),
    ),
  );
}

function parseCLIFlags(): { dry: boolean; verbose: boolean; force: boolean } {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      dry: { type: "boolean", short: "d", default: false },
      verbose: { type: "boolean", short: "v", default: false },
      force: { type: "boolean", short: "f", default: false },
    },
    strict: false,
  });
  return {
    dry: !!values.dry,
    verbose: !!values.verbose,
    force: !!values.force,
  };
}

function getIsDryRun(): boolean {
  return parseCLIFlags().dry;
}

export function getIsVerbose(): boolean {
  return parseCLIFlags().verbose;
}

export function getIsCI(): boolean {
  const ci = process.env.CI;
  return typeof ci === "string" && ci !== "" && ci.toLowerCase() !== "false";
}

export const logger = {
  info: (...args: unknown[]) => {
    console.info(...args);
  },
  warn: (...args: unknown[]) => {
    console.warn(`  ${farver.yellow("⚠")}`, ...args);
  },
  error: (...args: unknown[]) => {
    console.error(`  ${farver.red("✖")}`, ...args);
  },
  verbose: (...args: unknown[]) => {
    if (!getIsVerbose()) {
      return;
    }
    if (args.length === 0) {
      console.log();
      return;
    }

    if (args.length > 1 && typeof args[0] === "string") {
      console.log(farver.dim(args[0]), ...args.slice(1));
      return;
    }

    console.log(...args);
  },
  section: (title: string) => {
    console.log();
    console.log(`  ${farver.bold(title)}`);
    console.log(`  ${farver.gray("─".repeat(title.length + 2))}`);
  },
  emptyLine: () => {
    console.log();
  },
  item: (message: string, ...args: unknown[]) => {
    console.log(`  ${message}`, ...args);
  },
  step: (message: string) => {
    console.log(`  ${farver.blue("→")} ${message}`);
  },
  success: (message: string) => {
    console.log(`  ${farver.green("✓")} ${message}`);
  },
  clearScreen: () => {
    const repeatCount = process.stdout.rows - 2;
    const blank = repeatCount > 0 ? "\n".repeat(repeatCount) : "";
    console.log(blank);
    readline.cursorTo(process.stdout, 0, 0);
    readline.clearScreenDown(process.stdout);
  },
};

export const runEffect = Effect.fn("runEffect")(
  (bin: string, args: string[], opts: CommandRunOptions = {}) =>
    runCommandEffect(bin, args, {
      throwOnError: true,
      ...opts,
      nodeOptions: {
        stdio: "inherit",
        ...opts.nodeOptions,
      },
    }),
);

const dryRunEffect = Effect.fn("dryRunEffect")(
  (bin: string, args: string[], opts?: CommandRunOptions) =>
    Effect.sync(() => {
      logger.verbose(farver.blue(`[dryrun] ${bin} ${args.join(" ")}`), opts || "");
    }),
);

export const runIfNotDryEffect = Effect.fn("runIfNotDryEffect")(function* (
  bin: string,
  args: string[],
  opts?: CommandRunOptions,
) {
  if (getIsDryRun()) {
    yield* dryRunEffect(bin, args, opts);
    return;
  }

  return yield* runEffect(bin, args, opts);
});

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null;
}

function toTrimmedString(value: unknown): string | undefined {
  if (typeof value === "string") {
    const normalized = value.trim();
    return normalized.length > 0 ? normalized : undefined;
  }

  if (value instanceof Uint8Array) {
    const normalized = new TextDecoder().decode(value).trim();
    return normalized.length > 0 ? normalized : undefined;
  }

  if (isRecord(value) && typeof value.toString === "function") {
    const rendered = value.toString();
    if (typeof rendered === "string" && rendered !== "[object Object]") {
      const normalized = rendered.trim();
      return normalized.length > 0 ? normalized : undefined;
    }
  }

  return undefined;
}

function getNestedField(record: UnknownRecord, keys: string[]): unknown {
  let current: unknown = record;
  for (const key of keys) {
    if (!isRecord(current) || !(key in current)) {
      return undefined;
    }
    current = current[key];
  }

  return current;
}

function extractStderrLike(record: UnknownRecord): string | undefined {
  const candidates: unknown[] = [
    record.stderr,
    record.stdout,
    record.shortMessage,
    record.originalMessage,
    getNestedField(record, ["result", "stderr"]),
    getNestedField(record, ["result", "stdout"]),
    getNestedField(record, ["output", "stderr"]),
    getNestedField(record, ["output", "stdout"]),
    getNestedField(record, ["cause", "stderr"]),
    getNestedField(record, ["cause", "stdout"]),
    getNestedField(record, ["cause", "shortMessage"]),
    getNestedField(record, ["cause", "originalMessage"]),
  ];

  for (const candidate of candidates) {
    const rendered = toTrimmedString(candidate);
    if (rendered) {
      return rendered;
    }
  }

  return undefined;
}

interface FormattedUnknownError {
  message: string;
  stderr?: string;
  code?: string;
  status?: number;
  stack?: string;
}

export function formatUnknownError(error: unknown): FormattedUnknownError {
  if (error instanceof Error) {
    const base: FormattedUnknownError = {
      message: error.message || error.name,
      stack: error.stack,
    };

    const maybeError = error as Error & UnknownRecord;

    if (typeof maybeError.code === "string") {
      base.code = maybeError.code;
    }

    if (typeof maybeError.status === "number") {
      base.status = maybeError.status;
    }

    base.stderr = extractStderrLike(maybeError);

    if (
      typeof maybeError.shortMessage === "string" &&
      maybeError.shortMessage.trim() &&
      base.message.startsWith("Process exited with non-zero status")
    ) {
      base.message = maybeError.shortMessage.trim();
    }

    if (!base.stderr && typeof maybeError.cause === "string" && maybeError.cause.trim()) {
      base.stderr = maybeError.cause.trim();
    }

    return base;
  }

  if (typeof error === "string") {
    return {
      message: error,
    };
  }

  if (isRecord(error)) {
    const message =
      typeof error.message === "string"
        ? error.message
        : typeof error.error === "string"
          ? error.error
          : JSON.stringify(error);

    const formatted: FormattedUnknownError = {
      message,
    };

    if (typeof error.code === "string") {
      formatted.code = error.code;
    }

    if (typeof error.status === "number") {
      formatted.status = error.status;
    }

    formatted.stderr = extractStderrLike(error);

    return formatted;
  }

  return {
    message: String(error),
  };
}

export class ReleaseError extends Error {
  readonly hint?: string;

  constructor(message: string, hint?: string, cause?: unknown) {
    super(message);
    this.name = "ReleaseError";
    this.hint = hint;
    this.cause = cause;
  }
}

export function printReleaseError(error: ReleaseError): void {
  console.error(`  ${farver.red("✖")} ${farver.bold(error.message)}`);

  if (error.cause !== undefined) {
    const formatted = formatUnknownError(error.cause);
    if (formatted.message && formatted.message !== error.message) {
      console.error(farver.gray(`  Cause: ${formatted.message}`));
    }

    if (formatted.code) {
      console.error(farver.gray(`  Code: ${formatted.code}`));
    }

    if (typeof formatted.status === "number") {
      console.error(farver.gray(`  Status: ${formatted.status}`));
    }

    if (formatted.stderr) {
      console.error(farver.gray("  Stderr:"));
      console.error(farver.gray(`  ${formatted.stderr}`));
    }

    if (getIsVerbose() && formatted.stack) {
      console.error(farver.gray("  Stack:"));
      console.error(farver.gray(`  ${formatted.stack}`));
    }
  }

  if (error.hint) {
    console.error(farver.gray(`  ${error.hint}`));
  }
}

export function exitWithError(message: string, hint?: string, cause?: unknown): never {
  throw new ReleaseError(message, hint, cause);
}
