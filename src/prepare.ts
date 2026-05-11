import { join } from "node:path";

import { Effect, FileSystem } from "effect";
import farver from "farver";
import semver from "semver";
import { ReleaseOptions } from "./options";
import { ChangelogService } from "./services/changelog";
import { GitError, GitService } from "./services/git";
import {
  type WorkspaceError,
  type WorkspacePackage,
  WorkspaceService,
} from "./services/workspace";
import { type GitHubError, generatePullRequestBody, GitHubService } from "./services/github";
import type { BumpKind, PackageRelease } from "./types";
import { exitWithError, formatUnknownError, logger, runEffect, ucdjsReleaseOverridesPath } from "./errors";
import {
  getGlobalCommitsPerPackage,
  getPackageCommitsSinceTag,
  getWorkspacePackageGroupedCommits,
} from "./commits";
import { calculateUpdates, ensureHasPackages } from "./packages";

interface PrepareReleaseBranchOptions {
  workspaceRoot: string;
  releaseBranch: string;
  defaultBranch: string;
}

export const prepareReleaseBranch = Effect.fn("prepareReleaseBranch")(function* (
  options: PrepareReleaseBranchOptions,
) {
  const git = yield* GitService;
  const { workspaceRoot, releaseBranch, defaultBranch } = options;
  const currentBranch = yield* git.getCurrentBranch(workspaceRoot);

  if (currentBranch !== defaultBranch) {
    return yield* Effect.fail(new GitError({
      operation: "validateBranch",
      message: `Current branch is '${currentBranch}'. Please switch to '${defaultBranch}'.`,
    }));
  }

  const branchExists = yield* git.doesBranchExist(releaseBranch, workspaceRoot);
  if (!branchExists) {
    yield* git.createBranch(releaseBranch, defaultBranch, workspaceRoot);
  }

  yield* git.checkoutBranch(releaseBranch, workspaceRoot);

  if (branchExists) {
    const remoteExists = yield* git.doesRemoteBranchExist(releaseBranch, workspaceRoot);
    if (remoteExists) {
      const pulled = yield* git.pullLatestChanges(releaseBranch, workspaceRoot);
      if (!pulled) {
        logger.warn("Failed to pull latest changes, continuing anyway.");
      }
    } else {
      logger.info(`Remote branch "origin/${releaseBranch}" does not exist yet, skipping pull.`);
    }
  }

  yield* git.rebaseBranch(defaultBranch, workspaceRoot);
});

interface SyncChangesOptions {
  workspaceRoot: string;
  releaseBranch: string;
  commitMessage: string;
  hasChanges: boolean;
  additionalPaths?: string[];
}

const syncReleaseChanges = Effect.fn("syncReleaseChanges")(function* (options: SyncChangesOptions) {
  const git = yield* GitService;
  const { workspaceRoot, releaseBranch, commitMessage, hasChanges, additionalPaths } = options;

  if (additionalPaths && additionalPaths.length > 0) {
    try {
      yield* runEffect("git", ["add", "--", ...additionalPaths], {
        nodeOptions: { cwd: workspaceRoot, stdio: "pipe" },
      });
    } catch (error) {
      logger.verbose(`Failed to stage additional paths: ${String(error)}`);
    }
  }

  const committed = hasChanges ? yield* git.commitChanges(commitMessage, workspaceRoot) : false;
  const isAhead = yield* git.isBranchAheadOfRemote(releaseBranch, workspaceRoot);

  if (!committed && !isAhead) {
    return false;
  }

  yield* git.pushBranch(releaseBranch, workspaceRoot, { forceWithLease: true });
  return true;
});

interface SyncPullRequestOptions {
  releaseBranch: string;
  defaultBranch: string;
  pullRequestTitle?: string;
  pullRequestBody?: string;
  updates: PackageRelease[];
}

export const syncPullRequest = Effect.fn("syncPullRequest")(function* (
  options: SyncPullRequestOptions,
) {
  const github = yield* GitHubService;
  const { releaseBranch, defaultBranch, pullRequestTitle, pullRequestBody, updates } = options;
  const existing = yield* github.getExistingPullRequest(releaseBranch);
  const title = existing?.title || pullRequestTitle || "chore: update package versions";
  const body = generatePullRequestBody(updates, pullRequestBody);
  const pullRequest = yield* github.upsertPullRequest({
    pullNumber: existing?.number,
    title,
    body,
    head: releaseBranch,
    base: defaultBranch,
  });

  return {
    pullRequest,
    created: !existing,
  };
});

export const prepareWorkflow = Effect.fn("prepareWorkflow")(function* () {
  const options = yield* ReleaseOptions;
  const changelog = yield* ChangelogService;
  const fs = yield* FileSystem.FileSystem;
  const git = yield* GitService;
  const workspace = yield* WorkspaceService;
  if (options.safeguards) {
    const clean = yield* Effect.catchTag(
      git.isWorkingDirectoryClean(options.workspaceRoot) as Effect.Effect<boolean, GitError, unknown>,
      "GitError",
      (error) =>
        Effect.sync(() =>
          exitWithError(
            "Failed to verify working directory state.",
            "Ensure this is a valid git repository and try again.",
            error,
          )
        ),
    );

    if (!clean) {
      exitWithError(
        "Working directory is not clean. Please commit or stash your changes before proceeding.",
      );
    }
  }

  const discovered = yield* Effect.catchTag(
    workspace.discoverWorkspacePackages(options.workspaceRoot, options) as Effect.Effect<
      WorkspacePackage[],
      WorkspaceError,
      unknown
    >,
    "WorkspaceError",
    (error) =>
      Effect.sync(() => exitWithError("Failed to discover packages.", undefined, error)),
  );

  const workspacePackages = ensureHasPackages(discovered);
  if (workspacePackages === null) {
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

  yield* Effect.catchTag(prepareReleaseBranch({
    workspaceRoot: options.workspaceRoot,
    releaseBranch: options.branch.release,
    defaultBranch: options.branch.default,
  }) as Effect.Effect<void, GitError, unknown>, "GitError", (error) =>
      Effect.sync(() => exitWithError("Failed to prepare release branch.", undefined, error)),
    );

  const overridesPath = join(options.workspaceRoot, ucdjsReleaseOverridesPath);
  let existingOverrides: Record<
    string,
    { version: string; type: BumpKind }
  > = {};
  try {
    const overridesContent = yield* fs.readFileString(overridesPath);
    existingOverrides = JSON.parse(overridesContent);
    logger.info("Found existing version overrides file.");
  } catch (error) {
    logger.info("No existing version overrides file found. Continuing...");
    logger.verbose(`Reading overrides file failed: ${formatUnknownError(error).message}`);
  }

  if (Object.keys(existingOverrides).length > 0) {
    const packageNames = new Set(workspacePackages.map((p: typeof workspacePackages[number]) => p.name));
    const staleEntries: string[] = [];

    for (const [pkgName, override] of Object.entries(existingOverrides)) {
      if (!packageNames.has(pkgName)) {
        staleEntries.push(pkgName);
        delete existingOverrides[pkgName];
        continue;
      }

      const pkg = workspacePackages.find((p: typeof workspacePackages[number]) => p.name === pkgName);
      if (pkg && semver.valid(override.version) && semver.gte(pkg.version, override.version)) {
        staleEntries.push(pkgName);
        delete existingOverrides[pkgName];
      }
    }

    if (staleEntries.length > 0) {
      logger.info(`Removed ${staleEntries.length} stale override(s): ${staleEntries.join(", ")}`);
    }
  }

  const updates = yield* Effect.catchTag(calculateUpdates({
    workspacePackages,
    workspaceRoot: options.workspaceRoot,
    showPrompt: options.prompts?.versions !== false,
    globalCommitMode: options.globalCommitMode === "none" ? false : options.globalCommitMode,
    overrides: existingOverrides,
  }) as Effect.Effect<any, GitError, unknown>, "GitError", (error) =>
      Effect.sync(() => exitWithError("Failed to calculate package updates.", undefined, error)),
    );

  const { allUpdates, applyUpdates, overrides: newOverrides } = updates;
  const hasOverrideChanges = JSON.stringify(existingOverrides) !== JSON.stringify(newOverrides);

  if (Object.keys(newOverrides).length > 0 && hasOverrideChanges) {
    logger.step("Writing version overrides file...");
    try {
      yield* fs.makeDirectory(join(options.workspaceRoot, ".github"), { recursive: true });
      yield* fs.writeFileString(overridesPath, JSON.stringify(newOverrides, null, 2));
      logger.success("Successfully wrote version overrides file.");
    } catch (e) {
      logger.error("Failed to write version overrides file:", e);
    }
  } else if (Object.keys(newOverrides).length > 0) {
    logger.step("Version overrides unchanged. Skipping write.");
  }

  if (Object.keys(newOverrides).length === 0 && hasOverrideChanges) {
    logger.info("Removing obsolete version overrides file...");
    try {
      yield* fs.remove(overridesPath);
      logger.success("Successfully removed obsolete version overrides file.");
    } catch (e) {
      const formatted = formatUnknownError(e);
      if (formatted.code !== "ENOENT") {
        logger.error("Failed to remove obsolete version overrides file:", e);
      }
    }
  }

  if (allUpdates.filter((u: PackageRelease) => u.hasDirectChanges).length === 0) {
    logger.warn("No packages have changes requiring a release");
  }

  logger.section("🔄 Version Updates");
  logger.item(`Updating ${allUpdates.length} packages (including dependents)`);

  for (const update of allUpdates) {
    const isAsIs = update.changeKind === "as-is";
    const suffix = isAsIs ? farver.dim(" (as-is)") : "";
    logger.item(`${update.package.name}: ${update.currentVersion} → ${update.newVersion}${suffix}`);
  }

  yield* applyUpdates();

  if (options.changelog?.enabled) {
    logger.step("Updating changelogs");

    const groupedPackageCommits = yield* getWorkspacePackageGroupedCommits(
      options.workspaceRoot,
      workspacePackages,
    );
    const globalCommitsPerPackage = yield* getGlobalCommitsPerPackage(
      options.workspaceRoot,
      groupedPackageCommits,
      workspacePackages,
      options.globalCommitMode === "none" ? false : options.globalCommitMode,
    );

    const changelogUpdates = allUpdates.filter(
      (update: PackageRelease) => update.currentVersion !== update.newVersion,
    );

    const updatePackageChangelog = Effect.fn("updatePackageChangelog")(function* (
      update: PackageRelease,
    ) {
      let pkgCommits = groupedPackageCommits.get(update.package.name) || [];
      let globalCommits = globalCommitsPerPackage.get(update.package.name) || [];
      let previousVersionForChangelog: string | undefined =
        update.currentVersion !== "0.0.0" ? update.currentVersion : undefined;

      const shouldCombinePrereleaseIntoStable =
        options.changelog.combinePrereleaseIntoFirstStable &&
        semver.prerelease(update.currentVersion) != null &&
        semver.prerelease(update.newVersion) == null;

      if (shouldCombinePrereleaseIntoStable) {
        const stableTag = yield* Effect.catchTag(
          git.getMostRecentPackageStableTag(
          options.workspaceRoot,
          update.package.name,
        ) as Effect.Effect<string | undefined, GitError, unknown>,
          "GitError",
          (error) =>
            Effect.sync(() => {
              logger.warn(
                `Failed to resolve stable tag for ${update.package.name}: ${formatUnknownError(error).message}`,
              );
              return undefined;
            })
        );
        if (stableTag) {
          logger.verbose(
            `Combining prerelease changelog entries into stable release for ${update.package.name} using base tag ${stableTag}`,
          );

          const stableBaseCommits = yield* getPackageCommitsSinceTag(
            options.workspaceRoot,
            update.package,
            stableTag,
          );

          pkgCommits = stableBaseCommits;

          const stableBaseGlobals = yield* getGlobalCommitsPerPackage(
            options.workspaceRoot,
            new Map([[update.package.name, stableBaseCommits]]),
            workspacePackages,
            options.globalCommitMode === "none" ? false : options.globalCommitMode,
          );

          globalCommits = stableBaseGlobals.get(update.package.name) || [];

          const atIndex = stableTag.lastIndexOf("@");
          if (atIndex !== -1) {
            previousVersionForChangelog = stableTag.slice(atIndex + 1);
          }
        }
      }

      const allCommits = [...pkgCommits, ...globalCommits];

      if (allCommits.length === 0) {
        logger.verbose(
          `No commits for ${update.package.name}, writing changelog entry with no-significant-commits note`,
        );
      }

      logger.verbose(`Updating changelog for ${farver.cyan(update.package.name)}`);

      yield* changelog.updateChangelog({
        normalizedOptions: {
          ...options,
          workspaceRoot: options.workspaceRoot,
        },
        workspacePackage: update.package,
        version: update.newVersion,
        previousVersion: previousVersionForChangelog,
        commits: allCommits,
        date: new Date().toISOString().split("T")[0]!,
      });
    });

    const changelogEffects = changelogUpdates.map(updatePackageChangelog);

    const updates = yield* Effect.all(changelogEffects);
    logger.success(`Updated ${updates.length} changelog(s)`);
  }

  const hasChangesToPush = yield* Effect.catchTag(syncReleaseChanges({
    workspaceRoot: options.workspaceRoot,
    releaseBranch: options.branch.release,
    commitMessage: "chore: update release versions",
    hasChanges: true,
    // The overrides file may be a new untracked file that git add -u would miss.
    // Explicitly include it so it gets committed alongside the version bumps.
    additionalPaths: [overridesPath],
  }) as Effect.Effect<boolean, GitError, unknown>, "GitError", (error) =>
      Effect.sync(() => exitWithError("Failed to sync release changes.", undefined, error)),
    );

  if (!hasChangesToPush) {
    // When there are no updates at all, the release branch is identical to the
      // default branch.  Attempting to create/update a PR would fail with a 422
      // ("No commits between main and <release-branch>"), so bail out early.
    if (allUpdates.length === 0) {
      logger.info("No changes to commit and no packages to release. Nothing to do.");
      yield* Effect.catchTag(
        git.checkoutBranch(options.branch.default, options.workspaceRoot) as Effect.Effect<boolean, GitError, unknown>,
        "GitError",
        (error) =>
          Effect.sync(() =>
            exitWithError(`Failed to checkout branch: ${options.branch.default}`, undefined, error)
          ),
      );
      return null;
    }

    const prResult = yield* Effect.catchTag(syncPullRequest({
      releaseBranch: options.branch.release,
      defaultBranch: options.branch.default,
      pullRequestTitle: options.pullRequest?.title,
      pullRequestBody: options.pullRequest?.body,
      updates: allUpdates,
    }) as Effect.Effect<any, GitHubError, unknown>, "GitHubError", (error) =>
        Effect.sync(() => exitWithError("Failed to sync release pull request.", undefined, error)),
      );

    if (prResult.pullRequest) {
      logger.item("No updates needed, PR is already up to date");
      yield* Effect.catchTag(
        git.checkoutBranch(options.branch.default, options.workspaceRoot) as Effect.Effect<boolean, GitError, unknown>,
        "GitError",
        (error) =>
          Effect.sync(() =>
            exitWithError(`Failed to checkout branch: ${options.branch.default}`, undefined, error)
          ),
      );

      return {
        updates: allUpdates,
        prUrl: prResult.pullRequest.html_url,
        created: prResult.created,
      };
    }

    logger.error("No changes to commit, and no existing PR. Nothing to do.");
    return null;
  }

  const prResult = yield* Effect.catchTag(syncPullRequest({
    releaseBranch: options.branch.release,
    defaultBranch: options.branch.default,
    pullRequestTitle: options.pullRequest?.title,
    pullRequestBody: options.pullRequest?.body,
    updates: allUpdates,
  }) as Effect.Effect<any, GitHubError, unknown>, "GitHubError", (error) =>
      Effect.sync(() => exitWithError("Failed to sync release pull request.", undefined, error)),
    );

  if (prResult.pullRequest?.html_url) {
    logger.section("🚀 Pull Request");
    logger.success(
      `Pull request ${prResult.created ? "created" : "updated"}: ${prResult.pullRequest.html_url}`,
    );
  }

  const returnToDefault = yield* Effect.catchTag(
    git.checkoutBranch(options.branch.default, options.workspaceRoot) as Effect.Effect<boolean, GitError, unknown>,
    "GitError",
    (error) =>
      Effect.sync(() =>
        exitWithError(`Failed to checkout branch: ${options.branch.default}`, undefined, error)
      ),
  );

  if (!returnToDefault) {
    exitWithError(`Failed to checkout branch: ${options.branch.default}`);
  }

  return {
    updates: allUpdates,
    prUrl: prResult.pullRequest?.html_url,
    created: prResult.created,
  };
});
