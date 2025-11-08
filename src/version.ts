import type { BumpKind, PackageJson, VersionUpdate, WorkspacePackage } from "./types";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { validateSemver } from "./validation";

/**
 * Calculate the new version based on current version and bump type
 * Pure function - no side effects, easily testable
 */
export function calculateNewVersion(currentVersion: string, bump: BumpKind): string {
  if (bump === "none") {
    return currentVersion;
  }

  // Validate input
  validateSemver(currentVersion);

  // Parse semantic version
  // eslint-disable-next-line regexp/no-super-linear-backtracking
  const match = currentVersion.match(/^(\d+)\.(\d+)\.(\d+)(.*)$/);
  if (!match) {
    throw new Error(`Invalid semver version: ${currentVersion}`);
  }

  // eslint-disable-next-line unused-imports/no-unused-vars
  const [, major, minor, patch, suffix] = match;
  let newMajor = Number.parseInt(major!, 10);
  let newMinor = Number.parseInt(minor!, 10);
  let newPatch = Number.parseInt(patch!, 10);

  switch (bump) {
    case "major":
      newMajor += 1;
      newMinor = 0;
      newPatch = 0;
      break;

    case "minor":
      newMinor += 1;
      newPatch = 0;
      break;

    case "patch":
      newPatch += 1;
      break;
  }

  // Remove any pre-release/build metadata when bumping
  return `${newMajor}.${newMinor}.${newPatch}`;
}

/**
 * Create a version update object
 */
export function createVersionUpdate(
  pkg: WorkspacePackage,
  bump: BumpKind,
  hasDirectChanges: boolean,
): VersionUpdate {
  const newVersion = calculateNewVersion(pkg.version, bump);

  return {
    package: pkg,
    currentVersion: pkg.version,
    newVersion,
    bumpType: bump,
    hasDirectChanges,
  };
}

/**
 * Update a package.json file with new version and dependency versions
 */
export async function updatePackageJson(
  pkg: WorkspacePackage,
  newVersion: string,
  dependencyUpdates: Map<string, string>,
): Promise<void> {
  const packageJsonPath = join(pkg.path, "package.json");

  // Read current package.json
  const content = await readFile(packageJsonPath, "utf-8");
  const packageJson: PackageJson = JSON.parse(content);

  // Update version
  packageJson.version = newVersion;

  // Update workspace dependencies
  for (const [depName, depVersion] of dependencyUpdates) {
    if (packageJson.dependencies?.[depName]) {
      if (packageJson.dependencies[depName] === "workspace:*") {
        // Don't update workspace protocol dependencies
        // PNPM will handle this automatically
        continue;
      }

      packageJson.dependencies[depName] = `^${depVersion}`;
    }

    if (packageJson.devDependencies?.[depName]) {
      if (packageJson.devDependencies[depName] === "workspace:*") {
        // Don't update workspace protocol dependencies
        // PNPM will handle this automatically
        continue;
      }

      packageJson.devDependencies[depName] = `^${depVersion}`;
    }

    if (packageJson.peerDependencies?.[depName]) {
      if (packageJson.peerDependencies[depName] === "workspace:*") {
        // Don't update workspace protocol dependencies
        // PNPM will handle this automatically
        continue;
      }

      // For peer dependencies, might want to use a different range
      // For now, use ^
      packageJson.peerDependencies[depName] = `^${depVersion}`;
    }
  }

  // Write back with formatting
  const updated = `${JSON.stringify(packageJson, null, 2)}\n`;
  await writeFile(packageJsonPath, updated, "utf-8");
}

/**
 * Get all dependency updates needed for a package
 */
export function getDependencyUpdates(
  pkg: WorkspacePackage,
  allUpdates: VersionUpdate[],
): Map<string, string> {
  const updates = new Map<string, string>();

  // Check all workspace dependencies
  const allDeps = [
    ...pkg.workspaceDependencies,
    ...pkg.workspaceDevDependencies,
  ];

  for (const dep of allDeps) {
    // Find if this dependency is being updated
    const update = allUpdates.find((u) => u.package.name === dep);
    if (update) {
      updates.set(dep, update.newVersion);
    }
  }

  return updates;
}
