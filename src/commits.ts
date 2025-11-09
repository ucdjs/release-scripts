import type { GitCommit } from "commit-parser";
import type { BumpKind } from "./types";
import type { WorkspacePackage } from "./workspace";
import { getCommits } from "commit-parser";
import { logger, run } from "./utils";

export async function getLastPackageTag(
  packageName: string,
  workspaceRoot: string,
): Promise<string | undefined> {
  try {
    // Tags for each package is always
    const { stdout } = await run("git", ["tag", "--list"], {
      nodeOptions: {
        cwd: workspaceRoot,
        stdio: "pipe",
      },
    });

    const tags = stdout.split("\n").map((tag) => tag.trim()).filter(Boolean);

    // Find the last tag for the specified package
    const lastTag = tags.reverse().find((tag) => tag.startsWith(`${packageName}@`));

    return lastTag;
  } catch (err) {
    logger.warn(
      `Failed to get tags for package ${packageName}: ${(err as Error).message}`,
    );
    return undefined;
  }
}

export function determineHighestBump(commits: GitCommit[]): BumpKind {
  if (commits.length === 0) {
    return "none";
  }

  let highestBump: BumpKind = "none";

  for (const commit of commits) {
    const bump = determineBumpType(commit);

    // Priority: major > minor > patch > none
    if (bump === "major") {
      return "major"; // Early exit - can't get higher
    }

    if (bump === "minor") {
      highestBump = "minor";
    } else if (bump === "patch" && highestBump === "none") {
      highestBump = "patch";
    }
  }

  return highestBump;
}

/**
 * Retrieves commits that affect a specific workspace package since its last tag.
 *
 * @param {string} workspaceRoot - The root directory of the workspace.
 * @param {WorkspacePackage} pkg - The workspace package to analyze.
 * @returns {Promise<GitCommit[]>} A promise that resolves to an array of GitCommit objects affecting the package.
 */
export async function getCommitsForWorkspacePackage(
  workspaceRoot: string,
  pkg: WorkspacePackage,
): Promise<GitCommit[]> {
  const lastTag = await getLastPackageTag(pkg.name, workspaceRoot);

  // Get all commits since last tag
  const allCommits = getCommits({
    from: lastTag,
    to: "HEAD",
    cwd: workspaceRoot,
  });

  logger.log(`Found ${allCommits.length} commits for ${pkg.name} since ${lastTag || "beginning"}`);

  const touchedCommitHashes = getCommits({
    from: lastTag,
    to: "HEAD",
    cwd: workspaceRoot,
    folder: pkg.path,
  });

  const touchedSet = new Set(touchedCommitHashes);
  const packageCommits = allCommits.filter((commit) =>
    touchedSet.has(commit),
  );

  logger.log(`${packageCommits.length} commits affect ${pkg.name}`);

  return packageCommits;
}

export async function getWorkspacePackageCommits(
  workspaceRoot: string,
  packages: WorkspacePackage[],
): Promise<Map<string, GitCommit[]>> {
  const changedPackages = new Map<string, GitCommit[]>();

  const promises = packages.map(async (pkg) => {
    return { pkgName: pkg.name, commits: await getCommitsForWorkspacePackage(workspaceRoot, pkg) };
  });

  const results = await Promise.all(promises);

  for (const { pkgName, commits } of results) {
    changedPackages.set(pkgName, commits);
  }

  return changedPackages;
}

export function determineBumpType(commit: GitCommit): BumpKind {
  // Breaking change always results in major bump
  if (commit.isBreaking) {
    return "major";
  }

  // Non-conventional commits don't trigger bumps
  if (!commit.isConventional || !commit.type) {
    return "none";
  }

  // Map conventional commit types to bump types
  switch (commit.type) {
    case "feat":
      return "minor";

    case "fix":
    case "perf":
      return "patch";

    // These don't trigger version bumps
    case "docs":
    case "style":
    case "refactor":
    case "test":
    case "build":
    case "ci":
    case "chore":
    case "revert":
      return "none";

    default:
      // Unknown types don't trigger bumps
      return "none";
  }
}
