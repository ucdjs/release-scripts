import type {
  GlobalCommitMode,
  PackageRelease,
  SharedOptions,
} from "./types";
import farver from "farver";
import { getAllWorkspaceCommits, getGlobalCommits, getLastPackageTag, getLastTag, getWorkspacePackageCommits } from "./commits";
import {
  checkoutBranch,
  commitChanges,
  createBranch,
  deleteLocalBranch,
  deleteRemoteBranch,
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
import { args, exitWithError, logger, normalizeSharedOptions } from "./utils";
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
  const normalizedOptions = normalizeSharedOptions(options);

  normalizedOptions.branch ??= {};
  normalizedOptions.branch.release ??= "release/next";
  normalizedOptions.branch.default = await getDefaultBranch();
  normalizedOptions.safeguards ??= true;
  normalizedOptions.changelog ??= { enabled: true };
  normalizedOptions.globalCommitMode ??= "dependencies";

  const isCleanFlag = !!args.clean;

  const workspaceRoot = normalizedOptions.workspaceRoot;

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

  // TODO: what if the last tag pushed has included some important changes for another package?
  // That package would miss those changes in its changelog.
  // Maybe we should get the last tag for each package instead?
  // And then filter commits, after that tag?

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

  // Check if PR already exists
  let existingPullRequest = await getExistingPullRequest({
    owner: normalizedOptions.owner,
    repo: normalizedOptions.repo,
    branch: normalizedOptions.branch.release,
    githubToken: normalizedOptions.githubToken,
  });

  let prExists = !!existingPullRequest;
  if (prExists) {
    logger.log("Existing pull request found:", existingPullRequest?.html_url);
  } else {
    logger.log("No existing pull request found, will create new one");
  }

  if (isCleanFlag) {
    logger.log("Clean flag is detected, will re-open pull request branch from default branch");
    prExists = false;
    existingPullRequest = null;
  }

  // If clean, delete and recreate the branch for a fresh start
  const branchExists = await doesBranchExist(normalizedOptions.branch.release, workspaceRoot);
  if (isCleanFlag && branchExists) {
    logger.info("Working directory is clean - deleting and recreating release branch for fresh start");
    await deleteRemoteBranch(normalizedOptions.branch.release, workspaceRoot);
    await deleteLocalBranch(normalizedOptions.branch.release, workspaceRoot, true);
  }

  // Create or ensure release branch exists
  const branchExistsAfterCleanup = await doesBranchExist(normalizedOptions.branch.release, workspaceRoot);
  if (!branchExistsAfterCleanup) {
    logger.log("Creating release branch:", normalizedOptions.branch.release);
    await createBranch(normalizedOptions.branch.release, normalizedOptions.branch.default, workspaceRoot);
  }

  // Checkout release branch
  const hasCheckedOut = await checkoutBranch(normalizedOptions.branch.release, workspaceRoot);
  if (!hasCheckedOut) {
    throw new Error(`Failed to checkout branch: ${normalizedOptions.branch.release}`);
  }

  // Pull latest changes if branch exists remotely (and we didn't just delete it)
  if (!isCleanFlag && branchExists) {
    logger.log("Pulling latest changes from remote");
    const hasPulled = await pullLatestChanges(normalizedOptions.branch.release, workspaceRoot);
    if (!hasPulled) {
      logger.log("Warning: Failed to pull latest changes, continuing anyway");
    }

    // Rebase onto current branch to get latest commits from main
    logger.log("Rebasing release branch onto", normalizedOptions.branch.default);
    await rebaseBranch(normalizedOptions.branch.default, workspaceRoot);
  }

  // Update package.json files
  await updateAllPackageJsonFiles(allUpdates);

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
        prUrl: existingPullRequest?.html_url,
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
