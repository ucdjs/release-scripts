import process from "node:process";
import readline from "node:readline";
import { parseArgs } from "node:util";

import farver from "farver";
import type { Options as TinyExecOptions, Result as TinyExecResult } from "tinyexec";
import { exec } from "tinyexec";

export const ucdjsReleaseOverridesPath = ".github/ucdjs-release.overrides.json";

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

async function dryRun(bin: string, args: string[], opts?: Partial<TinyExecOptions>): Promise<void> {
  return logger.verbose(farver.blue(`[dryrun] ${bin} ${args.join(" ")}`), opts || "");
}

export async function runIfNotDry(
  bin: string,
  args: string[],
  opts?: Partial<TinyExecOptions>,
): Promise<TinyExecResult | void> {
  return getIsDryRun() ? dryRun(bin, args, opts) : run(bin, args, opts);
}
