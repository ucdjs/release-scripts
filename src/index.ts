import type { ReleaseResult } from "#types/release";
import type { WorkspacePackage } from "./core/workspace";
import type { ReleaseScriptsOptionsInput } from "./options";
import { prepareWorkflow as release } from "#workflows/prepare";
import { publishWorkflow as publish } from "#workflows/publish";
import { verifyWorkflow as verify } from "#workflows/verify";
import { discoverWorkspacePackages } from "./core/workspace";
import { normalizeReleaseScriptsOptions } from "./options";

export interface ReleaseScripts {
  verify: () => Promise<void>;
  prepare: () => Promise<ReleaseResult | null>;
  publish: () => Promise<void>;
  packages: {
    list: () => Promise<WorkspacePackage[]>;
    get: (packageName: string) => Promise<WorkspacePackage | undefined>;
  };
}

export async function createReleaseScripts(options: ReleaseScriptsOptionsInput): Promise<ReleaseScripts> {
  // Normalize options once for packages.list and packages.get
  const normalizedOptions = normalizeReleaseScriptsOptions(options);

  return {
    async verify(): Promise<void> {
      return verify(normalizedOptions);
    },

    async prepare(): Promise<ReleaseResult | null> {
      return release(normalizedOptions);
    },

    async publish(): Promise<void> {
      return publish(normalizedOptions);
    },

    packages: {
      async list(): Promise<WorkspacePackage[]> {
        const result = await discoverWorkspacePackages(normalizedOptions.workspaceRoot, normalizedOptions);
        if (!result.ok) {
          throw new Error(result.error.message);
        }
        return result.value;
      },

      async get(packageName: string): Promise<WorkspacePackage | undefined> {
        const result = await discoverWorkspacePackages(normalizedOptions.workspaceRoot, normalizedOptions);
        if (!result.ok) {
          throw new Error(result.error.message);
        }
        return result.value.find((p) => p.name === packageName);
      },
    },
  };
}
