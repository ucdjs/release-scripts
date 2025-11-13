import type {
  FindWorkspacePackagesOptions,
  GlobalCommitMode,
  PackageRelease,
  SharedOptions,
} from "#shared/types";
import process from "node:process";
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
} from "#core/git";
import { generatePullRequestBody, getExistingPullRequest, upsertPullRequest } from "#core/github";
import { discoverWorkspacePackages } from "#core/workspace";
import { exitWithError, logger, normalizeReleaseOptions, normalizeSharedOptions } from "#shared/utils";
import {
  getGlobalCommitsPerPackage,
  getWorkspacePackageCommits,
} from "#versioning/commits";
import {
  buildPackageDependencyGraph,
  createDependentUpdates,
  updateAllPackageJsonFiles,
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

  // Get commits affecting each package (each package uses its own last tag)
  const packageCommits = await getWorkspacePackageCommits(workspaceRoot, workspacePackages);

  // Get global commits per-package based on each package's own timeline
  // This correctly handles packages with different release histories
  const globalCommitsPerPackage = await getGlobalCommitsPerPackage(
    workspaceRoot,
    packageCommits,
    workspacePackages,
    normalizedOptions.globalCommitMode,
  );

  const versionUpdates = await inferVersionUpdates({
    workspacePackages,
    packageCommits,
    workspaceRoot,
    showPrompt: options.prompts?.versions !== false,
    globalCommitsPerPackage,
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
  }

  const branchExists = await doesBranchExist(normalizedOptions.branch.release, workspaceRoot);

  if (!branchExists) {
    await createBranch(
      normalizedOptions.branch.release,
      normalizedOptions.branch.default,
      workspaceRoot,
    );
  }

  // The following operations should be done in the correct order!
  // First we will checkout the release branch, then pull the latest changes if it exists remotely,
  // then rebase onto the default branch to get the latest changes from main, and only after that
  // we will apply our updates.

  logger.log(`Checking out release branch: ${normalizedOptions.branch.release}`);
  const hasCheckedOut = await checkoutBranch(normalizedOptions.branch.release, workspaceRoot);
  if (!hasCheckedOut) {
    throw new Error(`Failed to checkout branch: ${normalizedOptions.branch.release}`);
  }

  // If the branch already exists, we will just pull the latest changes.
  // Since the branch could have been updated remotely since we last checked it out.
  if (branchExists) {
    logger.log("Pulling latest changes from remote");
    const hasPulled = await pullLatestChanges(normalizedOptions.branch.release, workspaceRoot);
    if (!hasPulled) {
      logger.log("Warning: Failed to pull latest changes, continuing anyway");
    }
  }

  // After we have pulled the latest changes, we will rebase our changes onto the default branch
  // to ensure we have the latest updates.
  logger.log("Rebasing release branch onto", normalizedOptions.branch.default);
  await rebaseBranch(normalizedOptions.branch.default, workspaceRoot);

  // TODO: Make this more robust by checking if any files were actually changed.
  // For example, if there is no actual version change, there is no reason to update the files.
  await updateAllPackageJsonFiles(allUpdates);

  // If there are any changes, we will commit them.
  const hasCommitted = await commitChanges("chore: update release versions", workspaceRoot);

  // Check if branch is ahead of remote (has commits to push)
  const isBranchAhead = await isBranchAheadOfRemote(normalizedOptions.branch.release, workspaceRoot);

  if (!hasCommitted && !isBranchAhead) {
    logger.log("No changes to commit and branch is in sync with remote");
    await checkoutBranch(normalizedOptions.branch.default, workspaceRoot);

    if (doesReleasePRExist) {
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

  logger.log(doesReleasePRExist ? "Updated pull request:" : "Created pull request:", pullRequest?.html_url);

  await checkoutBranch(normalizedOptions.branch.default, workspaceRoot);

  if (pullRequest?.html_url) {
    logger.info();
    logger.info(`${farver.green("✓")} Pull request ${doesReleasePRExist ? "updated" : "created"}: ${farver.cyan(pullRequest.html_url)}`);
  }

  return {
    updates: allUpdates,
    prUrl: pullRequest?.html_url,
    created: !doesReleasePRExist,
  };
}
