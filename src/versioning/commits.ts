import type { WorkspacePackage } from "#core/workspace";
import type { BumpKind } from "#shared/types";
import type { GitCommit } from "commit-parser";
import { logger, run } from "#shared/utils";
import { getCommits } from "commit-parser";

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

export async function getLastTag(
  workspaceRoot: string,
): Promise<string | undefined> {
  try {
    const { stdout } = await run("git", ["describe", "--tags", "--abbrev=0"], {
      nodeOptions: {
        cwd: workspaceRoot,
        stdio: "pipe",
      },
    });

    return stdout.trim();
  } catch (err) {
    logger.warn(
      `Failed to get last tag: ${(err as Error).message}`,
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
    // logger.debug(`Commit ${commit.shortHash} results in a ${bump} bump`);

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

  const commitsAffectingPackage = getCommits({
    from: lastTag,
    to: "HEAD",
    cwd: workspaceRoot,
    folder: pkg.path,
  });

  const affectingCommitShas = new Set();
  for (const commit of commitsAffectingPackage) {
    affectingCommitShas.add(commit.shortHash);
  }

  const packageCommits = allCommits.filter((commit) => {
    return affectingCommitShas.has(commit.shortHash);
  });

  logger.log(`${packageCommits.length} commits affect ${pkg.name}`);

  return packageCommits;
}

export async function getWorkspacePackageCommits(
  workspaceRoot: string,
  packages: WorkspacePackage[],
): Promise<Map<string, GitCommit[]>> {
  const changedPackages = new Map<string, GitCommit[]>();

  const promises = packages.map(async (pkg) => {
    return {
      pkgName: pkg.name,
      commits: await getCommitsForWorkspacePackage(workspaceRoot, pkg),
    };
  });

  const results = await Promise.all(promises);

  for (const { pkgName, commits } of results) {
    changedPackages.set(pkgName, commits);
  }

  return changedPackages;
}

/**
 * Get all commits for the workspace (not filtered by package)
 */
export async function getAllWorkspaceCommits(
  workspaceRoot: string,
  lastTag?: string,
): Promise<GitCommit[]> {
  return getCommits({
    from: lastTag,
    to: "HEAD",
    cwd: workspaceRoot,
  });
}

export async function getCommitFileList(workspaceRoot: string, from: string, to: string) {
  const map = new Map<string, string[]>();

  try {
    const { stdout } = await run("git", ["log", "--name-only", "--format=\"%H\"", `${from}^..${to}`], {
      nodeOptions: {
        cwd: workspaceRoot,
        stdio: "pipe",
      },
    });

    const lines = stdout.trim().split("\n");

    let currentSha = null;

    for (const line of lines) {
      if (line === "") {
      // Empty line separates commits
        currentSha = null;
      } else if (currentSha === null) {
      // First non-empty line is a SHA
        currentSha = line;
        map.set(currentSha, []);
      } else {
      // Subsequent lines are files
        map.get(currentSha)!.push(line);
      }
    }

    return map;
  } catch {
    return null;
  }
}

/**
 * Get global commits that should be included in all packages
 * This is computed once and reused for all packages
 */
export async function getGlobalCommits(
  workspaceRoot: string,
  allCommits: GitCommit[],
  packageCommitsMap: Map<string, GitCommit[]>,
  mode?: false | "dependencies" | "all",
): Promise<GitCommit[]> {
  if (!mode) {
    return [];
  }

  // Find commits that don't touch any package
  const allPackageCommitShas = new Set<string>();
  for (const commits of packageCommitsMap.values()) {
    for (const commit of commits) {
      allPackageCommitShas.add(commit.shortHash);
    }
  }

  const globalCommits = allCommits.filter((c) => !allPackageCommitShas.has(c.shortHash));

  if (mode === "all") {
    return globalCommits;
  }

  if (mode === "dependencies") {
    // Check each global commit once to see if it affects dependency files
    const dependencyCommits: GitCommit[] = [];

    const files = ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"];

    logger.info(`Checking ${globalCommits.length} global commits for dependency changes`);
    logger.debug("First sha:", globalCommits[0]?.shortHash);
    logger.debug("Last sha:", globalCommits[globalCommits.length - 1]?.shortHash);

    const map = await getCommitFileList(
      workspaceRoot,
      globalCommits[globalCommits.length - 1]?.shortHash || "",
      globalCommits[0]?.shortHash || "",
    );
    logger.debug("Commit files map size:", map?.size);

    for (const commit of globalCommits) {
      const affectedFiles = map?.get(commit.shortHash);

      if (affectedFiles == null) continue;

      const affectsDeps = affectedFiles.some((file) => {
        logger.debug(`Commit ${commit.shortHash} changed file: ${file}`);
        return files.includes(file) || (file.startsWith("packages/") && file.endsWith("package.json"));
      });

      if (affectsDeps) {
        logger.info(`Global commit ${commit.shortHash} affects dependencies`);
        dependencyCommits.push(commit);
      }
    }

    return dependencyCommits;
  }

  return [];
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
