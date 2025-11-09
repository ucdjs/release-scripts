import type { ChangelogOptions } from "./changelog";
import type {
  SharedOptions,
  VersionUpdate,
} from "./types";
import farver from "farver";
import { updateChangelogs } from "./changelog";
import { getWorkspacePackageCommits } from "./commits";
import {
  checkoutBranch,
  commitChanges,
  createBranch,
  doesBranchExist,
  getCurrentBranch,
  getDefaultBranch,
  isBranchAheadOfRemote,
  isWorkingDirectoryClean,
  pullLatestChanges,
  pushBranch,
  rebaseBranch,
} from "./git";
import {
  generatePullRequestBody,
  getExistingPullRequest,
  upsertPullRequest,
} from "./github";
import {
  buildPackageDependencyGraph,
  createDependentUpdates,
  updateAllPackageJsonFiles,
} from "./package";
import { exitWithError, globalOptions, logger, normalizeSharedOptions } from "./utils";
import { inferVersionUpdates } from "./version";
import { discoverWorkspacePackages } from "./workspace";

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
   * Whether to perform a dry run (no changes pushed or PR created)
   * @default false
   */
  dryRun?: boolean;

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

  /**
   * Changelog configuration
   */
  changelog?: ChangelogOptions;
}

export interface ReleaseResult {
  /**
   * Packages that will be updated
   */
  updates: VersionUpdate[];

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
  const normalizedOptions = normalizeSharedOptions(options);

  normalizedOptions.dryRun ??= false;
  normalizedOptions.branch ??= {};
  normalizedOptions.branch.release ??= "release/next";
  normalizedOptions.branch.default = await getDefaultBranch();
  normalizedOptions.safeguards ??= true;

  normalizedOptions.changelog ??= { enabled: true };

  globalOptions.dryRun = normalizedOptions.dryRun;

  const workspaceRoot = normalizedOptions.workspaceRoot;

  if (normalizedOptions.safeguards && !(await isWorkingDirectoryClean(workspaceRoot))) {
    exitWithError("Working directory is not clean. Please commit or stash your changes before proceeding.");
  }

  const workspacePackages = await discoverWorkspacePackages(
    workspaceRoot,
    options,
  );

  if (workspacePackages.length === 0) {
    logger.log("No packages found to release.");
    return null;
  }

  // Get commits for all packages
  const packageCommits = await getWorkspacePackageCommits(workspaceRoot, workspacePackages);

  const versionUpdates = await inferVersionUpdates(
    workspacePackages,
    packageCommits,
    workspaceRoot,
    options.prompts?.versions !== false,
  );

  if (versionUpdates.length === 0) {
    logger.warn("No packages have changes requiring a release");
  }

  const graph = buildPackageDependencyGraph(workspacePackages);

  // Get all packages needing updates (includes transitive dependents)
  const allUpdates = createDependentUpdates(
    graph,
    workspacePackages,
    versionUpdates,
  );

  const currentBranch = await getCurrentBranch(workspaceRoot);

  if (currentBranch !== normalizedOptions.branch.default) {
    exitWithError(
      `Current branch is '${currentBranch}'. Please switch to the default branch '${normalizedOptions.branch.default}' before proceeding.`,
      `git checkout ${normalizedOptions.branch.default}`,
    );
  }

  // Check if PR already exists
  const existingPullRequest = await getExistingPullRequest({
    owner: normalizedOptions.owner,
    repo: normalizedOptions.repo,
    branch: normalizedOptions.branch.release,
    githubToken: normalizedOptions.githubToken,
  });

  const prExists = !!existingPullRequest;
  if (prExists) {
    logger.log("Existing pull request found:", existingPullRequest.html_url);
  } else {
    logger.log("No existing pull request found, will create new one");
  }

  // Ensure release branch exists
  const branchExists = await doesBranchExist(normalizedOptions.branch.release, workspaceRoot);
  if (!branchExists) {
    logger.log("Creating release branch:", normalizedOptions.branch.release);
    await createBranch(normalizedOptions.branch.release, normalizedOptions.branch.default, workspaceRoot);
  }

  // Checkout release branch
  const hasCheckedOut = await checkoutBranch(normalizedOptions.branch.release, workspaceRoot);
  if (!hasCheckedOut) {
    throw new Error(`Failed to checkout branch: ${normalizedOptions.branch.release}`);
  }

  // Pull latest changes if branch exists remotely
  if (branchExists) {
    logger.log("Pulling latest changes from remote");
    const hasPulled = await pullLatestChanges(normalizedOptions.branch.release, workspaceRoot);
    if (!hasPulled) {
      logger.log("Warning: Failed to pull latest changes, continuing anyway");
    }
  }

  // Rebase onto current branch to get latest commits from main
  logger.log("Rebasing release branch onto", normalizedOptions.branch.default);
  await rebaseBranch(normalizedOptions.branch.default, workspaceRoot);

  // Update package.json files
  await updateAllPackageJsonFiles(allUpdates);

  // Generate changelogs if enabled
  await updateChangelogs(versionUpdates, packageCommits, {
    ...options.changelog,
    repository: options.changelog?.repository || {
      owner: normalizedOptions.owner,
      repo: normalizedOptions.repo,
    },
  });

  // Commit the changes (if there are any)
  const hasCommitted = await commitChanges("chore: update release versions", workspaceRoot);

  // Check if branch is ahead of remote (has commits to push)
  const isBranchAhead = await isBranchAheadOfRemote(normalizedOptions.branch.release, workspaceRoot);

  if (!hasCommitted && !isBranchAhead) {
    logger.log("No changes to commit and branch is in sync with remote");
    await checkoutBranch(normalizedOptions.branch.default, workspaceRoot);

    if (prExists) {
      logger.log("No updates needed, PR is already up to date");
      return {
        updates: allUpdates,
        prUrl: existingPullRequest.html_url,
        created: false,
      };
    } else {
      logger.error("No changes to commit, and no existing PR. Nothing to do.");
      return null;
    }
  }

  // Push with --force-with-lease for safety
  logger.log("Pushing changes to remote");
  await pushBranch(normalizedOptions.branch.release, workspaceRoot, { forceWithLease: true });

  // Create or update PR
  const prTitle = existingPullRequest?.title || (options.pullRequest?.title || "chore: update package versions");
  const prBody = generatePullRequestBody(allUpdates, options.pullRequest?.body);

  const pullRequest = await upsertPullRequest({
    owner: normalizedOptions.owner,
    repo: normalizedOptions.repo,
    pullNumber: existingPullRequest?.number,
    title: prTitle,
    body: prBody,
    head: normalizedOptions.branch.release,
    base: normalizedOptions.branch.default,
    githubToken: normalizedOptions.githubToken,
  });

  logger.log(prExists ? "Updated pull request:" : "Created pull request:", pullRequest?.html_url);

  await checkoutBranch(normalizedOptions.branch.default, workspaceRoot);

  if (pullRequest?.html_url) {
    logger.info();
    logger.info(`${farver.green("✓")} Pull request ${prExists ? "updated" : "created"}: ${farver.cyan(pullRequest.html_url)}`);
  }

  return {
    updates: allUpdates,
    prUrl: pullRequest?.html_url,
    created: !prExists,
  };
}
