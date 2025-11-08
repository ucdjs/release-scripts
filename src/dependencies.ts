import type { VersionUpdate, WorkspacePackage } from "./types";
import { createVersionUpdate } from "./version";

/**
 * Pure function: Determine which packages need updates due to dependency changes
 *
 * When a package is updated, all packages that depend on it should also be updated.
 * This function calculates which additional packages need patch bumps.
 *
 * @param updateOrder - Packages in topological order with their dependency levels
 * @param directUpdates - Packages with direct code changes
 * @returns All updates including dependent packages
 */
export function createDependentUpdates(
  updateOrder: Array<{ package: WorkspacePackage; level: number }>,
  directUpdates: VersionUpdate[],
): VersionUpdate[] {
  const allUpdates = [...directUpdates];
  const updatedPackages = new Set(directUpdates.map((u) => u.package.name));

  // Process packages in dependency order
  for (const { package: pkg } of updateOrder) {
    // Skip if already updated
    if (updatedPackages.has(pkg.name)) {
      continue;
    }

    // Check if any workspace dependencies are being updated
    if (hasUpdatedDependencies(pkg, updatedPackages)) {
      // This package needs a patch bump because its dependencies changed
      allUpdates.push(createVersionUpdate(pkg, "patch", false));
      updatedPackages.add(pkg.name);
    }
  }

  return allUpdates;
}

/**
 * Pure function: Check if a package has any updated dependencies
 */
export function hasUpdatedDependencies(
  pkg: WorkspacePackage,
  updatedPackages: Set<string>,
): boolean {
  const allDeps = [
    ...pkg.workspaceDependencies,
    ...pkg.workspaceDevDependencies,
  ];

  return allDeps.some((dep) => updatedPackages.has(dep));
}

/**
 * Pure function: Get all workspace dependencies for a package
 */
export function getAllWorkspaceDependencies(pkg: WorkspacePackage): string[] {
  return [
    ...pkg.workspaceDependencies,
    ...pkg.workspaceDevDependencies,
  ];
}
