import type {
  FindWorkspacePackagesOptions,
  PackageJson,
  ReleaseOptions,
} from "./types";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import farver from "farver";
import { selectPackagePrompt } from "./prompts";
import { isCI, logger, run } from "./utils";

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

export async function discoverWorkspacePackages(
  workspaceRoot: string,
  options: ReleaseOptions,
): Promise<{
  workspacePackages: WorkspacePackage[];
  packagesToAnalyze: WorkspacePackage[];
}> {
  let workspaceOptions: FindWorkspacePackagesOptions;
  let explicitPackages: string[] | undefined;

  // Normalize package options and determine if packages were explicitly specified
  if (options.packages == null || options.packages === true) {
    workspaceOptions = { excludePrivate: false };
  } else if (Array.isArray(options.packages)) {
    workspaceOptions = { excludePrivate: false, included: options.packages };
    explicitPackages = options.packages;
  } else {
    workspaceOptions = options.packages;
    if (options.packages.included) {
      explicitPackages = options.packages.included;
    }
  }

  const workspacePackages = await findWorkspacePackages(
    workspaceRoot,
    workspaceOptions,
  );

  // If specific packages were requested, validate they were all found
  if (explicitPackages) {
    const foundNames = new Set(workspacePackages.map((p) => p.name));
    const missing = explicitPackages.filter((p) => !foundNames.has(p));

    if (missing.length > 0) {
      throw new Error(`Packages not found in workspace: ${missing.join(", ")}`);
    }
  }

  let packagesToAnalyze = workspacePackages;

  // Show interactive prompt only if:
  // 1. Not in CI
  // 2. Prompt is enabled
  // 3. No explicit packages were specified (user didn't pre-select specific packages)
  const isPackagePromptEnabled = options.prompts?.packages !== false;
  if (!isCI && isPackagePromptEnabled && !explicitPackages) {
    const selectedNames = await selectPackagePrompt(workspacePackages);
    packagesToAnalyze = workspacePackages.filter((pkg) =>
      selectedNames.includes(pkg.name),
    );
  }

  return {
    workspacePackages,
    packagesToAnalyze,
  };
}

async function findWorkspacePackages(
  workspaceRoot: string,
  options?: FindWorkspacePackagesOptions,
): Promise<WorkspacePackage[]> {
  try {
    const result = await run("pnpm", ["-r", "ls", "--json"], {
      nodeOptions: {
        cwd: workspaceRoot,
        stdio: "pipe",
      },
    });

    const rawProjects: RawProject[] = JSON.parse(result.stdout);

    const allPackageNames = new Set<string>(rawProjects.map((p) => p.name));
    const excludedPackages = new Set<string>();

    const promises = rawProjects.map(async (rawProject) => {
      const packageJsonPath = join(rawProject.path, "package.json");
      const content = await readFile(packageJsonPath, "utf-8");
      const packageJson: PackageJson = JSON.parse(content);

      if (!shouldIncludePackage(packageJson, options)) {
        excludedPackages.add(rawProject.name);
        return null;
      }

      return {
        name: rawProject.name,
        version: rawProject.version,
        path: rawProject.path,
        packageJson,
        workspaceDependencies: extractWorkspaceDependencies(
          rawProject.dependencies,
          allPackageNames,
        ),
        workspaceDevDependencies: extractWorkspaceDependencies(
          rawProject.devDependencies,
          allPackageNames,
        ),
      };
    });

    const packages = await Promise.all(promises);

    if (excludedPackages.size > 0) {
      logger.info(`Excluded packages: ${farver.green(
        Array.from(excludedPackages).join(", "),
      )}`);
    }

    // Filter out excluded packages (nulls)
    return packages.filter(
      (pkg): pkg is WorkspacePackage => pkg !== null,
    );
  } catch (err) {
    logger.error("Error discovering workspace packages:", err);
    throw err;
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
