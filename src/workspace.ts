import type {
  DependencyGraph,
  FindWorkspacePackagesOptions,
  PackageJson,
  PackageUpdateOrder,
  VersionUpdate,
  WorkspacePackage,
} from "./types";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { run } from "./utils";
import { createVersionUpdate } from "./version";

interface RawProject {
  name: string;
  path: string;
  version: string;
  private: boolean;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

export async function findWorkspacePackages(
  workspaceRoot: string,
  options?: FindWorkspacePackagesOptions,
): Promise<WorkspacePackage[]> {
  const result = await run("pnpm", ["-r", "ls", "--json"], {
    nodeOptions: {
      cwd: workspaceRoot,
      stdio: "pipe",
    },
  });

  const rawProjects: RawProject[] = JSON.parse(result.stdout);

  const packages: WorkspacePackage[] = [];
  const allPackageNames = new Set<string>(rawProjects.map((p) => p.name));

  for (const rawProject of rawProjects) {
    const packageJsonPath = join(rawProject.path, "package.json");
    const content = await readFile(packageJsonPath, "utf-8");
    const packageJson: PackageJson = JSON.parse(content);

    if (!shouldIncludePackage(packageJson, options)) {
      console.log(`Excluding package ${rawProject.name}`);
      continue;
    }

    const workspaceDeps = extractWorkspaceDependencies(
      rawProject.dependencies,
      allPackageNames,
    );
    const workspaceDevDeps = extractWorkspaceDependencies(
      rawProject.devDependencies,
      allPackageNames,
    );

    packages.push({
      name: rawProject.name,
      version: rawProject.version,
      path: rawProject.path,
      packageJson,
      workspaceDependencies: workspaceDeps,
      workspaceDevDependencies: workspaceDevDeps,
    });
  }

  return packages;
}

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

export function getAllDependents(
  graph: DependencyGraph,
  packageName: string,
): Set<string> {
  const result = new Set<string>();
  const visited = new Set<string>();

  function visit(pkg: string) {
    if (visited.has(pkg)) return;
    visited.add(pkg);

    const deps = graph.dependents.get(pkg);
    if (deps) {
      for (const dep of deps) {
        result.add(dep);
        visit(dep);
      }
    }
  }

  visit(packageName);
  return result;
}

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

function shouldIncludePackage(
  pkg: PackageJson,
  options?: FindWorkspacePackagesOptions,
): boolean {
  if (!options) {
    return true;
  }

  // Check if private packages should be excluded
  if (options.excludePrivate && pkg.private) {
    return false;
  }

  // Check include list (if specified, only these packages are included)
  if (options.included && options.included.length > 0) {
    if (!options.included.includes(pkg.name)) {
      return false;
    }
  }

  // Check exclude list
  if (options.excluded?.includes(pkg.name)) {
    return false;
  }

  return true;
}

function extractWorkspaceDependencies(
  dependencies: Record<string, string> | undefined,
  workspacePackages: Set<string>,
): string[] {
  if (!dependencies) return [];

  return Object.keys(dependencies).filter((dep) => {
    return workspacePackages.has(dep);
  });
}
