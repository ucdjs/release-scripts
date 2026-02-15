import type {
  Options as TinyExecOptions,
  Result as TinyExecResult,
} from "tinyexec";
import process from "node:process";
import readline from "node:readline";
import farver from "farver";
import mri from "mri";
import { exec } from "tinyexec";

export const args = mri(process.argv.slice(2));

const isDryRun = !!args.dry;
const isVerbose = !!args.verbose;
const isForce = !!args.force;

type UnknownRecord = Record<string, unknown>;

export const ucdjsReleaseOverridesPath = ".github/ucdjs-release.overrides.json";

export const isCI = typeof process.env.CI === "string" && process.env.CI !== "" && process.env.CI.toLowerCase() !== "false";

export const logger = {
  info: (...args: unknown[]) => {
    // eslint-disable-next-line no-console
    console.info(...args);
  },
  warn: (...args: unknown[]) => {
    console.warn(`  ${farver.yellow("⚠")}`, ...args);
  },
  error: (...args: unknown[]) => {
    console.error(`  ${farver.red("✖")}`, ...args);
  },

  // Only log if verbose mode is enabled
  verbose: (...args: unknown[]) => {
    if (!isVerbose) {
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

export async function run(
  bin: string,
  args: string[],
  opts: Partial<TinyExecOptions> = {},
): Promise<TinyExecResult> {
  return exec(bin, args, {
    throwOnError: true,
    ...opts,
    nodeOptions: {
      stdio: "inherit",
      ...opts.nodeOptions,
    },
  });
}

export async function dryRun(
  bin: string,
  args: string[],
  opts?: Partial<TinyExecOptions>,
): Promise<void> {
  return logger.verbose(
    farver.blue(`[dryrun] ${bin} ${args.join(" ")}`),
    opts || "",
  );
}

export const runIfNotDry = isDryRun ? dryRun : run;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null;
}

export interface FormattedUnknownError {
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

    if (typeof maybeError.stderr === "string" && maybeError.stderr.trim()) {
      base.stderr = maybeError.stderr.trim();
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
    const message = typeof error.message === "string"
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

    if (typeof error.stderr === "string" && error.stderr.trim()) {
      formatted.stderr = error.stderr.trim();
    }

    return formatted;
  }

  return {
    message: String(error),
  };
}

export function exitWithError(message: string, hint?: string, cause?: unknown): never {
  logger.error(farver.bold(message));

  if (cause !== undefined) {
    const formatted = formatUnknownError(cause);
    if (formatted.message && formatted.message !== message) {
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

    if (isVerbose && formatted.stack) {
      console.error(farver.gray("  Stack:"));
      console.error(farver.gray(`  ${formatted.stack}`));
    }
  }

  if (hint) {
    console.error(farver.gray(`  ${hint}`));
  }

  process.exit(1);
}

if (isDryRun || isVerbose || isForce) {
  logger.verbose(farver.inverse(farver.yellow(" Running with special flags ")));
  logger.verbose({ isDryRun, isVerbose, isForce });
  logger.verbose();
}
