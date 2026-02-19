import type { GitError } from "#core/git";
import type { WorkspacePackage } from "#core/workspace";
import type { PackageRelease } from "#shared/types";
import type { Result } from "#types";
import { formatUnknownError } from "#shared/errors";
import { err, ok } from "#types";
import { getGlobalCommitsPerPackage, getWorkspacePackageGroupedCommits } from "#versioning/commits";
import { calculateAndPrepareVersionUpdates } from "#versioning/version";

interface CalculateUpdatesOptions {
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
    workspacePackages,
    workspaceRoot,
    showPrompt,
    overrides,
    globalCommitMode,
  } = options;

  try {
    const grouped = await getWorkspacePackageGroupedCommits(workspaceRoot, workspacePackages);
    const global = await getGlobalCommitsPerPackage(
      workspaceRoot,
      grouped,
      workspacePackages,
      globalCommitMode,
    );

    const updates = await calculateAndPrepareVersionUpdates({
      workspacePackages,
      packageCommits: grouped,
      workspaceRoot,
      showPrompt,
      globalCommitsPerPackage: global,
      overrides,
    });

    return ok(updates);
  } catch (error) {
    const formatted = formatUnknownError(error);
    return err({
      type: "git",
      operation: "calculateUpdates",
      message: formatted.message,
      stderr: formatted.stderr,
    });
  }
}

export function ensureHasPackages(packages: WorkspacePackage[]): Result<WorkspacePackage[], GitError> {
  if (packages.length === 0) {
    return err({
      type: "git",
      operation: "discoverWorkspacePackages",
      message: "No packages found to release",
    });
  }

  return ok(packages);
}
