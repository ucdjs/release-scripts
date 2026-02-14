import type { NormalizedReleaseScriptsOptions } from "../options";
import { join, relative } from "node:path";
import { createGitOperations } from "#core/git";
import { createGitHubOperations } from "#core/github";
import { createWorkspaceOperations } from "#core/workspace";
import { calculateUpdates, ensureHasPackages } from "#operations/calculate";
import { discoverPackages } from "#operations/discover";
import { createVersioningOperations } from "#versioning/operations";
import { exitWithError, logger, ucdjsReleaseOverridesPath } from "#shared/utils";
import { gt } from "semver";

export async function verifyWorkflow(options: NormalizedReleaseScriptsOptions): Promise<void> {
  const gitOps = createGitOperations();
  const githubOps = createGitHubOperations({
    owner: options.owner,
    repo: options.repo,
    githubToken: options.githubToken,
  });
  const workspaceOps = createWorkspaceOperations();

  if (options.safeguards) {
    const clean = await gitOps.isWorkingDirectoryClean(options.workspaceRoot);
    if (!clean.ok || !clean.value) {
      exitWithError("Working directory is not clean. Please commit or stash your changes before proceeding.");
    }
  }

  const releaseBranch = options.branch.release;
  const defaultBranch = options.branch.default;

  const releasePr = await githubOps.getExistingPullRequest(releaseBranch);
  if (!releasePr.ok) {
    exitWithError(releasePr.error.message);
  }

  if (!releasePr.value || !releasePr.value.head) {
    logger.warn(`No open release pull request found for branch "${releaseBranch}". Nothing to verify.`);
    return;
  }

  logger.info(`Found release PR #${releasePr.value.number}. Verifying against default branch "${defaultBranch}"...`);

  const originalBranch = await gitOps.getCurrentBranch(options.workspaceRoot);
  if (!originalBranch.ok) {
    exitWithError(originalBranch.error.message);
  }

  if (originalBranch.value !== defaultBranch) {
    const checkout = await gitOps.checkoutBranch(defaultBranch, options.workspaceRoot);
    if (!checkout.ok || !checkout.value) {
      exitWithError(`Failed to checkout branch: ${defaultBranch}`);
    }
  }

  let existingOverrides: Record<string, { version: string; type: import("#shared/types").BumpKind }> = {};
  try {
    const overridesContent = await gitOps.readFileFromGit(options.workspaceRoot, releasePr.value.head.sha, ucdjsReleaseOverridesPath);
    if (overridesContent.ok && overridesContent.value) {
      existingOverrides = JSON.parse(overridesContent.value);
      logger.info("Found existing version overrides file on release branch.");
    }
  } catch {
    logger.info("No version overrides file found on release branch. Continuing...");
  }

  const discovered = await discoverPackages({
    workspace: workspaceOps,
    workspaceRoot: options.workspaceRoot,
    options,
  });
  if (!discovered.ok) {
    exitWithError(`Failed to discover packages: ${discovered.error.message}`);
  }

  const ensured = ensureHasPackages(discovered.value);
  if (!ensured.ok) {
    logger.warn(ensured.error.message);
    return;
  }

  const mainPackages = ensured.value;

  const updatesResult = await calculateUpdates({
    versioning: createVersioningOperations(),
    workspacePackages: mainPackages,
    workspaceRoot: options.workspaceRoot,
    showPrompt: false,
    globalCommitMode: options.globalCommitMode === "none" ? false : options.globalCommitMode,
    overrides: existingOverrides,
  });

  if (!updatesResult.ok) {
    exitWithError(updatesResult.error.message);
  }

  const expectedUpdates = updatesResult.value.allUpdates;
  const expectedVersionMap = new Map<string, string>(
    expectedUpdates.map((u) => [u.package.name, u.newVersion]),
  );

  const prVersionMap = new Map<string, string>();
  for (const pkg of mainPackages) {
    const pkgJsonPath = relative(options.workspaceRoot, join(pkg.path, "package.json"));
    const pkgJsonContent = await gitOps.readFileFromGit(options.workspaceRoot, releasePr.value.head.sha, pkgJsonPath);
    if (pkgJsonContent.ok && pkgJsonContent.value) {
      const pkgJson = JSON.parse(pkgJsonContent.value);
      prVersionMap.set(pkg.name, pkgJson.version);
    }
  }

  if (originalBranch.value !== defaultBranch) {
    await gitOps.checkoutBranch(originalBranch.value, options.workspaceRoot);
  }

  let isOutOfSync = false;
  for (const [pkgName, expectedVersion] of expectedVersionMap.entries()) {
    const prVersion = prVersionMap.get(pkgName);
    if (!prVersion) {
      logger.warn(`Package "${pkgName}" found in default branch but not in release branch. Skipping.`);
      continue;
    }

    if (gt(expectedVersion, prVersion)) {
      logger.error(`Package "${pkgName}" is out of sync. Expected version >= ${expectedVersion}, but PR has ${prVersion}.`);
      isOutOfSync = true;
    } else {
      logger.success(`Package "${pkgName}" is up to date (PR version: ${prVersion}, Expected: ${expectedVersion})`);
    }
  }

  const statusContext = "ucdjs/release-verify";

  if (isOutOfSync) {
    await githubOps.setCommitStatus({
      sha: releasePr.value.head.sha,
      state: "failure",
      context: statusContext,
      description: "Release PR is out of sync with the default branch. Please re-run the release process.",
    });
    logger.error("Verification failed. Commit status set to 'failure'.");
  } else {
    await githubOps.setCommitStatus({
      sha: releasePr.value.head.sha,
      state: "success",
      context: statusContext,
      description: "Release PR is up to date.",
      targetUrl: `https://github.com/${options.owner}/${options.repo}/pull/${releasePr.value.number}`,
    });
    logger.success("Verification successful. Commit status set to 'success'.");
  }
}
