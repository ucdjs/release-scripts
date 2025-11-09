import type {
  Options as TinyExecOptions,
  Result as TinyExecResult,
} from "tinyexec";
import type { SharedOptions } from "./types";
import process from "node:process";
import farver from "farver";
import { exec } from "tinyexec";

export const globalOptions = {
  /**
   * If true, commands will be logged instead of executed
   */
  dryRun: false,

  /**
   * Verbosity level of logging
   */
  verbose: false,
};

export const isCI = typeof process.env.CI === "string" && process.env.CI !== "" && process.env.CI.toLowerCase() !== "false";

export const logger = {
  info: (...args: unknown[]) => {
    // eslint-disable-next-line no-console
    console.info(farver.cyan("[info]:"), ...args);
  },
  debug: (...args: unknown[]) => {
    // eslint-disable-next-line no-console
    console.debug(farver.gray("[debug]:"), ...args);
  },
  warn: (...args: unknown[]) => {
    console.warn(farver.yellow("[warn]:"), ...args);
  },
  error: (...args: unknown[]) => {
    console.error(farver.red("[error]:"), ...args);
  },
  log: (...args: unknown[]) => {
    if (!globalOptions.verbose) {
      return;
    }

    // eslint-disable-next-line no-console
    console.log(...args);
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
  return logger.log(
    farver.blue(`[dryrun] ${bin} ${args.join(" ")}`),
    opts || "",
  );
}

export const runIfNotDry = globalOptions.dryRun ? dryRun : run;

export function exitWithError(message: string, hint?: string): never {
  logger.error(farver.bold(message));
  if (hint) {
    console.error(farver.gray(`  ${hint}`));
  }
  process.exit(1);
}

export function normalizeSharedOptions<T extends SharedOptions>(options: T) {
  const workspaceRoot = options.workspaceRoot || process.cwd();
  const githubToken = options.githubToken?.trim() || "";
  const verbose = options.verbose ?? false;

  if (!githubToken) {
    exitWithError(
      "GitHub token is required",
      "Set GITHUB_TOKEN environment variable or pass it in options",
    );
  }

  const [owner, repo] = options.repo.split("/");
  if (!owner || !repo) {
    exitWithError(
      `Invalid repo format: "${options.repo}"`,
      "Expected format: \"owner/repo\" (e.g., \"octocat/hello-world\")",
    );
  }

  return {
    workspaceRoot,
    githubToken,
    owner,
    repo,
    verbose,
  };
}
