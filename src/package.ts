import type {
  DependencyGraph,
  PackageUpdateOrder,
  VersionUpdate,
  WorkspacePackage,
} from "./types";
import { createVersionUpdate } from "./version";

/**
 * Build a dependency graph from workspace packages
 *
 * Creates a bidirectional graph that maps:
 * - packages: Map of package name → WorkspacePackage
 * - dependents: Map of package name → Set of packages that depend on it
 *
 * @param packages - All workspace packages
 * @returns Dependency graph with packages and dependents maps
 */
export function buildDependencyGraph(
  packages: WorkspacePackage[],
): DependencyGraph {
  const packagesMap = new Map<string, WorkspacePackage>();
  const dependents = new Map<string, Set<string>>();

  for (const pkg of packages) {
    packagesMap.set(pkg.name, pkg);
    dependents.set(pkg.name, new Set());
  }

  for (const pkg of packages) {
    const allDeps = [
      ...pkg.workspaceDependencies,
      ...pkg.workspaceDevDependencies,
    ];

    for (const dep of allDeps) {
      const depSet = dependents.get(dep);
      if (depSet) {
        depSet.add(pkg.name);
      }
    }
  }

  return {
    packages: packagesMap,
    dependents,
  };
}

/**
 * Calculate the order in which packages should be updated based on dependencies
 *
 * Performs topological sorting to ensure dependencies are updated before dependents.
 * Assigns a "level" to each package based on its depth in the dependency tree.
 *
 * @param graph - Dependency graph
 * @param changedPackages - Set of package names with direct changes
 * @returns Array of packages in update order with their dependency level
 */
export function getPackageUpdateOrder(
  graph: DependencyGraph,
  changedPackages: Set<string>,
): PackageUpdateOrder[] {
  const result: PackageUpdateOrder[] = [];
  const visited = new Set<string>();
  const toUpdate = new Set(changedPackages);

  const packagesToProcess = new Set(changedPackages);
  for (const pkg of changedPackages) {
    const deps = graph.dependents.get(pkg);
    if (deps) {
      for (const dep of deps) {
        packagesToProcess.add(dep);
        toUpdate.add(dep);
      }
    }
  }

  function visit(pkgName: string, level: number) {
    if (visited.has(pkgName)) return;
    visited.add(pkgName);

    const pkg = graph.packages.get(pkgName);
    if (!pkg) return;

    const allDeps = [
      ...pkg.workspaceDependencies,
      ...pkg.workspaceDevDependencies,
    ];

    let maxDepLevel = level;
    for (const dep of allDeps) {
      if (toUpdate.has(dep)) {
        visit(dep, level);
        const depResult = result.find((r) => r.package.name === dep);
        if (depResult && depResult.level >= maxDepLevel) {
          maxDepLevel = depResult.level + 1;
        }
      }
    }

    result.push({ package: pkg, level: maxDepLevel });
  }

  for (const pkg of toUpdate) {
    visit(pkg, 0);
  }

  result.sort((a, b) => a.level - b.level);

  return result;
}

/**
 * Create version updates for all packages affected by dependency changes
 *
 * When a package is updated, all packages that depend on it should also be updated.
 * This function calculates which additional packages need patch bumps due to dependency changes.
 *
 * @param updateOrder - Packages in topological order with their dependency levels
 * @param directUpdates - Packages with direct code changes
 * @returns All updates including dependent packages that need patch bumps
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
 * Check if a package has any workspace dependencies that are being updated
 *
 * @param pkg - Package to check
 * @param updatedPackages - Set of package names being updated
 * @returns True if any of the package's workspace dependencies are being updated
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
