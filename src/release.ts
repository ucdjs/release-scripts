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
  getAvailableBranches,
  getCurrentBranch,
  getDefaultBranch,
  isBranchAheadOfRemote,
  isWorkingDirectoryClean,
  pullLatestChanges,
  pushBranch,
  rebaseBranch,
} from "#core/git";
import {
  generatePullRequestBody,
  getExistingPullRequest,
  upsertPullRequest,
} from "#core/github";
import { discoverWorkspacePackages } from "#core/workspace";
import {
  exitWithError,
  logger,
  normalizeSharedOptions,
} from "#shared/utils";
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

  changelog?: {
    /**
     * Whether to generate or update changelogs
     * @default true
     */
    enabled?: boolean;
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

  if (workspacePackages.length === 0) {
    logger.warn("No packages found to release");
    return null;
  }

  logger.section("📦 Workspace Packages");
  logger.item(`Found ${workspacePackages.length} packages`);

  for (const pkg of workspacePackages) {
    logger.item(`${farver.cyan(pkg.name)} (${farver.bold(pkg.version)})`);
    logger.item(`  ${farver.gray("→")} ${farver.gray(pkg.path)}`);
  }

  logger.emptyLine();

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

  logger.section("🔄 Version Updates");
  logger.item(`Updating ${allUpdates.length} packages (including dependents)`);

  for (const update of allUpdates) {
    logger.item(`${update.package.name}: ${update.currentVersion} → ${update.newVersion}`);
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
  const hasChangesToPush = await prOps.syncChanges(true);

  if (!hasChangesToPush) {
    if (prOps.doesReleasePRExist && prOps.existingPullRequest) {
      logger.item("No updates needed, PR is already up to date");
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
  const { pullRequest, created } = await prOps.syncPullRequest(allUpdates);

  await prOps.cleanup();

  if (pullRequest?.html_url) {
    logger.section("🚀 Pull Request");
    logger.success(`Pull request ${created ? "created" : "updated"}: ${pullRequest.html_url}`);
  }

  return {
    updates: allUpdates,
    prUrl: pullRequest?.html_url,
    created,
  };
}

async function normalizeReleaseOptions(options: ReleaseOptions) {
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
    pullRequest: options.pullRequest,
    changelog: {
      enabled: options.changelog?.enabled ?? true,
    },
  };
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
}) {
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
    logger.item("Found existing release pull request");
  } else {
    logger.item("Will create new pull request");
  }

  const branchExists = await doesBranchExist(releaseBranch, workspaceRoot);

  return {
    existingPullRequest,
    doesReleasePRExist,
    async prepareBranch() {
      if (!branchExists) {
        await createBranch(releaseBranch, defaultBranch, workspaceRoot);
      }

      // The following operations should be done in the correct order!
      // First we will checkout the release branch, then pull the latest changes if it exists remotely,
      // then rebase onto the default branch to get the latest changes from main, and only after that
      // we will apply our updates.
      logger.step(`Checking out release branch: ${releaseBranch}`);
      const hasCheckedOut = await checkoutBranch(releaseBranch, workspaceRoot);
      if (!hasCheckedOut) {
        throw new Error(`Failed to checkout branch: ${releaseBranch}`);
      }

      // If the branch already exists, we will just pull the latest changes.
      // Since the branch could have been updated remotely since we last checked it out.
      if (branchExists) {
        logger.step("Pulling latest changes from remote");
        const hasPulled = await pullLatestChanges(releaseBranch, workspaceRoot);
        if (!hasPulled) {
          logger.warn("Failed to pull latest changes, continuing anyway");
        }
      }

      // After we have pulled the latest changes, we will rebase our changes onto the default branch
      // to ensure we have the latest updates.
      logger.step(`Rebasing onto ${defaultBranch}`);
      const rebased = await rebaseBranch(defaultBranch, workspaceRoot);
      if (!rebased) {
        throw new Error(`Failed to rebase onto ${defaultBranch}. Please resolve conflicts manually.`);
      }
    },
    async syncChanges(hasChanges: boolean) {
      // If there are any changes, we will commit them.
      const hasCommitted = hasChanges ? await commitChanges("chore: update release versions", workspaceRoot) : false;

      // Check if branch is ahead of remote (has commits to push)
      const isBranchAhead = await isBranchAheadOfRemote(releaseBranch, workspaceRoot);

      if (!hasCommitted && !isBranchAhead) {
        logger.item("No changes to commit and branch is in sync with remote");
        await checkoutBranch(defaultBranch, workspaceRoot);
        return false;
      }

      // Push with --force-with-lease for safety
      logger.step("Pushing changes to remote");
      const pushed = await pushBranch(releaseBranch, workspaceRoot, { forceWithLease: true });
      if (!pushed) {
        throw new Error(`Failed to push changes to ${releaseBranch}. Remote may have been updated.`);
      }

      return true;
    },
    async syncPullRequest(updates: PackageRelease[]) {
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

      logger.success(`${doesReleasePRExist ? "Updated" : "Created"} pull request: ${pullRequest?.html_url}`);

      return {
        pullRequest,
        created: !doesReleasePRExist,
      };
    },
    async cleanup() {
      await checkoutBranch(defaultBranch, workspaceRoot);
    },
  };
}
