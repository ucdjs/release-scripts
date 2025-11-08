import type {
  DependencyGraph,
  FindWorkspacePackagesOptions,
  PackageJson,
  PackageUpdateOrder,
  WorkspacePackage,
} from "./types";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createDebugger } from "./logger";
import { run } from "./utils";

const debug = createDebugger("ucdjs:release-scripts:workspace");

interface RawProject {
  name: string;
  path: string;
  version: string;
  private: boolean;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
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
      debug?.(`Excluding package ${rawProject.name}`);
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

function extractWorkspaceDependencies(
  dependencies: Record<string, string> | undefined,
  workspacePackages: Set<string>,
): string[] {
  if (!dependencies) return [];

  return Object.keys(dependencies).filter((dep) => {
    return workspacePackages.has(dep);
  });
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
