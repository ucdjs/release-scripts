import type { GitError } from "#core/git";
import {
  checkoutBranch,
  commitChanges,
  createBranch,
  doesBranchExist,
  doesRemoteBranchExist,
  getCurrentBranch,
  isBranchAheadOfRemote,
  pullLatestChanges,
  pushBranch,
  rebaseBranch,
} from "#core/git";
import { logger, run } from "#shared/utils";
import type { Result } from "#types";
import { err, ok } from "#types";

interface PrepareReleaseBranchOptions {
  workspaceRoot: string;
  releaseBranch: string;
  defaultBranch: string;
}

export async function prepareReleaseBranch(
  options: PrepareReleaseBranchOptions,
): Promise<Result<void, GitError>> {
  const { workspaceRoot, releaseBranch, defaultBranch } = options;

  const currentBranch = await getCurrentBranch(workspaceRoot);
  if (!currentBranch.ok) return currentBranch;

  if (currentBranch.value !== defaultBranch) {
    return err({
      type: "git",
      operation: "validateBranch",
      message: `Current branch is '${currentBranch.value}'. Please switch to '${defaultBranch}'.`,
    });
  }

  const branchExists = await doesBranchExist(releaseBranch, workspaceRoot);
  if (!branchExists.ok) return branchExists;

  if (!branchExists.value) {
    const created = await createBranch(releaseBranch, defaultBranch, workspaceRoot);
    if (!created.ok) return created;
  }

  const checkedOut = await checkoutBranch(releaseBranch, workspaceRoot);
  if (!checkedOut.ok) return checkedOut;

  if (branchExists.value) {
    const remoteExists = await doesRemoteBranchExist(releaseBranch, workspaceRoot);
    if (!remoteExists.ok) return remoteExists;

    if (remoteExists.value) {
      const pulled = await pullLatestChanges(releaseBranch, workspaceRoot);
      if (!pulled.ok) return pulled;
      if (!pulled.value) {
        logger.warn("Failed to pull latest changes, continuing anyway.");
      }
    } else {
      logger.info(`Remote branch "origin/${releaseBranch}" does not exist yet, skipping pull.`);
    }
  }

  const rebased = await rebaseBranch(defaultBranch, workspaceRoot);
  if (!rebased.ok) return rebased;

  return ok(undefined);
}

interface SyncChangesOptions {
  workspaceRoot: string;
  releaseBranch: string;
  commitMessage: string;
  hasChanges: boolean;
  /** Extra file paths to explicitly stage (e.g. new untracked files that git add -u would miss). */
  additionalPaths?: string[];
}

export async function syncReleaseChanges(
  options: SyncChangesOptions,
): Promise<Result<boolean, GitError>> {
  const { workspaceRoot, releaseBranch, commitMessage, hasChanges, additionalPaths } = options;

  // Stage any explicitly listed paths before commitChanges runs.
  // commitChanges uses git add -u which only stages already-tracked files;
  // new files (like the overrides JSON) would be silently skipped without this.
  if (additionalPaths && additionalPaths.length > 0) {
    try {
      await run("git", ["add", "--", ...additionalPaths], {
        nodeOptions: { cwd: workspaceRoot, stdio: "pipe" },
      });
    } catch (error) {
      logger.verbose(`Failed to stage additional paths: ${String(error)}`);
    }
  }

  const committed = hasChanges ? await commitChanges(commitMessage, workspaceRoot) : ok(false);

  if (!committed.ok) return committed;

  const isAhead = await isBranchAheadOfRemote(releaseBranch, workspaceRoot);
  if (!isAhead.ok) return isAhead;

  if (!committed.value && !isAhead.value) {
    return ok(false);
  }

  const pushed = await pushBranch(releaseBranch, workspaceRoot, { forceWithLease: true });
  if (!pushed.ok) return pushed;

  return ok(true);
}
