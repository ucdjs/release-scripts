import type { GitHubPullRequest } from "#core/github";
import type {
  GlobalCommitMode,
  PackageRelease,
  SharedOptions,
} from "#shared/types";
import {
  checkoutBranch,
  commitChanges,
  createBranch,
  doesBranchExist,
  getCurrentBranch,
  isBranchAheadOfRemote,
  isWorkingDirectoryClean,
  pullLatestChanges,
  pushBranch,
  rebaseBranch,
} from "#core/git";
import { generatePullRequestBody, getExistingPullRequest, upsertPullRequest } from "#core/github";
import { discoverWorkspacePackages } from "#core/workspace";
import { exitWithError, logger, normalizeReleaseOptions } from "#shared/utils";
import {
  getGlobalCommitsPerPackage,
  getWorkspacePackageCommits,
} from "#versioning/commits";
import { calculateAndPrepareVersionUpdates } from "#versioning/version";
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

  // Calculate version updates and prepare apply function
  const { allUpdates, applyUpdates } = await calculateAndPrepareVersionUpdates({
    workspacePackages,
    packageCommits,
    workspaceRoot,
    showPrompt: options.prompts?.versions !== false,
    globalCommitsPerPackage,
  });

  if (allUpdates.filter((u) => u.hasDirectChanges).length === 0) {
    logger.warn("No packages have changes requiring a release");
  }

  logger.log(`Total packages to update (including dependents): ${allUpdates.length}`);
  for (const update of allUpdates) {
    logger.log(`- ${update.package.name}: ${farver.dim(update.currentVersion)} -> ${farver.bold(update.newVersion)}`);
  }

  // Orchestrate git and pull request workflow
  const prOps = await orchestrateReleasePullRequest({
    workspaceRoot,
    owner: normalizedOptions.owner,
    repo: normalizedOptions.repo,
    githubToken: normalizedOptions.githubToken,
    releaseBranch: normalizedOptions.branch.release,
    defaultBranch: normalizedOptions.branch.default,
    pullRequestTitle: options.pullRequest?.title,
    pullRequestBody: options.pullRequest?.body,
  });

  // Prepare the release branch
  await prOps.prepareBranch();

  // Apply version updates to package.json files
  await applyUpdates();

  // Commit and push changes
  const hasChangesToPush = await prOps.commitAndPush(true);

  if (!hasChangesToPush) {
    if (prOps.doesReleasePRExist && prOps.existingPullRequest) {
      logger.log("No updates needed, PR is already up to date");
      return {
        updates: allUpdates,
        prUrl: prOps.existingPullRequest.html_url,
        created: false,
      };
    } else {
      logger.error("No changes to commit, and no existing PR. Nothing to do.");
      return null;
    }
  }

  // Create or update PR
  const { pullRequest, created } = await prOps.createOrUpdatePullRequest(allUpdates);

  await prOps.checkoutDefaultBranch();

  if (pullRequest?.html_url) {
    logger.info();
    logger.info(`${farver.green("✓")} Pull request ${created ? "created" : "updated"}: ${farver.cyan(pullRequest.html_url)}`);
  }

  return {
    updates: allUpdates,
    prUrl: pullRequest?.html_url,
    created,
  };
}

interface OrchestrateReleasePullRequestResult {
  existingPullRequest: GitHubPullRequest | null;
  doesReleasePRExist: boolean;
  prepareBranch: () => Promise<void>;
  commitAndPush: (hasChanges: boolean) => Promise<boolean>;
  createOrUpdatePullRequest: (updates: PackageRelease[]) => Promise<{
    pullRequest: GitHubPullRequest | null;
    created: boolean;
  }>;
  checkoutDefaultBranch: () => Promise<void>;
}

async function orchestrateReleasePullRequest({
  workspaceRoot,
  owner,
  repo,
  githubToken,
  releaseBranch,
  defaultBranch,
  pullRequestTitle,
  pullRequestBody,
}: {
  workspaceRoot: string;
  owner: string;
  repo: string;
  githubToken: string;
  releaseBranch: string;
  defaultBranch: string;
  pullRequestTitle?: string;
  pullRequestBody?: string;
}): Promise<OrchestrateReleasePullRequestResult> {
  const currentBranch = await getCurrentBranch(workspaceRoot);

  if (currentBranch !== defaultBranch) {
    exitWithError(
      `Current branch is '${currentBranch}'. Please switch to the default branch '${defaultBranch}' before proceeding.`,
      `git checkout ${defaultBranch}`,
    );
  }

  const existingPullRequest = await getExistingPullRequest({
    owner,
    repo,
    branch: releaseBranch,
    githubToken,
  });

  const doesReleasePRExist = !!existingPullRequest;

  if (doesReleasePRExist) {
    logger.log("An existing release pull request was found.");
  } else {
    logger.log("No existing pull request found, will create new one");
  }

  const branchExists = await doesBranchExist(releaseBranch, workspaceRoot);

  return {
    existingPullRequest,
    doesReleasePRExist,
    prepareBranch: async () => {
      if (!branchExists) {
        await createBranch(releaseBranch, defaultBranch, workspaceRoot);
      }

      // The following operations should be done in the correct order!
      // First we will checkout the release branch, then pull the latest changes if it exists remotely,
      // then rebase onto the default branch to get the latest changes from main, and only after that
      // we will apply our updates.
      logger.log(`Checking out release branch: ${releaseBranch}`);
      const hasCheckedOut = await checkoutBranch(releaseBranch, workspaceRoot);
      if (!hasCheckedOut) {
        throw new Error(`Failed to checkout branch: ${releaseBranch}`);
      }

      // If the branch already exists, we will just pull the latest changes.
      // Since the branch could have been updated remotely since we last checked it out.
      if (branchExists) {
        logger.log("Pulling latest changes from remote");
        const hasPulled = await pullLatestChanges(releaseBranch, workspaceRoot);
        if (!hasPulled) {
          logger.log("Warning: Failed to pull latest changes, continuing anyway");
        }
      }

      // After we have pulled the latest changes, we will rebase our changes onto the default branch
      // to ensure we have the latest updates.
      logger.log("Rebasing release branch onto", defaultBranch);
      await rebaseBranch(defaultBranch, workspaceRoot);
    },
    commitAndPush: async (hasChanges) => {
      // If there are any changes, we will commit them.
      const hasCommitted = hasChanges ? await commitChanges("chore: update release versions", workspaceRoot) : false;

      // Check if branch is ahead of remote (has commits to push)
      const isBranchAhead = await isBranchAheadOfRemote(releaseBranch, workspaceRoot);

      if (!hasCommitted && !isBranchAhead) {
        logger.log("No changes to commit and branch is in sync with remote");
        await checkoutBranch(defaultBranch, workspaceRoot);
        return false;
      }

      // Push with --force-with-lease for safety
      logger.log("Pushing changes to remote");
      await pushBranch(releaseBranch, workspaceRoot, { forceWithLease: true });

      return true;
    },
    createOrUpdatePullRequest: async (updates) => {
      const prTitle = existingPullRequest?.title || pullRequestTitle || "chore: update package versions";
      const prBody = pullRequestBody || generatePullRequestBody(updates);

      const pullRequest = await upsertPullRequest({
        owner,
        repo,
        pullNumber: existingPullRequest?.number,
        title: prTitle,
        body: prBody,
        head: releaseBranch,
        base: defaultBranch,
        githubToken,
      });

      logger.log(doesReleasePRExist ? "Updated pull request:" : "Created pull request:", pullRequest?.html_url);

      return {
        pullRequest,
        created: !doesReleasePRExist,
      };
    },
    checkoutDefaultBranch: async () => {
      await checkoutBranch(defaultBranch, workspaceRoot);
    },
  };
}
