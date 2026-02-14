import type { VersioningOperations } from "#core/types";
import { getGlobalCommitsPerPackage, getWorkspacePackageGroupedCommits } from "#versioning/commits";
import { calculateAndPrepareVersionUpdates } from "#versioning/version";

export function createVersioningOperations(): VersioningOperations {
  return {
    getWorkspacePackageGroupedCommits: async (workspaceRoot, packages) => {
      try {
        return { ok: true, value: await getWorkspacePackageGroupedCommits(workspaceRoot, packages) };
      } catch (error) {
        return { ok: false, error: { type: "git", operation: "getWorkspacePackageGroupedCommits", message: String(error) } };
      }
    },
    getGlobalCommitsPerPackage: async (workspaceRoot, packageCommits, packages, mode) => {
      try {
        return { ok: true, value: await getGlobalCommitsPerPackage(workspaceRoot, packageCommits, packages, mode) };
      } catch (error) {
        return { ok: false, error: { type: "git", operation: "getGlobalCommitsPerPackage", message: String(error) } };
      }
    },
    calculateAndPrepareVersionUpdates: async (payload) => {
      try {
        return { ok: true, value: await calculateAndPrepareVersionUpdates(payload) };
      } catch (error) {
        return { ok: false, error: { type: "git", operation: "calculateAndPrepareVersionUpdates", message: String(error) } };
      }
    },
  };
}
