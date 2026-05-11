import { Effect } from "effect";
import { GitError, GitService } from "../services/git";
import { logger, runEffect } from "../shared/utils";

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

  const checkedOut = yield* git.checkoutBranch(releaseBranch, workspaceRoot);

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

  const rebased = yield* git.rebaseBranch(defaultBranch, workspaceRoot);
  void rebased;
});


interface SyncChangesOptions {
  workspaceRoot: string;
  releaseBranch: string;
  commitMessage: string;
  hasChanges: boolean;
  /** Extra file paths to explicitly stage (e.g. new untracked files that git add -u would miss). */
  additionalPaths?: string[];
}

export const syncReleaseChanges = Effect.fn("syncReleaseChanges")(function* (
  options: SyncChangesOptions,
) {
  const git = yield* GitService;
  const { workspaceRoot, releaseBranch, commitMessage, hasChanges, additionalPaths } = options;

  // Stage any explicitly listed paths before commitChanges runs.
  // commitChanges uses git add -u which only stages already-tracked files;
  // new files (like the overrides JSON) would be silently skipped without this.
  if (additionalPaths && additionalPaths.length > 0) {
    try {
      yield* runEffect("git", ["add", "--", ...additionalPaths], {
        nodeOptions: { cwd: workspaceRoot, stdio: "pipe" },
      });
    } catch (error) {
      logger.verbose(`Failed to stage additional paths: ${String(error)}`);
    }
  }

  const committed = hasChanges
    ? yield* git.commitChanges(commitMessage, workspaceRoot)
    : false;

  const isAhead = yield* git.isBranchAheadOfRemote(releaseBranch, workspaceRoot);

  if (!committed && !isAhead) {
    return false;
  }

  yield* git.pushBranch(releaseBranch, workspaceRoot, { forceWithLease: true });

  return true;
});
