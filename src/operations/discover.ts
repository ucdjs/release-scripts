import type { WorkspaceError, WorkspaceOperations } from "#core/types";
import type { Result } from "#types/result";

interface DiscoverOptions {
  workspace: WorkspaceOperations;
  workspaceRoot: string;
  options: unknown;
}

export async function discoverPackages({ workspace, workspaceRoot, options }: DiscoverOptions): Promise<Result<import("#core/workspace").WorkspacePackage[], WorkspaceError>> {
  return workspace.discoverWorkspacePackages(workspaceRoot, options);
}
