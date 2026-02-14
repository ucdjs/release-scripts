import type { GitError, VersioningOperations } from "#core/types";
import type { WorkspacePackage } from "#core/workspace";
import type { PackageRelease } from "#shared/types";
import type { Result } from "#types/result";
import { err } from "#types/result";

interface CalculateUpdatesOptions {
  versioning: VersioningOperations;
  workspacePackages: WorkspacePackage[];
  workspaceRoot: string;
  showPrompt: boolean;
  overrides: Record<string, { version: string; type: import("#shared/types").BumpKind }>;
  globalCommitMode: false | "dependencies" | "all";
}

export async function calculateUpdates(options: CalculateUpdatesOptions): Promise<Result<{
  allUpdates: PackageRelease[];
  applyUpdates: () => Promise<void>;
  overrides: Record<string, { version: string; type: import("#shared/types").BumpKind }>;
}, GitError>> {
  const {
    versioning,
    workspacePackages,
    workspaceRoot,
    showPrompt,
    overrides,
    globalCommitMode,
  } = options;

  const grouped = await versioning.getWorkspacePackageGroupedCommits(workspaceRoot, workspacePackages);
  if (!grouped.ok) return grouped;

  const global = await versioning.getGlobalCommitsPerPackage(
    workspaceRoot,
    grouped.value,
    workspacePackages,
    globalCommitMode,
  );
  if (!global.ok) return global;

  const updates = await versioning.calculateAndPrepareVersionUpdates({
    workspacePackages,
    packageCommits: grouped.value,
    workspaceRoot,
    showPrompt,
    globalCommitsPerPackage: global.value,
    overrides,
  });

  if (!updates.ok) return updates;

  return updates;
}

export function ensureHasPackages(packages: WorkspacePackage[]): Result<WorkspacePackage[], GitError> {
  if (packages.length === 0) {
    return err({
      type: "git",
      operation: "discoverPackages",
      message: "No packages found to release",
    });
  }

  return { ok: true, value: packages };
}
