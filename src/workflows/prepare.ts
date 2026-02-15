import type { ReleaseResult } from "#types";
import type { NormalizedReleaseScriptsOptions } from "../options";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { updateChangelog } from "#core/changelog";
import {
  checkoutBranch,
  getMostRecentPackageStableTag,
  isWorkingDirectoryClean,
} from "#core/git";
import { discoverWorkspacePackages } from "#core/workspace";
import { prepareReleaseBranch, syncReleaseChanges } from "#operations/branch";
import { calculateUpdates, ensureHasPackages } from "#operations/calculate";
import { syncPullRequest } from "#operations/pr";
import { exitWithError, formatUnknownError } from "#shared/errors";
import { logger, ucdjsReleaseOverridesPath } from "#shared/utils";
import { getGlobalCommitsPerPackage, getPackageCommitsSinceTag, getWorkspacePackageGroupedCommits } from "#versioning/commits";
import farver from "farver";
import semver, { compare } from "semver";

export async function prepareWorkflow(options: NormalizedReleaseScriptsOptions): Promise<ReleaseResult | null> {
  if (options.safeguards) {
    const clean = await isWorkingDirectoryClean(options.workspaceRoot);
    if (!clean.ok) {
      exitWithError(
        "Failed to verify working directory state.",
        "Ensure this is a valid git repository and try again.",
        clean.error,
      );
    }

    if (!clean.value) {
      exitWithError("Working directory is not clean. Please commit or stash your changes before proceeding.");
    }
  }

  const discovered = await discoverWorkspacePackages(options.workspaceRoot, options);
  if (!discovered.ok) {
    exitWithError("Failed to discover packages.", undefined, discovered.error);
  }

  const ensured = ensureHasPackages(discovered.value);
  if (!ensured.ok) {
    logger.warn(ensured.error.message);
    return null;
  }

  const workspacePackages = ensured.value;

  logger.section("📦 Workspace Packages");
  logger.item(`Found ${workspacePackages.length} packages`);

  for (const pkg of workspacePackages) {
    logger.item(`${farver.cyan(pkg.name)} (${farver.bold(pkg.version)})`);
    logger.item(`  ${farver.gray("→")} ${farver.gray(pkg.path)}`);
  }

  logger.emptyLine();

  const prepareBranchResult = await prepareReleaseBranch({
    workspaceRoot: options.workspaceRoot,
    releaseBranch: options.branch.release,
    defaultBranch: options.branch.default,
  });

  if (!prepareBranchResult.ok) {
    exitWithError("Failed to prepare release branch.", undefined, prepareBranchResult.error);
  }

  const overridesPath = join(options.workspaceRoot, ucdjsReleaseOverridesPath);
  let existingOverrides: Record<string, { version: string; type: import("#shared/types").BumpKind }> = {};
  try {
    const overridesContent = await readFile(overridesPath, "utf-8");
    existingOverrides = JSON.parse(overridesContent);
    logger.info("Found existing version overrides file.");
  } catch (error) {
    logger.info("No existing version overrides file found. Continuing...");
    logger.verbose(`Reading overrides file failed: ${formatUnknownError(error).message}`);
  }

  const updatesResult = await calculateUpdates({
    workspacePackages,
    workspaceRoot: options.workspaceRoot,
    showPrompt: options.prompts?.versions !== false,
    globalCommitMode: options.globalCommitMode === "none" ? false : options.globalCommitMode,
    overrides: existingOverrides,
  });

  if (!updatesResult.ok) {
    exitWithError("Failed to calculate package updates.", undefined, updatesResult.error);
  }

  const { allUpdates, applyUpdates, overrides: newOverrides } = updatesResult.value;
  const hasOverrideChanges = JSON.stringify(existingOverrides) !== JSON.stringify(newOverrides);

  if (Object.keys(newOverrides).length > 0 && hasOverrideChanges) {
    logger.step("Writing version overrides file...");
    try {
      await mkdir(join(options.workspaceRoot, ".github"), { recursive: true });
      await writeFile(overridesPath, JSON.stringify(newOverrides, null, 2), "utf-8");
      logger.success("Successfully wrote version overrides file.");
    } catch (e) {
      logger.error("Failed to write version overrides file:", e);
    }
  } else if (Object.keys(newOverrides).length > 0) {
    logger.step("Version overrides unchanged. Skipping write.");
  }

  if (Object.keys(newOverrides).length === 0 && Object.keys(existingOverrides).length > 0) {
    let shouldRemoveOverrides = false;
    for (const update of allUpdates) {
      const overriddenVersion = existingOverrides[update.package.name];
      if (overriddenVersion) {
        if (compare(update.newVersion, overriddenVersion.version) > 0) {
          shouldRemoveOverrides = true;
          break;
        }
      }
    }

    if (shouldRemoveOverrides) {
      logger.info("Removing obsolete version overrides file...");
      try {
        await rm(overridesPath);
        logger.success("Successfully removed obsolete version overrides file.");
      } catch (e) {
        logger.error("Failed to remove obsolete version overrides file:", e);
      }
    }
  }

  if (allUpdates.filter((u) => u.hasDirectChanges).length === 0) {
    logger.warn("No packages have changes requiring a release");
  }

  logger.section("🔄 Version Updates");
  logger.item(`Updating ${allUpdates.length} packages (including dependents)`);

  for (const update of allUpdates) {
    const isAsIs = update.changeKind === "as-is";
    const suffix = isAsIs ? farver.dim(" (as-is)") : "";
    logger.item(`${update.package.name}: ${update.currentVersion} → ${update.newVersion}${suffix}`);
  }

  await applyUpdates();

  if (options.changelog?.enabled) {
    logger.step("Updating changelogs");

    const groupedPackageCommits = await getWorkspacePackageGroupedCommits(options.workspaceRoot, workspacePackages);
    const globalCommitsPerPackage = await getGlobalCommitsPerPackage(
      options.workspaceRoot,
      groupedPackageCommits,
      workspacePackages,
      options.globalCommitMode === "none" ? false : options.globalCommitMode,
    );

    const changelogPromises = allUpdates.map((update) => {
      return (async () => {
        let pkgCommits = groupedPackageCommits.get(update.package.name) || [];
        let globalCommits = globalCommitsPerPackage.get(update.package.name) || [];
        let previousVersionForChangelog: string | undefined = update.currentVersion !== "0.0.0"
          ? update.currentVersion
          : undefined;

        const shouldCombinePrereleaseIntoStable = options.changelog.combinePrereleaseIntoFirstStable
          && semver.prerelease(update.currentVersion) != null
          && semver.prerelease(update.newVersion) == null;

        if (shouldCombinePrereleaseIntoStable) {
          const stableTagResult = await getMostRecentPackageStableTag(options.workspaceRoot, update.package.name);
          if (!stableTagResult.ok) {
            logger.warn(`Failed to resolve stable tag for ${update.package.name}: ${stableTagResult.error.message}`);
          } else {
            const stableTag = stableTagResult.value;
            if (stableTag) {
              logger.verbose(`Combining prerelease changelog entries into stable release for ${update.package.name} using base tag ${stableTag}`);

              const stableBaseCommits = await getPackageCommitsSinceTag(
                options.workspaceRoot,
                update.package,
                stableTag,
              );

              pkgCommits = stableBaseCommits;

              const stableBaseGlobals = await getGlobalCommitsPerPackage(
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
        }

        const allCommits = [...pkgCommits, ...globalCommits];

        if (allCommits.length === 0) {
          logger.verbose(`No commits for ${update.package.name}, skipping changelog`);
          return;
        }

        logger.verbose(`Updating changelog for ${farver.cyan(update.package.name)}`);

        await updateChangelog({
          normalizedOptions: {
            ...options,
            workspaceRoot: options.workspaceRoot,
          },
          githubClient: options.githubClient,
          workspacePackage: update.package,
          version: update.newVersion,
          previousVersion: previousVersionForChangelog,
          commits: allCommits,
          date: new Date().toISOString().split("T")[0]!,
        });
      })();
    }).filter((p): p is Promise<void> => p != null);

    const updates = await Promise.all(changelogPromises);
    logger.success(`Updated ${updates.length} changelog(s)`);
  }

  const hasChangesToPush = await syncReleaseChanges({
    workspaceRoot: options.workspaceRoot,
    releaseBranch: options.branch.release,
    commitMessage: "chore: update release versions",
    hasChanges: true,
  });

  if (!hasChangesToPush.ok) {
    exitWithError("Failed to sync release changes.", undefined, hasChangesToPush.error);
  }

  if (!hasChangesToPush.value) {
    const prResult = await syncPullRequest({
      github: options.githubClient,
      releaseBranch: options.branch.release,
      defaultBranch: options.branch.default,
      pullRequestTitle: options.pullRequest?.title,
      pullRequestBody: options.pullRequest?.body,
      updates: allUpdates,
    });

    if (!prResult.ok) {
      exitWithError("Failed to sync release pull request.", undefined, prResult.error);
    }

    if (prResult.value.pullRequest) {
      logger.item("No updates needed, PR is already up to date");
      const checkoutResult = await checkoutBranch(options.branch.default, options.workspaceRoot);
      if (!checkoutResult.ok) {
        exitWithError(`Failed to checkout branch: ${options.branch.default}`, undefined, checkoutResult.error);
      }

      return {
        updates: allUpdates,
        prUrl: prResult.value.pullRequest.html_url,
        created: prResult.value.created,
      };
    }

    logger.error("No changes to commit, and no existing PR. Nothing to do.");
    return null;
  }

  const prResult = await syncPullRequest({
    github: options.githubClient,
    releaseBranch: options.branch.release,
    defaultBranch: options.branch.default,
    pullRequestTitle: options.pullRequest?.title,
    pullRequestBody: options.pullRequest?.body,
    updates: allUpdates,
  });

  if (!prResult.ok) {
    exitWithError("Failed to sync release pull request.", undefined, prResult.error);
  }

  if (prResult.value.pullRequest?.html_url) {
    logger.section("🚀 Pull Request");
    logger.success(`Pull request ${prResult.value.created ? "created" : "updated"}: ${prResult.value.pullRequest.html_url}`);
  }

  const returnToDefault = await checkoutBranch(options.branch.default, options.workspaceRoot);
  if (!returnToDefault.ok) {
    exitWithError(`Failed to checkout branch: ${options.branch.default}`, undefined, returnToDefault.error);
  }

  if (!returnToDefault.value) {
    exitWithError(`Failed to checkout branch: ${options.branch.default}`);
  }

  return {
    updates: allUpdates,
    prUrl: prResult.value.pullRequest?.html_url,
    created: prResult.value.created,
  };
}
