import type { NormalizedReleaseScriptsOptions } from "../options";
import { join, relative } from "node:path";
import { checkoutBranch, getCurrentBranch, isWorkingDirectoryClean, readFileFromGit } from "#core/git";
import { discoverWorkspacePackages } from "#core/workspace";
import { calculateUpdates, ensureHasPackages } from "#operations/calculate";
import { exitWithError, formatUnknownError } from "#shared/errors";
import { logger, ucdjsReleaseOverridesPath } from "#shared/utils";
import { gt } from "semver";

export async function verifyWorkflow(options: NormalizedReleaseScriptsOptions): Promise<void> {
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

  const releaseBranch = options.branch.release;
  const defaultBranch = options.branch.default;

  const releasePr = await options.githubClient.getExistingPullRequest(releaseBranch);

  if (!releasePr || !releasePr.head) {
    logger.warn(`No open release pull request found for branch "${releaseBranch}". Nothing to verify.`);
    return;
  }

  logger.info(`Found release PR #${releasePr.number}. Verifying against default branch "${defaultBranch}"...`);

  const originalBranch = await getCurrentBranch(options.workspaceRoot);
  if (!originalBranch.ok) {
    exitWithError("Failed to detect current branch.", undefined, originalBranch.error);
  }

  if (originalBranch.value !== defaultBranch) {
    const checkout = await checkoutBranch(defaultBranch, options.workspaceRoot);
    if (!checkout.ok) {
      exitWithError(`Failed to checkout branch: ${defaultBranch}`, undefined, checkout.error);
    }

    if (!checkout.value) {
      exitWithError(`Failed to checkout branch: ${defaultBranch}`);
    }
  }

  let existingOverrides: Record<string, { version: string; type: import("#shared/types").BumpKind }> = {};
  try {
    const overridesContent = await readFileFromGit(options.workspaceRoot, releasePr.head.sha, ucdjsReleaseOverridesPath);
    if (overridesContent.ok && overridesContent.value) {
      existingOverrides = JSON.parse(overridesContent.value);
      logger.info("Found existing version overrides file on release branch.");
    }
  } catch (error) {
    logger.info("No version overrides file found on release branch. Continuing...");
    logger.verbose(`Reading release overrides failed: ${formatUnknownError(error).message}`);
  }

  const discovered = await discoverWorkspacePackages(options.workspaceRoot, options);
  if (!discovered.ok) {
    exitWithError("Failed to discover packages.", undefined, discovered.error);
  }

  const ensured = ensureHasPackages(discovered.value);
  if (!ensured.ok) {
    logger.warn(ensured.error.message);
    return;
  }

  const mainPackages = ensured.value;

  const updatesResult = await calculateUpdates({
    workspacePackages: mainPackages,
    workspaceRoot: options.workspaceRoot,
    showPrompt: false,
    globalCommitMode: options.globalCommitMode === "none" ? false : options.globalCommitMode,
    overrides: existingOverrides,
  });

  if (!updatesResult.ok) {
    exitWithError("Failed to calculate expected package updates.", undefined, updatesResult.error);
  }

  const expectedUpdates = updatesResult.value.allUpdates;
  const expectedVersionMap = new Map<string, string>(
    expectedUpdates.map((u) => [u.package.name, u.newVersion]),
  );

  const prVersionMap = new Map<string, string>();
  for (const pkg of mainPackages) {
    const pkgJsonPath = relative(options.workspaceRoot, join(pkg.path, "package.json"));
    const pkgJsonContent = await readFileFromGit(options.workspaceRoot, releasePr.head.sha, pkgJsonPath);
    if (pkgJsonContent.ok && pkgJsonContent.value) {
      const pkgJson = JSON.parse(pkgJsonContent.value);
      prVersionMap.set(pkg.name, pkgJson.version);
    }
  }

  if (originalBranch.value !== defaultBranch) {
    await checkoutBranch(originalBranch.value, options.workspaceRoot);
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
    await options.githubClient.setCommitStatus({
      sha: releasePr.head.sha,
      state: "failure",
      context: statusContext,
      description: "Release PR is out of sync with the default branch. Please re-run the release process.",
    });
    logger.error("Verification failed. Commit status set to 'failure'.");
  } else {
    await options.githubClient.setCommitStatus({
      sha: releasePr.head.sha,
      state: "success",
      context: statusContext,
      description: "Release PR is up to date.",
      targetUrl: `https://github.com/${options.owner}/${options.repo}/pull/${releasePr.number}`,
    });
    logger.success("Verification successful. Commit status set to 'success'.");
  }
}
