import type { GitCommit } from "commit-parser";
import type { BumpKind } from "./types";
import type { WorkspacePackage } from "./workspace";
import { getCommits } from "commit-parser";
import { logger, run } from "./utils";

export async function getLastPackageTag(
  packageName: string,
  workspaceRoot: string,
): Promise<string | undefined> {
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

export async function getPackageCommits(
  pkg: WorkspacePackage,
  workspaceRoot: string,
): Promise<GitCommit[]> {
  const lastTag = await getLastPackageTag(pkg.name, workspaceRoot);

  // Get all commits since last tag
  const allCommits = getCommits({
    from: lastTag,
    to: "HEAD",
  });

  logger.log(`Found ${allCommits.length} commits for ${pkg.name} since ${lastTag || "beginning"}`);

  // Filter to commits that touch this package's files
  const touchedCommitHashes = await getCommitsTouchingPackage(
    lastTag || "HEAD",
    "HEAD",
    pkg.path,
    workspaceRoot,
  );

  const touchedSet = new Set(touchedCommitHashes);
  const packageCommits = allCommits.filter((commit) =>
    touchedSet.has(commit.shortHash),
  );

  logger.log(`${packageCommits.length} commits affect ${pkg.name}`);

  return packageCommits;
}

export async function analyzePackageCommits(
  pkg: WorkspacePackage,
  workspaceRoot: string,
): Promise<BumpKind> {
  const commits = await getPackageCommits(pkg, workspaceRoot);
  return determineHighestBump(commits);
}

/**
 * Analyze commits for multiple packages to determine version bumps
 *
 * @param packages - Packages to analyze
 * @param workspaceRoot - Root directory of the workspace
 * @returns Map of package names to their bump types
 */
export async function analyzeCommits(
  packages: WorkspacePackage[],
  workspaceRoot: string,
): Promise<Map<string, BumpKind>> {
  const changedPackages = new Map<string, BumpKind>();

  for (const pkg of packages) {
    const bump = await analyzePackageCommits(pkg, workspaceRoot);

    if (bump !== "none") {
      changedPackages.set(pkg.name, bump);
    }
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

export async function getCommitsTouchingPackage(
  from: string,
  to: string,
  packagePath: string,
  workspaceRoot: string,
): Promise<string[]> {
  try {
    const range = from === "HEAD" ? "HEAD" : `${from}...${to}`;

    const { stdout } = await run(
      "git",
      ["log", "--pretty=format:%h", range, "--", packagePath],
      {
        nodeOptions: {
          cwd: workspaceRoot,
          stdio: "pipe",
        },
      },
    );

    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  } catch (error) {
    logger.error(`Error getting commits touching package: ${error}`);
    return [];
  }
}
