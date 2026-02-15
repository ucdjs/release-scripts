import type { Result } from "#types/result";
import { logger } from "#shared/utils";
import { err, ok } from "#types/result";
import type { GitError } from "#core/git";
import {
  checkoutBranch,
  createBranch,
  doesBranchExist,
  getCurrentBranch,
  isBranchAheadOfRemote,
  pullLatestChanges,
  rebaseBranch,
  commitChanges,
  pushBranch,
} from "#core/git";

interface PrepareReleaseBranchOptions {
  workspaceRoot: string;
  releaseBranch: string;
  defaultBranch: string;
}

export async function prepareReleaseBranch(options: PrepareReleaseBranchOptions): Promise<Result<void, GitError>> {
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
    const pulled = await pullLatestChanges(releaseBranch, workspaceRoot);
    if (!pulled.ok) return pulled;
    if (!pulled.value) {
      logger.warn("Failed to pull latest changes, continuing anyway.");
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
}

export async function syncReleaseChanges(options: SyncChangesOptions): Promise<Result<boolean, GitError>> {
  const { workspaceRoot, releaseBranch, commitMessage, hasChanges } = options;

  const committed = hasChanges
    ? await commitChanges(commitMessage, workspaceRoot)
    : ok(false);

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
