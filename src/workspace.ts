import type {
  FindWorkspacePackagesOptions,
  PackageJson,
  ReleaseOptions,
} from "./types";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { run } from "./utils";

interface RawProject {
  name: string;
  path: string;
  version: string;
  private: boolean;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

export interface WorkspacePackage {
  name: string;
  version: string;
  path: string;
  packageJson: PackageJson;
  workspaceDependencies: string[];
  workspaceDevDependencies: string[];
}

export async function discoverPackages(
  workspaceRoot: string,
  options: ReleaseOptions,
): Promise<{
  workspacePackages: WorkspacePackage[];
  packagesToAnalyze: WorkspacePackage[];
}> {
  const { workspaceOptions, explicitPackages } = normalizePackageOptions(options.packages);

  const workspacePackages = await findWorkspacePackages(workspaceRoot, workspaceOptions);

  // If specific packages were requested, validate they were all found
  if (explicitPackages) {
    validatePackages(workspacePackages, explicitPackages);
  }

  // All found packages should be analyzed
  return {
    workspacePackages,
    packagesToAnalyze: workspacePackages,
  };
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

function normalizePackageOptions(
  packages: ReleaseOptions["packages"],
): { workspaceOptions: FindWorkspacePackagesOptions; explicitPackages?: string[] } {
  // Default: find all packages
  if (packages == null || packages === true) {
    return { workspaceOptions: { excludePrivate: false } };
  }

  // Array of package names: find all packages but filter to specific ones
  if (Array.isArray(packages)) {
    return {
      workspaceOptions: { excludePrivate: false, included: packages },
      explicitPackages: packages,
    };
  }

  // Already in the correct format
  return { workspaceOptions: packages };
}

/**
 * Validate that all explicitly requested packages were found
 */
function validatePackages(
  found: WorkspacePackage[],
  requested: string[],
): void {
  const foundNames = new Set(found.map((p) => p.name));
  const missing = requested.filter((p) => !foundNames.has(p));

  if (missing.length > 0) {
    throw new Error(`Packages not found in workspace: ${missing.join(", ")}`);
  }
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
