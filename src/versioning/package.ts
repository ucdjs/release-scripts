import type { WorkspacePackage } from "#core/workspace";
import type {
  PackageRelease,
  PackageUpdateOrder,
} from "#shared/types";
import { createVersionUpdate } from "#operations/version";
import { logger } from "#shared/utils";

interface PackageDependencyGraph {
  packages: Map<string, WorkspacePackage>;
  dependents: Map<string, Set<string>>;
}

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
export function buildPackageDependencyGraph(
  packages: WorkspacePackage[],
): PackageDependencyGraph {
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
 * Get all packages affected by changes (including transitive dependents)
 *
 * Uses graph traversal to find all packages that need updates:
 * - Packages with direct changes
 * - All packages that depend on changed packages (transitively)
 *
 * @param graph - Dependency graph
 * @param changedPackages - Set of package names with direct changes
 * @returns Set of all package names that need updates
 */
export function getAllAffectedPackages(
  graph: PackageDependencyGraph,
  changedPackages: Set<string>,
): Set<string> {
  const affected = new Set<string>();

  function visitDependents(pkgName: string) {
    if (affected.has(pkgName)) return;
    affected.add(pkgName);

    const dependents = graph.dependents.get(pkgName);
    if (dependents) {
      for (const dependent of dependents) {
        visitDependents(dependent);
      }
    }
  }

  // Start traversal from each changed package
  for (const pkg of changedPackages) {
    visitDependents(pkg);
  }

  return affected;
}

/**
 * Calculate the order in which packages should be published
 *
 * Performs topological sorting to ensure dependencies are published before dependents.
 * Assigns a "level" to each package based on its depth in the dependency tree.
 *
 * This is used by the publish command to publish packages in the correct order.
 *
 * @param graph - Dependency graph
 * @param packagesToPublish - Set of package names to publish
 * @returns Array of packages in publish order with their dependency level
 */
export function getPackagePublishOrder(
  graph: PackageDependencyGraph,
  packagesToPublish: Set<string>,
): PackageUpdateOrder[] {
  const result: PackageUpdateOrder[] = [];
  const visited = new Set<string>();
  const toUpdate = new Set(packagesToPublish);

  const packagesToProcess = new Set(packagesToPublish);
  for (const pkg of packagesToPublish) {
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
 * @param graph - Dependency graph
 * @param workspacePackages - All workspace packages
 * @param directUpdates - Packages with direct code changes
 * @returns All updates including dependent packages that need patch bumps
 */
export function createDependentUpdates(
  graph: PackageDependencyGraph,
  workspacePackages: WorkspacePackage[],
  directUpdates: PackageRelease[],
): PackageRelease[] {
  const allUpdates = [...directUpdates];
  const directUpdateMap = new Map(directUpdates.map((u) => [u.package.name, u]));
  const changedPackages = new Set(directUpdates.map((u) => u.package.name));

  // Get all packages affected by changes (including transitive dependents)
  const affectedPackages = getAllAffectedPackages(graph, changedPackages);

  // Create updates for packages that don't have direct updates
  for (const pkgName of affectedPackages) {
    logger.verbose(`Processing affected package: ${pkgName}`);
    // Skip if already has a direct update
    if (directUpdateMap.has(pkgName)) {
      logger.verbose(`Skipping ${pkgName}, already has a direct update`);
      continue;
    }

    const pkg = workspacePackages.find((p) => p.name === pkgName);
    if (!pkg) continue;

    // This package needs a patch bump because its dependencies changed
    allUpdates.push(createVersionUpdate(pkg, "patch", false));
  }

  return allUpdates;
}
