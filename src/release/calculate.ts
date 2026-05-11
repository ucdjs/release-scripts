import { Effect } from "effect";
import { GitError } from "../services/git";
import type { WorkspacePackage } from "../services/workspace";
import { formatUnknownError } from "../shared/errors";
import {
  getGlobalCommitsPerPackage,
  getWorkspacePackageGroupedCommits,
} from "../versioning/commits";
import { calculateAndPrepareVersionUpdates } from "../versioning/version";

interface CalculateUpdatesOptions {
  workspacePackages: WorkspacePackage[];
  workspaceRoot: string;
  showPrompt: boolean;
  overrides: Record<string, { version: string; type: import("#shared/types").BumpKind }>;
  globalCommitMode: false | "dependencies" | "all";
}

export const calculateUpdates = Effect.fn("calculateUpdates")(function* (
  options: CalculateUpdatesOptions,
) {
  const { workspacePackages, workspaceRoot, showPrompt, overrides, globalCommitMode } = options;

  try {
    const grouped = yield* getWorkspacePackageGroupedCommits(workspaceRoot, workspacePackages);
    const global = yield* getGlobalCommitsPerPackage(
      workspaceRoot,
      grouped,
      workspacePackages,
      globalCommitMode,
    );

    const updates = yield* calculateAndPrepareVersionUpdates({
      workspacePackages,
      packageCommits: grouped,
      workspaceRoot,
      showPrompt,
      globalCommitsPerPackage: global,
      overrides,
    });

    return updates;
  } catch (error) {
    const formatted = formatUnknownError(error);
    return yield* Effect.fail(new GitError({
      operation: "calculateUpdates",
      message: formatted.message,
      stderr: formatted.stderr,
    }));
  }
});

export function ensureHasPackages(packages: WorkspacePackage[]): WorkspacePackage[] | null {
  if (packages.length === 0) {
    return null;
  }

  return packages;
}
