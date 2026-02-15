import type { WorkspacePackage } from "#core/workspace";
import type { GitCommit } from "commit-parser";
import { getGroupedFilesByCommitSha, getMostRecentPackageTag } from "#core/git";
import { logger } from "#shared/utils";
import { getCommits } from "commit-parser";
import farver from "farver";

/**
 * Get commits grouped by workspace package.
 * For each package, retrieves all commits since its last release tag that affect that package.
 *
 * @param {string} workspaceRoot - The root directory of the workspace
 * @param {WorkspacePackage[]} packages - Array of workspace packages to analyze
 * @returns {Promise<Map<string, GitCommit[]>>} A map of package names to their commits since their last release
 */
export async function getWorkspacePackageGroupedCommits(
  workspaceRoot: string,
  packages: WorkspacePackage[],
): Promise<Map<string, GitCommit[]>> {
  const changedPackages = new Map<string, GitCommit[]>();

  const promises = packages.map(async (pkg) => {
    // Get the latest tag that corresponds to the workspace package
    // This will ensure that we only get commits, since the last release of this package.
    const lastTagResult = await getMostRecentPackageTag(workspaceRoot, pkg.name);
    const lastTag = lastTagResult.ok ? lastTagResult.value : undefined;

    // Get all commits since the last tag, that affect this package
    const allCommits = await getCommits({
      from: lastTag,
      to: "HEAD",
      cwd: workspaceRoot,
      folder: pkg.path,
    });

    logger.verbose(
      `Found ${farver.cyan(allCommits.length)} commits for package ${farver.bold(
        pkg.name,
      )} since tag ${farver.cyan(lastTag ?? "N/A")}`,
    );

    return {
      pkgName: pkg.name,
      commits: allCommits,
    };
  });

  const results = await Promise.all(promises);

  for (const { pkgName, commits } of results) {
    changedPackages.set(pkgName, commits);
  }

  return changedPackages;
}

export async function getPackageCommitsSinceTag(
  workspaceRoot: string,
  pkg: WorkspacePackage,
  fromTag?: string,
): Promise<GitCommit[]> {
  const allCommits = await getCommits({
    from: fromTag,
    to: "HEAD",
    cwd: workspaceRoot,
    folder: pkg.path,
  });

  logger.verbose(
    `Found ${farver.cyan(allCommits.length)} commits for package ${farver.bold(pkg.name)} since ${farver.cyan(fromTag ?? "start")}`,
  );

  return allCommits;
}

/**
 * Check if a file path touches any package folder.
 * @param file - The file path to check
 * @param packagePaths - Set of normalized package paths
 * @param workspaceRoot - The workspace root for path normalization
 * @returns true if the file is inside a package folder
 */
function fileMatchesPackageFolder(
  file: string,
  packagePaths: Set<string>,
  workspaceRoot: string,
): boolean {
  // Normalize the file path (remove leading ./)
  const normalizedFile = file.startsWith("./") ? file.slice(2) : file;

  for (const pkgPath of packagePaths) {
    // Normalize package path (remove workspace root prefix if present)
    const normalizedPkgPath = pkgPath.startsWith(workspaceRoot)
      ? pkgPath.slice(workspaceRoot.length + 1)
      : pkgPath;

    // Check if file is inside this package folder
    if (
      normalizedFile.startsWith(`${normalizedPkgPath}/`)
      || normalizedFile === normalizedPkgPath
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Check if a commit is a "global" commit (doesn't touch any package folder).
 * @param workspaceRoot - The workspace root
 * @param files - Array of files changed in the commit
 * @param packagePaths - Set of normalized package paths
 * @returns true if this is a global commit
 */
function isGlobalCommit(
  workspaceRoot: string,
  files: string[] | undefined,
  packagePaths: Set<string>,
): boolean {
  if (!files || files.length === 0) {
    // If we can't determine files, consider it non-global to be safe
    return false;
  }

  // A commit is global if NONE of its files touch any package folder
  return !files.some((file) => fileMatchesPackageFolder(file, packagePaths, workspaceRoot));
}

const DEPENDENCY_FILES = [
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "yarn.lock",
  "package-lock.json",
] as string[];

/**
 * Find the oldest and newest commits across all packages.
 * @param packageCommits - Map of package commits
 * @returns Object with oldest and newest commit SHAs, or null if no commits
 */
function findCommitRange(packageCommits: Map<string, GitCommit[]>): { oldest: string; newest: string } | null {
  let oldestCommit: string | null = null;
  let newestCommit: string | null = null;

  for (const commits of packageCommits.values()) {
    if (commits.length === 0) continue;

    // Commits are ordered newest to oldest
    const firstCommit = commits[0]!.shortHash;
    const lastCommit = commits[commits.length - 1]!.shortHash;

    if (!newestCommit) {
      newestCommit = firstCommit;
    }
    oldestCommit = lastCommit; // Will be the last package's oldest
  }

  if (!oldestCommit || !newestCommit) return null;
  return { oldest: oldestCommit, newest: newestCommit };
}

/**
 * Get global commits for each package based on their individual commit timelines.
 * This solves the problem where packages with different release histories need different global commits.
 *
 * A "global commit" is a commit that doesn't touch any package folder but may affect all packages
 * (e.g., root package.json, CI config, README).
 *
 * Performance: Makes ONE batched git call to get files for all commits across all packages.
 *
 * @param workspaceRoot - The root directory of the workspace
 * @param packageCommits - Map of package name to their commits (from getWorkspacePackageCommits)
 * @param allPackages - All workspace packages (used to identify package folders)
 * @param mode - Filter mode: false (disabled), "all" (all global commits), or "dependencies" (only dependency-related)
 * @returns Map of package name to their global commits
 */
export async function getGlobalCommitsPerPackage(
  workspaceRoot: string,
  packageCommits: Map<string, GitCommit[]>,
  allPackages: WorkspacePackage[],
  mode?: false | "dependencies" | "all",
): Promise<Map<string, GitCommit[]>> {
  const result = new Map<string, GitCommit[]>();

  if (!mode) {
    logger.verbose("Global commits mode disabled");
    return result;
  }

  logger.verbose(`Computing global commits per-package (mode: ${farver.cyan(mode)})`);

  const commitRange = findCommitRange(packageCommits);
  if (!commitRange) {
    logger.verbose("No commits found across packages");
    return result;
  }

  logger.verbose("Fetching files for commits range", `${farver.cyan(commitRange.oldest)}..${farver.cyan(commitRange.newest)}`);

  const commitFilesMap = await getGroupedFilesByCommitSha(workspaceRoot, commitRange.oldest, commitRange.newest);
  if (!commitFilesMap.ok) {
    logger.warn("Failed to get commit file list, returning empty global commits");
    return result;
  }

  logger.verbose("Got file lists for commits", `${farver.cyan(commitFilesMap.value.size)} commits in ONE git call`);

  const packagePaths = new Set(allPackages.map((p) => p.path));

  for (const [pkgName, commits] of packageCommits) {
    const globalCommitsAffectingPackage: GitCommit[] = [];

    logger.verbose("Filtering global commits for package", `${farver.bold(pkgName)} from ${farver.cyan(commits.length)} commits`);

    for (const commit of commits) {
      const files = commitFilesMap.value.get(commit.shortHash);
      if (!files) continue;

      if (isGlobalCommit(workspaceRoot, files, packagePaths)) {
        globalCommitsAffectingPackage.push(commit);
      }
    }

    logger.verbose("Package global commits found", `${farver.bold(pkgName)}: ${farver.cyan(globalCommitsAffectingPackage.length)} global commits`);

    if (mode === "all") {
      result.set(pkgName, globalCommitsAffectingPackage);
      continue;
    }

    // mode === "dependencies"
    const dependencyCommits: GitCommit[] = [];

    for (const commit of globalCommitsAffectingPackage) {
      const files = commitFilesMap.value.get(commit.shortHash);
      if (!files) continue;

      const affectsDeps = files.some((file) => DEPENDENCY_FILES.includes(file.startsWith("./") ? file.slice(2) : file));

      if (affectsDeps) {
        logger.verbose("Global commit affects dependencies", `${farver.bold(pkgName)}: commit ${farver.cyan(commit.shortHash)} affects dependencies`);
        dependencyCommits.push(commit);
      }
    }

    logger.verbose("Global commits affect dependencies", `${farver.bold(pkgName)}: ${farver.cyan(dependencyCommits.length)} global commits affect dependencies`);
    result.set(pkgName, dependencyCommits);
  }

  return result;
}
