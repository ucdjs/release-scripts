import { join, relative } from "node:path";

import { GitHubService } from "../services/github";
import { type GitError, GitService } from "../services/git";
import { type WorkspaceError, WorkspaceService, type WorkspacePackage } from "../services/workspace";
import type { PackageRelease } from "../shared/types";
import { calculateUpdates, ensureHasPackages } from "./calculate";
import { exitWithError, formatUnknownError } from "../shared/errors";
import { ReleaseOptions } from "../options";
import { logger, ucdjsReleaseOverridesPath } from "../shared/utils";
import { Effect } from "effect";
import { gt } from "semver";

export const verifyWorkflow = Effect.fn("verifyWorkflow")(function* () {
  const options = yield* ReleaseOptions;
  const github = yield* GitHubService;
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

  const releaseBranch = options.branch.release;
  const defaultBranch = options.branch.default;

  const releasePr = yield* github.getExistingPullRequest(releaseBranch);

  if (!releasePr || !releasePr.head) {
    logger.warn(
      `No open release pull request found for branch "${releaseBranch}". Nothing to verify.`,
    );
    return;
  }

  const releaseHeadSha = releasePr.head.sha;

  logger.info(
    `Found release PR #${releasePr.number}. Verifying against default branch "${defaultBranch}"...`,
  );

  const originalBranch = yield* Effect.catchTag(
    git.getCurrentBranch(options.workspaceRoot) as Effect.Effect<string, GitError, unknown>,
    "GitError",
    (error) =>
      Effect.sync(() => exitWithError("Failed to detect current branch.", undefined, error)),
  );

  if (originalBranch !== defaultBranch) {
    const checkout = yield* git.checkoutBranch(defaultBranch, options.workspaceRoot);
    if (!checkout) {
      exitWithError(`Failed to checkout branch: ${defaultBranch}`);
    }
  }

  let existingOverrides: Record<
    string,
    { version: string; type: import("#shared/types").BumpKind }
  > = {};
  try {
    const overridesContent = yield* git.readFileFromGit(
      options.workspaceRoot,
      releaseHeadSha,
      ucdjsReleaseOverridesPath,
    );
    if (overridesContent) {
      existingOverrides = JSON.parse(overridesContent);
      logger.info("Found existing version overrides file on release branch.");
    }
  } catch (error) {
    logger.info("No version overrides file found on release branch. Continuing...");
    logger.verbose(`Reading release overrides failed: ${formatUnknownError(error).message}`);
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

  const mainPackages = ensureHasPackages(discovered);
  if (mainPackages === null) {
    logger.warn("No packages found to release");
    return;
  }

  const updates = yield* Effect.catchTag(calculateUpdates({
    workspacePackages: mainPackages,
    workspaceRoot: options.workspaceRoot,
    showPrompt: false,
    globalCommitMode: options.globalCommitMode === "none" ? false : options.globalCommitMode,
    overrides: existingOverrides,
  }) as Effect.Effect<any, GitError, unknown>, "GitError", (error) =>
      Effect.sync(() => exitWithError("Failed to calculate expected package updates.", undefined, error)),
    );

  const expectedUpdates = updates.allUpdates;
  const expectedVersionMap = new Map<string, string>(
    expectedUpdates.map((u: PackageRelease) => [u.package.name, u.newVersion]),
  );

  const prVersionMap = new Map<string, string>();
  for (const pkg of mainPackages) {
    const pkgJsonPath = relative(options.workspaceRoot, join(pkg.path, "package.json"));
    const pkgJsonContent = yield* git.readFileFromGit(
      options.workspaceRoot,
      releaseHeadSha,
      pkgJsonPath,
    );
    if (pkgJsonContent) {
      const pkgJson = JSON.parse(pkgJsonContent);
      prVersionMap.set(pkg.name, pkgJson.version);
    }
  }

  if (originalBranch !== defaultBranch) {
    yield* git.checkoutBranch(originalBranch, options.workspaceRoot);
  }

  let isOutOfSync = false;
  for (const [pkgName, expectedVersion] of expectedVersionMap.entries()) {
    const prVersion = prVersionMap.get(pkgName);
    if (!prVersion) {
      logger.warn(
        `Package "${pkgName}" found in default branch but not in release branch. Skipping.`,
      );
      continue;
    }

    if (gt(expectedVersion, prVersion)) {
      logger.error(
        `Package "${pkgName}" is out of sync. Expected version >= ${expectedVersion}, but PR has ${prVersion}.`,
      );
      isOutOfSync = true;
    } else {
      logger.success(
        `Package "${pkgName}" is up to date (PR version: ${prVersion}, Expected: ${expectedVersion})`,
      );
    }
  }

  const statusContext = "ucdjs/release-verify";

  if (isOutOfSync) {
    yield* github.setCommitStatus({
      sha: releaseHeadSha,
      state: "failure",
      context: statusContext,
      description:
        "Release PR is out of sync with the default branch. Please re-run the release process.",
    });
    logger.error("Verification failed. Commit status set to 'failure'.");
  } else {
    yield* github.setCommitStatus({
      sha: releaseHeadSha,
      state: "success",
      context: statusContext,
      description: "Release PR is up to date.",
      targetUrl: `https://github.com/${options.owner}/${options.repo}/pull/${releasePr.number}`,
    });
    logger.success("Verification successful. Commit status set to 'success'.");
  }
});
