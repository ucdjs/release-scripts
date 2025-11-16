import type { ReleaseOptions } from "#release";
import type { SharedOptions } from "./types";
import process from "node:process";
import { getAvailableBranches, getDefaultBranch } from "#core/git";
import { DEFAULT_PR_BODY_TEMPLATE } from "#core/github";
import farver from "farver";
import { exitWithError, logger } from "./utils";

type DeepRequired<T> = Required<{
  [K in keyof T]: T[K] extends Required<T[K]> ? T[K] : DeepRequired<T[K]>
}>;

export type NormalizedSharedOptions = DeepRequired<Omit<SharedOptions, "repo">> & {
  /**
   * Repository owner (extracted from repo)
   */
  owner: string;

  /**
   * Repository name (extracted from repo)
   */
  repo: string;
};

export function normalizeSharedOptions(options: SharedOptions): NormalizedSharedOptions {
  const {
    workspaceRoot = process.cwd(),
    githubToken = "",
    repo: fullRepo,
    packages = true,
    prompts = {
      packages: true,
      versions: true,
    },
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

  const normalizedPackages = typeof packages === "object" && !Array.isArray(packages)
    ? {
        exclude: packages.exclude ?? [],
        include: packages.include ?? [],
        excludePrivate: packages.excludePrivate ?? false,
      }
    : packages;
  return {
    packages: normalizedPackages,
    prompts: {
      packages: prompts?.packages ?? true,
      versions: prompts?.versions ?? true,
    },
    workspaceRoot,
    githubToken,
    owner,
    repo,
  };
}

export type NormalizedReleaseOptions = DeepRequired<Omit<ReleaseOptions, keyof SharedOptions>> & NormalizedSharedOptions;

export async function normalizeReleaseOptions(options: ReleaseOptions): Promise<NormalizedReleaseOptions> {
  const normalized = normalizeSharedOptions(options);

  let defaultBranch = options.branch?.default?.trim();
  const releaseBranch = options.branch?.release?.trim() ?? "release/next";

  if (defaultBranch == null || defaultBranch === "") {
    defaultBranch = await getDefaultBranch(normalized.workspaceRoot);

    if (!defaultBranch) {
      exitWithError(
        "Could not determine default branch",
        "Please specify the default branch in options",
      );
    }
  }

  // Ensure that default branch is available, and not the same as release branch
  if (defaultBranch === releaseBranch) {
    exitWithError(
      `Default branch and release branch cannot be the same: "${defaultBranch}"`,
      "Specify different branches for default and release",
    );
  }

  const availableBranches = await getAvailableBranches(normalized.workspaceRoot);
  if (!availableBranches.includes(defaultBranch)) {
    exitWithError(
      `Default branch "${defaultBranch}" does not exist in the repository`,
      `Available branches: ${availableBranches.join(", ")}`,
    );
  }

  logger.verbose(`Using default branch: ${farver.green(defaultBranch)}`);

  return {
    ...normalized,
    branch: {
      release: releaseBranch,
      default: defaultBranch,
    },
    safeguards: options.safeguards ?? true,
    globalCommitMode: options.globalCommitMode ?? "dependencies",
    pullRequest: {
      title: options.pullRequest?.title ?? "chore: release new version",
      body: options.pullRequest?.body ?? DEFAULT_PR_BODY_TEMPLATE,
    },
    changelog: {
      enabled: options.changelog?.enabled ?? true,
    },
  };
}
