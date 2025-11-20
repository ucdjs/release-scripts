import type { GitHubClient } from "#core/github";
import type {
  GlobalCommitMode,
  PackageRelease,
  SharedOptions,
} from "#shared/types";
import type { VersionOverrides } from "#versioning/version";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { updateChangelog } from "#core/changelog";
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
import {
  createGitHubClient,
  generatePullRequestBody,
} from "#core/github";
import { discoverWorkspacePackages } from "#core/workspace";
import { normalizeReleaseOptions } from "#shared/options";
import {
  exitWithError,
  logger,
} from "#shared/utils";
import {
  getGlobalCommitsPerPackage,
  getWorkspacePackageGroupedCommits,
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

    /**
     * Custom changelog entry template (ETA format)
     */
    template?: string;
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

  // Get all commits grouped by their package.
  // Each package's commits are determined based on its own release history.
  // So, for example, if package A was last released at v1.2.0 and package B at v2.0.0,
  // we will get all commits since v1.2.0 for package A, and all commits since v2.0.0 for package B.
  const groupedPackageCommits = await getWorkspacePackageGroupedCommits(workspaceRoot, workspacePackages);

  // Get global commits per-package based on each package's own timeline
  const globalCommitsPerPackage = await getGlobalCommitsPerPackage(
    workspaceRoot,
    groupedPackageCommits,
    workspacePackages,
    normalizedOptions.globalCommitMode,
  );

  const githubClient = createGitHubClient({
    owner: normalizedOptions.owner,
    repo: normalizedOptions.repo,
    githubToken: normalizedOptions.githubToken,
  });

  const prOps = await orchestrateReleasePullRequest({
    workspaceRoot,
    githubClient,
    releaseBranch: normalizedOptions.branch.release,
    defaultBranch: normalizedOptions.branch.default,
    pullRequestTitle: options.pullRequest?.title,
    pullRequestBody: options.pullRequest?.body,
  });

  // Prepare the release branch (checkout, rebase, etc.)
  await prOps.prepareBranch();

  const overridesPath = join(workspaceRoot, ".github", "ucdjs.release.overrides.json");
  let existingOverrides: VersionOverrides = {};
  try {
    const overridesContent = await readFile(overridesPath, "utf-8");
    existingOverrides = JSON.parse(overridesContent);
    logger.info("Found existing version overrides file.");
  } catch {
    logger.info("No existing version overrides file found. Continuing...");
  }

  // Calculate version updates and prepare apply function
  const { allUpdates, applyUpdates, overrides: newOverrides } = await calculateAndPrepareVersionUpdates({
    workspacePackages,
    packageCommits: groupedPackageCommits,
    workspaceRoot,
    showPrompt: options.prompts?.versions !== false,
    globalCommitsPerPackage,
    overrides: existingOverrides,
  });

  if (Object.keys(newOverrides).length > 0) {
    logger.info("Writing version overrides file...");
    try {
      await mkdir(join(workspaceRoot, ".github"), { recursive: true });
      await writeFile(overridesPath, JSON.stringify(newOverrides, null, 2), "utf-8");
      logger.success("Successfully wrote version overrides file.");
    } catch (e) {
      logger.error("Failed to write version overrides file:", e);
    }
  }

  if (allUpdates.filter((u) => u.hasDirectChanges).length === 0) {
    logger.warn("No packages have changes requiring a release");
  }

  logger.section("🔄 Version Updates");
  logger.item(`Updating ${allUpdates.length} packages (including dependents)`);

  for (const update of allUpdates) {
    logger.item(`${update.package.name}: ${update.currentVersion} → ${update.newVersion}`);
  }

  // Prepare the release branch
  await prOps.prepareBranch();

  // Apply version updates to package.json files
  await applyUpdates();

  // If the changelog option is enabled, update changelogs
  if (normalizedOptions.changelog.enabled) {
    logger.step("Updating changelogs");

    const changelogPromises = allUpdates.map((update) => {
      const pkgCommits = groupedPackageCommits.get(update.package.name) || [];

      const globalCommits = globalCommitsPerPackage.get(update.package.name) || [];
      const allCommits = [...pkgCommits, ...globalCommits];

      if (allCommits.length === 0) {
        logger.verbose(`No commits for ${update.package.name}, skipping changelog`);
        return Promise.resolve();
      }

      logger.verbose(`Updating changelog for ${farver.cyan(update.package.name)}`);

      return updateChangelog({
        normalizedOptions: {
          ...normalizedOptions,
          workspaceRoot,
        },
        githubClient,
        workspacePackage: update.package,
        version: update.newVersion,
        previousVersion: update.currentVersion !== "0.0.0" ? update.currentVersion : undefined,
        commits: allCommits,
        date: new Date().toISOString().split("T")[0]!,
      });
    }).filter((p): p is Promise<void> => p != null);

    const updates = await Promise.all(changelogPromises);

    logger.success(`Updated ${updates.length} changelog(s)`);
  }

  // Commit and push changes
  const hasChangesToPush = await prOps.syncChanges(true);

  if (!hasChangesToPush) {
    if (prOps.doesReleasePRExist && prOps.existingPullRequest) {
      logger.item("No updates needed, PR is already up to date");

      const { pullRequest, created } = await prOps.syncPullRequest(allUpdates);

      await prOps.cleanup();

      return {
        updates: allUpdates,
        prUrl: pullRequest?.html_url,
        created,
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

async function orchestrateReleasePullRequest({
  workspaceRoot,
  githubClient,
  releaseBranch,
  defaultBranch,
  pullRequestTitle,
  pullRequestBody,
}: {
  workspaceRoot: string;
  githubClient: GitHubClient;
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

  const existingPullRequest = await githubClient.getExistingPullRequest(releaseBranch);

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
      const prBody = generatePullRequestBody(updates, pullRequestBody);

      const pullRequest = await githubClient.upsertPullRequest({
        pullNumber: existingPullRequest?.number,
        title: prTitle,
        body: prBody,
        head: releaseBranch,
        base: defaultBranch,
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
