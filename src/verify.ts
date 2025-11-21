import type { SharedOptions } from "#shared/types";
import type { VersionOverrides } from "#versioning/version";
import { join } from "node:path";
import { checkoutBranch, getCurrentBranch, isWorkingDirectoryClean, readFileFromGit } from "#core/git";
import { createGitHubClient } from "#core/github";
import {
  discoverWorkspacePackages,
} from "#core/workspace";
import { normalizeReleaseOptions } from "#shared/options";
import { exitWithError, logger, ucdjsReleaseOverridesPath } from "#shared/utils";
import { getGlobalCommitsPerPackage, getWorkspacePackageGroupedCommits } from "#versioning/commits";
import {
  calculateAndPrepareVersionUpdates,

} from "#versioning/version";
import { gt } from "semver";

export interface VerifyOptions extends SharedOptions {
  branch?: {
    release?: string;
    default?: string;
  };
  safeguards?: boolean;
}

export async function verify(options: VerifyOptions): Promise<void> {
  const {
    workspaceRoot,
    ...normalizedOptions
  } = await normalizeReleaseOptions(options);

  if (normalizedOptions.safeguards && !(await isWorkingDirectoryClean(workspaceRoot))) {
    exitWithError("Working directory is not clean. Please commit or stash your changes before proceeding.");
  }

  const githubClient = createGitHubClient({
    owner: normalizedOptions.owner,
    repo: normalizedOptions.repo,
    githubToken: normalizedOptions.githubToken,
  });

  const releaseBranch = normalizedOptions.branch.release;
  const defaultBranch = normalizedOptions.branch.default;

  const releasePr = await githubClient.getExistingPullRequest(releaseBranch);

  if (!releasePr || !releasePr.head) {
    logger.warn(`No open release pull request found for branch "${releaseBranch}". Nothing to verify.`);
    return;
  }

  logger.info(`Found release PR #${releasePr.number}. Verifying against default branch "${defaultBranch}"...`);

  const originalBranch = await getCurrentBranch(workspaceRoot);
  if (originalBranch !== defaultBranch) {
    await checkoutBranch(defaultBranch, workspaceRoot);
  }

  // Read overrides file from the release branch
  const overridesPath = join(workspaceRoot, ucdjsReleaseOverridesPath);
  let existingOverrides: VersionOverrides = {};
  try {
    const overridesContent = await readFileFromGit(workspaceRoot, releasePr.head.sha, overridesPath);
    if (overridesContent) {
      existingOverrides = JSON.parse(overridesContent);
      logger.info("Found existing version overrides file on release branch.");
    }
  } catch {
    logger.info("No version overrides file found on release branch. Continuing...");
  }

  const mainPackages = await discoverWorkspacePackages(workspaceRoot, options);
  const mainCommits = await getWorkspacePackageGroupedCommits(workspaceRoot, mainPackages);

  const globalCommitsPerPackage = await getGlobalCommitsPerPackage(
    workspaceRoot,
    mainCommits,
    mainPackages,
    normalizedOptions.globalCommitMode,
  );

  const { allUpdates: expectedUpdates } = await calculateAndPrepareVersionUpdates({
    workspacePackages: mainPackages,
    packageCommits: mainCommits,
    workspaceRoot,
    showPrompt: false,
    globalCommitsPerPackage,
    overrides: existingOverrides,
  });

  const expectedVersionMap = new Map<string, string>(
    expectedUpdates.map((u) => [u.package.name, u.newVersion]),
  );

  // Read package.json versions from the release branch without checking it out
  const prVersionMap = new Map<string, string>();
  for (const pkg of mainPackages) {
    const pkgJsonPath = join(pkg.path.replace(workspaceRoot, ""), "package.json").substring(1);
    const pkgJsonContent = await readFileFromGit(workspaceRoot, releasePr.head.sha, pkgJsonPath);
    if (pkgJsonContent) {
      const pkgJson = JSON.parse(pkgJsonContent);
      prVersionMap.set(pkg.name, pkgJson.version);
    }
  }

  if (originalBranch !== defaultBranch) {
    await checkoutBranch(originalBranch, workspaceRoot);
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
    await githubClient.setCommitStatus({
      sha: releasePr.head.sha,
      state: "failure",
      context: statusContext,
      description: "Release PR is out of sync with the default branch. Please re-run the release process.",
    });
    logger.error("Verification failed. Commit status set to 'failure'.");
  } else {
    await githubClient.setCommitStatus({
      sha: releasePr.head.sha,
      state: "success",
      context: statusContext,
      description: "Release PR is up to date.",
    });
    logger.success("Verification successful. Commit status set to 'success'.");
  }
}
