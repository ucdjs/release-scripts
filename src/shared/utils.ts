import type { SharedOptions } from "#shared/types";
import type {
  Options as TinyExecOptions,
  Result as TinyExecResult,
} from "tinyexec";
import process from "node:process";
import farver from "farver";
import mri from "mri";
import { exec } from "tinyexec";

export const args = mri(process.argv.slice(2));

export const isDryRun = !!args.dry;
export const isVerbose = !!args.verbose;
export const isForce = !!args.force;

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
    if (!isVerbose) {
      return;
    }

    // eslint-disable-next-line no-console
    console.log(farver.magenta("[log]:"), ...args);
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

export const runIfNotDry = isDryRun ? dryRun : run;

export function exitWithError(message: string, hint?: string): never {
  logger.error(farver.bold(message));
  if (hint) {
    console.error(farver.gray(`  ${hint}`));
  }

  process.exit(1);
}

export function normalizeSharedOptions<T extends SharedOptions>(options: T) {
  const {
    workspaceRoot = process.cwd(),
    githubToken = "",
    repo: fullRepo,
    packages = true,
    prompts = {
      packages: true,
      versions: true,
    },
    ...rest
  } = options;

  if (!githubToken.trim()) {
    exitWithError(
      "GitHub token is required",
      "Set GITHUB_TOKEN environment variable or pass it in options",
    );
  }

  if (!fullRepo || !fullRepo.trim() || !fullRepo.includes("/")) {
    exitWithError(
      "Repository (repo) is required",
      "Specify the repository in 'owner/repo' format (e.g., 'octocat/hello-world')",
    );
  }

  const [owner, repo] = fullRepo.split("/");
  if (!owner || !repo) {
    exitWithError(
      `Invalid repo format: "${fullRepo}"`,
      "Expected format: \"owner/repo\" (e.g., \"octocat/hello-world\")",
    );
  }

  return {
    ...rest,
    packages,
    prompts,
    workspaceRoot,
    githubToken,
    owner,
    repo,
  };
}

if (isDryRun || isVerbose || isForce) {
  logger.debug(farver.inverse(farver.yellow(" Running with special flags ")));
  logger.debug({ isDryRun, isVerbose, isForce });
  logger.debug();
}
