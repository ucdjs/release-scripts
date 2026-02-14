import type { WorkspacePackage } from "./core/workspace";
import type { ReleaseScriptsOptionsInput } from "./options";
import type { ReleaseResult } from "./prepare";
import { discoverWorkspacePackages } from "./core/workspace";
import { normalizeReleaseScriptsOptions } from "./options";
import { release } from "./prepare";
import { publish } from "./publish";
import { verify } from "./verify";

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
        return discoverWorkspacePackages(normalizedOptions.workspaceRoot, normalizedOptions);
      },

      async get(packageName: string): Promise<WorkspacePackage | undefined> {
        const packages = await discoverWorkspacePackages(normalizedOptions.workspaceRoot, normalizedOptions);
        return packages.find((p) => p.name === packageName);
      },
    },
  };
}
