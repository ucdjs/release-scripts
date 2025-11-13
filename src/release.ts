import type {
  FindWorkspacePackagesOptions,
  GlobalCommitMode,
  PackageRelease,
  SharedOptions,
} from "#shared/types";
import process from "node:process";
import {
  createBranch,
  doesBranchExist,
  getCurrentBranch,
  getDefaultBranch,
  isWorkingDirectoryClean,
} from "#core/git";
import { getExistingPullRequest } from "#core/github";
import { discoverWorkspacePackages } from "#core/workspace";
import { exitWithError, logger, normalizeReleaseOptions, normalizeSharedOptions } from "#shared/utils";
import {
  getAllWorkspaceCommits,
  getGlobalCommits,
  getLastTag,
  getWorkspacePackageCommits,
} from "#versioning/commits";
import {
  buildPackageDependencyGraph,
  createDependentUpdates,
} from "#versioning/package";
import { inferVersionUpdates } from "#versioning/version";
import farver from "farver";

export interface ReleaseOptions extends SharedOptions {
  branch?: {
    /**
     * Branch name for the release PR (defaults to "release/next")
     */
    release?: string;

    /**
     * Default branch name (e.g., "main")
     */
    default?: string;
  };

  /**
   * Whether to enable safety safeguards (e.g., checking for clean working directory)
   * @default true
   */
  safeguards?: boolean;

  /**
   * Pull request configuration
   */
  pullRequest?: {
    /**
     * Title for the release pull request
     */
    title?: string;

    /**
     * Body for the release pull request
     *
     * If not provided, a default body will be generated.
     *
     * NOTE:
     * You can use custom template expressions, see [h3js/rendu](https://github.com/h3js/rendu)
     */
    body?: string;
  };

  globalCommitMode?: GlobalCommitMode;
}

export interface ReleaseResult {
  /**
   * Packages that will be updated
   */
  updates: PackageRelease[];

  /**
   * URL of the created or updated PR
   */
  prUrl?: string;

  /**
   * Whether a new PR was created (vs updating existing)
   */
  created: boolean;
}

export async function release(
  options: ReleaseOptions,
): Promise<ReleaseResult | null> {
  const {
    workspaceRoot,
    ...normalizedOptions
  } = await normalizeReleaseOptions(options);

  if (normalizedOptions.safeguards && !(await isWorkingDirectoryClean(workspaceRoot))) {
    exitWithError("Working directory is not clean. Please commit or stash your changes before proceeding.");
  }

  const workspacePackages = await discoverWorkspacePackages(
    workspaceRoot,
    options,
  );

  logger.log(`Discovered ${workspacePackages.length} workspace packages`);
  for (const pkg of workspacePackages) {
    logger.log(`- ${pkg.name} (${farver.dim(pkg.version)})`);
    logger.log(`  path: ${pkg.path}`);
  }

  if (workspacePackages.length === 0) {
    logger.info(farver.yellow("No packages found to release."));
    return null;
  }

  // THE GLOBAL COMMITS PROBLEM
  // ==========================

  // Simple Example:
  // ---------------

  // Commits:
  //   A: pkg-a changes
  //   B: root package.json change (GLOBAL)
  //   C: pkg-c changes

  // Tags:
  //   @pkg-a/1.0.0 → commit C (latest tag)
  //   @pkg-b never released

  // Current (BROKEN) approach:
  // ---------------------------
  // 1. Use latest tag: @pkg-a/1.0.0 (commit C)
  // 2. Get commits since C for ALL packages
  // 3. When releasing pkg-b:
  //    - Starts from commit C
  //    - MISSES commit B (global change)
  //    - pkg-b released without the global dependency update

  // Correct approach:
  // -----------------
  // Each package uses ITS OWN last tag:

  //   pkg-a (last tag @ C): Gets commits since C
  //   pkg-b (no tag):       Gets commits since beginning → INCLUDES B

  // Result: Each package sees exactly the global commits it needs.

  // Performance issue:
  // ------------------
  // Naive: Call git 2000+ times (one per commit per package)
  // Need: Batch git operations, cache file lists

  const lastTagPushed = await getLastTag(workspaceRoot);
  logger.log(`Last pushed tag: ${lastTagPushed || farver.dim("none")}`);

  if (!lastTagPushed) {
    logger.warn("No tags found in the repository. All commits will be considered for release.");
  }

  const allCommits = await getAllWorkspaceCommits(workspaceRoot, lastTagPushed);

  // Get commits affecting each package
  const packageCommits = await getWorkspacePackageCommits(workspaceRoot, workspacePackages);

  // Get global commits, that may affect multiple packages
  const globalCommitsAffectingPackages = await getGlobalCommits(
    workspaceRoot,
    allCommits,
    packageCommits,
    normalizedOptions.globalCommitMode,
  );

  const versionUpdates = await inferVersionUpdates({
    workspacePackages,
    packageCommits,
    workspaceRoot,
    showPrompt: options.prompts?.versions !== false,
    allCommits,
    globalCommits: globalCommitsAffectingPackages,
  });

  if (versionUpdates.length === 0) {
    logger.warn("No packages have changes requiring a release");
  }

  const graph = buildPackageDependencyGraph(workspacePackages);
  console.error("Dependency graph built");
  console.error(graph);

  // Get all packages needing updates (includes transitive dependents)
  const allUpdates = createDependentUpdates(
    graph,
    workspacePackages,
    versionUpdates,
  );

  logger.log(`Total packages to update (including dependents): ${allUpdates.length}`);
  for (const update of allUpdates) {
    logger.log(`- ${update.package.name}: ${farver.dim(update.currentVersion)} -> ${farver.bold(update.newVersion)}`);
  }

  const currentBranch = await getCurrentBranch(workspaceRoot);

  if (currentBranch !== normalizedOptions.branch.default) {
    exitWithError(
      `Current branch is '${currentBranch}'. Please switch to the default branch '${normalizedOptions.branch.default}' before proceeding.`,
      `git checkout ${normalizedOptions.branch.default}`,
    );
  }

  const existingPullRequest = await getExistingPullRequest({
    owner: normalizedOptions.owner,
    repo: normalizedOptions.repo,
    branch: normalizedOptions.branch.release,
    githubToken: normalizedOptions.githubToken,
  });

  // If a pull request already exists, then we are sure that the "release branch" exists.
  const doesReleasePRExist = !!existingPullRequest;

  if (doesReleasePRExist) {
    logger.log("An existing release pull request was found.");
  } else {
    logger.log("No existing pull request found, will create new one");
    const branchExists = await doesBranchExist(normalizedOptions.branch.release, workspaceRoot);

    if (!branchExists) {
      await createBranch(
        normalizedOptions.branch.release,
        normalizedOptions.branch.default,
        workspaceRoot,
      );
    }
  }

  return {
    updates: [],
    // prUrl: pullRequest?.html_url,
    // created: !prExists,
    created: false,
  };
}
