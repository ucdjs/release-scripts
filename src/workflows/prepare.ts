import type { ReleaseResult } from "#types/release";
import type { NormalizedReleaseScriptsOptions } from "../options";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { updateChangelog } from "#core/changelog";
import { createGitOperations } from "#core/git";
import { createGitHubClient, createGitHubOperations } from "#core/github";
import { createWorkspaceOperations } from "#core/workspace";
import { prepareReleaseBranch, syncReleaseChanges } from "#operations/branch";
import { calculateUpdates, ensureHasPackages } from "#operations/calculate";
import { syncPullRequest } from "#operations/pr";
import { exitWithError, logger, ucdjsReleaseOverridesPath } from "#shared/utils";
import { createVersioningOperations } from "#versioning/operations";
import farver from "farver";
import { compare } from "semver";

export async function prepareWorkflow(options: NormalizedReleaseScriptsOptions): Promise<ReleaseResult | null> {
  const gitOps = createGitOperations();
  const githubOps = createGitHubOperations({
    owner: options.owner,
    repo: options.repo,
    githubToken: options.githubToken,
  });
  const workspaceOps = createWorkspaceOperations();
  const versioningOps = createVersioningOperations();

  if (options.safeguards) {
    const clean = await gitOps.isWorkingDirectoryClean(options.workspaceRoot);
    if (!clean.ok || !clean.value) {
      exitWithError("Working directory is not clean. Please commit or stash your changes before proceeding.");
    }
  }

  const discovered = await workspaceOps.discoverWorkspacePackages(options.workspaceRoot, options);
  if (!discovered.ok) {
    exitWithError(`Failed to discover packages: ${discovered.error.message}`);
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
    git: gitOps,
    workspaceRoot: options.workspaceRoot,
    releaseBranch: options.branch.release,
    defaultBranch: options.branch.default,
  });

  if (!prepareBranchResult.ok) {
    exitWithError(prepareBranchResult.error.message);
  }

  const overridesPath = join(options.workspaceRoot, ucdjsReleaseOverridesPath);
  let existingOverrides: Record<string, { version: string; type: import("#shared/types").BumpKind }> = {};
  try {
    const overridesContent = await readFile(overridesPath, "utf-8");
    existingOverrides = JSON.parse(overridesContent);
    logger.info("Found existing version overrides file.");
  } catch {
    logger.info("No existing version overrides file found. Continuing...");
  }

  const updatesResult = await calculateUpdates({
    versioning: versioningOps,
    workspacePackages,
    workspaceRoot: options.workspaceRoot,
    showPrompt: options.prompts?.versions !== false,
    globalCommitMode: options.globalCommitMode === "none" ? false : options.globalCommitMode,
    overrides: existingOverrides,
  });

  if (!updatesResult.ok) {
    exitWithError(updatesResult.error.message);
  }

  const { allUpdates, applyUpdates, overrides: newOverrides } = updatesResult.value;

  if (Object.keys(newOverrides).length > 0) {
    logger.info("Writing version overrides file...");
    try {
      await mkdir(join(options.workspaceRoot, ".github"), { recursive: true });
      await writeFile(overridesPath, JSON.stringify(newOverrides, null, 2), "utf-8");
      logger.success("Successfully wrote version overrides file.");
    } catch (e) {
      logger.error("Failed to write version overrides file:", e);
    }
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
    logger.item(`${update.package.name}: ${update.currentVersion} → ${update.newVersion}`);
  }

  await applyUpdates();

  if (options.changelog?.enabled) {
    logger.step("Updating changelogs");

    const groupedPackageCommits = await versioningOps.getWorkspacePackageGroupedCommits(options.workspaceRoot, workspacePackages);
    if (!groupedPackageCommits.ok) {
      exitWithError(groupedPackageCommits.error.message);
    }

    const globalCommitsPerPackage = await versioningOps.getGlobalCommitsPerPackage(
      options.workspaceRoot,
      groupedPackageCommits.value,
      workspacePackages,
      options.globalCommitMode === "none" ? false : options.globalCommitMode,
    );
    if (!globalCommitsPerPackage.ok) {
      exitWithError(globalCommitsPerPackage.error.message);
    }

    const changelogPromises = allUpdates.map((update) => {
      const pkgCommits = groupedPackageCommits.value.get(update.package.name) || [];
      const globalCommits = globalCommitsPerPackage.value.get(update.package.name) || [];
      const allCommits = [...pkgCommits, ...globalCommits];

      if (allCommits.length === 0) {
        logger.verbose(`No commits for ${update.package.name}, skipping changelog`);
        return Promise.resolve();
      }

      logger.verbose(`Updating changelog for ${farver.cyan(update.package.name)}`);

      return updateChangelog({
        normalizedOptions: {
          ...options,
          workspaceRoot: options.workspaceRoot,
        },
        githubClient: createGitHubClient({
          owner: options.owner,
          repo: options.repo,
          githubToken: options.githubToken,
        }),
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

  const hasChangesToPush = await syncReleaseChanges({
    git: gitOps,
    workspaceRoot: options.workspaceRoot,
    releaseBranch: options.branch.release,
    commitMessage: "chore: update release versions",
    hasChanges: true,
  });

  if (!hasChangesToPush.ok) {
    exitWithError(hasChangesToPush.error.message);
  }

  if (!hasChangesToPush.value) {
    const prResult = await syncPullRequest({
      github: githubOps,
      releaseBranch: options.branch.release,
      defaultBranch: options.branch.default,
      pullRequestTitle: options.pullRequest?.title,
      pullRequestBody: options.pullRequest?.body,
      updates: allUpdates,
    });

    if (!prResult.ok) {
      exitWithError(prResult.error.message);
    }

    if (prResult.value.pullRequest) {
      logger.item("No updates needed, PR is already up to date");
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
    github: githubOps,
    releaseBranch: options.branch.release,
    defaultBranch: options.branch.default,
    pullRequestTitle: options.pullRequest?.title,
    pullRequestBody: options.pullRequest?.body,
    updates: allUpdates,
  });

  if (!prResult.ok) {
    exitWithError(prResult.error.message);
  }

  if (prResult.value.pullRequest?.html_url) {
    logger.section("🚀 Pull Request");
    logger.success(`Pull request ${prResult.value.created ? "created" : "updated"}: ${prResult.value.pullRequest.html_url}`);
  }

  const returnToDefault = await gitOps.checkoutBranch(options.branch.default, options.workspaceRoot);
  if (!returnToDefault.ok || !returnToDefault.value) {
    exitWithError(`Failed to checkout branch: ${options.branch.default}`);
  }

  return {
    updates: allUpdates,
    prUrl: prResult.value.pullRequest?.html_url,
    created: prResult.value.created,
  };
}
