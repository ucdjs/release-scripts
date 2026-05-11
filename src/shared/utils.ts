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
    // oxlint-disable-next-line no-console
    console.info(...args);
  },
  warn: (...args: unknown[]) => {
    // oxlint-disable-next-line no-console
    console.warn(`  ${farver.yellow("⚠")}`, ...args);
  },
  error: (...args: unknown[]) => {
    console.error(`  ${farver.red("✖")}`, ...args);
  },

  // Only log if verbose mode is enabled
  verbose: (...args: unknown[]) => {
    if (!getIsVerbose()) {
      return;
    }
    if (args.length === 0) {
      // eslint-disable-next-line no-console
      console.log();
      return;
    }

    // If there is more than one argument, and the first is a string, treat it as a highlight
    if (args.length > 1 && typeof args[0] === "string") {
      // eslint-disable-next-line no-console
      console.log(farver.dim(args[0]), ...args.slice(1));
      return;
    }

    // eslint-disable-next-line no-console
    console.log(...args);
  },

  section: (title: string) => {
    // eslint-disable-next-line no-console
    console.log();
    // eslint-disable-next-line no-console
    console.log(`  ${farver.bold(title)}`);
    // eslint-disable-next-line no-console
    console.log(`  ${farver.gray("─".repeat(title.length + 2))}`);
  },

  emptyLine: () => {
    // eslint-disable-next-line no-console
    console.log();
  },

  item: (message: string, ...args: unknown[]) => {
    // eslint-disable-next-line no-console
    console.log(`  ${message}`, ...args);
  },

  step: (message: string) => {
    // eslint-disable-next-line no-console
    console.log(`  ${farver.blue("→")} ${message}`);
  },

  success: (message: string) => {
    // eslint-disable-next-line no-console
    console.log(`  ${farver.green("✓")} ${message}`);
  },

  clearScreen: () => {
    const repeatCount = process.stdout.rows - 2;
    const blank = repeatCount > 0 ? "\n".repeat(repeatCount) : "";
    // eslint-disable-next-line no-console
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
