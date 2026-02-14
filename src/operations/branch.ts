import type { GitError, GitOperations } from "#core/types";
import type { Result } from "#types/result";
import { logger } from "#shared/utils";
import { err, ok } from "#types/result";

interface PrepareReleaseBranchOptions {
  git: GitOperations;
  workspaceRoot: string;
  releaseBranch: string;
  defaultBranch: string;
}

export async function prepareReleaseBranch(options: PrepareReleaseBranchOptions): Promise<Result<void, GitError>> {
  const { git, workspaceRoot, releaseBranch, defaultBranch } = options;

  const currentBranch = await git.getCurrentBranch(workspaceRoot);
  if (!currentBranch.ok) return currentBranch;

  if (currentBranch.value !== defaultBranch) {
    return err({
      type: "git",
      operation: "validateBranch",
      message: `Current branch is '${currentBranch.value}'. Please switch to '${defaultBranch}'.`,
    });
  }

  const branchExists = await git.doesBranchExist(releaseBranch, workspaceRoot);
  if (!branchExists.ok) return branchExists;

  if (!branchExists.value) {
    const created = await git.createBranch(releaseBranch, defaultBranch, workspaceRoot);
    if (!created.ok) return created;
  }

  const checkedOut = await git.checkoutBranch(releaseBranch, workspaceRoot);
  if (!checkedOut.ok) return checkedOut;

  if (branchExists.value) {
    const pulled = await git.pullLatestChanges(releaseBranch, workspaceRoot);
    if (!pulled.ok) return pulled;
    if (!pulled.value) {
      logger.warn("Failed to pull latest changes, continuing anyway.");
    }
  }

  const rebased = await git.rebaseBranch(defaultBranch, workspaceRoot);
  if (!rebased.ok) return rebased;

  return ok(undefined);
}

interface SyncChangesOptions {
  git: GitOperations;
  workspaceRoot: string;
  releaseBranch: string;
  commitMessage: string;
  hasChanges: boolean;
}

export async function syncReleaseChanges(options: SyncChangesOptions): Promise<Result<boolean, GitError>> {
  const { git, workspaceRoot, releaseBranch, commitMessage, hasChanges } = options;

  const committed = hasChanges
    ? await git.commitChanges(commitMessage, workspaceRoot)
    : ok(false);

  if (!committed.ok) return committed;

  const isAhead = await git.isBranchAheadOfRemote(releaseBranch, workspaceRoot);
  if (!isAhead.ok) return isAhead;

  if (!committed.value && !isAhead.value) {
    return ok(false);
  }

  const pushed = await git.pushBranch(releaseBranch, workspaceRoot, { forceWithLease: true });
  if (!pushed.ok) return pushed;

  return ok(true);
}
