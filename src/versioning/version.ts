import type { WorkspacePackage } from "#core/workspace";
import type { BumpKind, PackageJson, PackageRelease } from "#shared/types";
import type { GitCommit } from "commit-parser";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { selectVersionPrompt } from "#core/prompts";
import { isCI, logger } from "#shared/utils";
import { determineHighestBump } from "#versioning/commits";

export function isValidSemver(version: string): boolean {
  // Basic semver validation: X.Y.Z with optional pre-release/build metadata
  const semverRegex = /^\d+\.\d+\.\d+(?:[-+].+)?$/;
  return semverRegex.test(version);
}

export function validateSemver(version: string): void {
  if (!isValidSemver(version)) {
    throw new Error(`Invalid semver version: ${version}`);
  }
}

export function isValidBumpKind(bump: string): bump is BumpKind {
  return ["none", "patch", "minor", "major"].includes(bump);
}

export function validateBumpKind(bump: string): asserts bump is BumpKind {
  if (!isValidBumpKind(bump)) {
    throw new Error(`Invalid bump kind: ${bump}. Must be one of: none, patch, minor, major`);
  }
}

export function isValidPackageName(name: string): boolean {
  // NPM package name rules (simplified)
  // - Can contain lowercase letters, numbers, hyphens, underscores
  // - Can be scoped (@scope/name)
  const packageNameRegex = /^(?:@[a-z0-9_-][a-z0-9_.-]*\/)?[a-z0-9_-][a-z0-9_.-]*$/;
  return packageNameRegex.test(name);
}

export function validatePackageName(name: string): void {
  if (!isValidPackageName(name)) {
    throw new Error(`Invalid package name: ${name}`);
  }
}

export function validateNonEmpty<T>(
  array: T[],
  message: string,
): asserts array is [T, ...T[]] {
  if (array.length === 0) {
    throw new Error(message);
  }
}

export function validateNotNull<T>(
  value: T | null | undefined,
  message: string,
): asserts value is T {
  if (value === null || value === undefined) {
    throw new Error(message);
  }
}

export function getNextVersion(currentVersion: string, bump: BumpKind): string {
  if (bump === "none") {
    logger.log(`No version bump needed, keeping version ${currentVersion}`);
    return currentVersion;
  }

  validateSemver(currentVersion);

  // eslint-disable-next-line regexp/no-super-linear-backtracking
  const match = currentVersion.match(/^(\d+)\.(\d+)\.(\d+)(.*)$/);
  if (!match) {
    throw new Error(`Invalid semver version: ${currentVersion}`);
  }

  const [, major, minor, patch] = match;
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
  const newVersion = `${newMajor}.${newMinor}.${newPatch}`;
  logger.log(`Bumping version: ${currentVersion} → ${newVersion} (${bump})`);
  return newVersion;
}

/**
 * Create a version update object
 */
export function createVersionUpdate(
  pkg: WorkspacePackage,
  bump: BumpKind,
  hasDirectChanges: boolean,
): PackageRelease {
  const newVersion = getNextVersion(pkg.version, bump);

  return {
    package: pkg,
    currentVersion: pkg.version,
    newVersion,
    bumpType: bump,
    hasDirectChanges,
  };
}

function _calculateBumpType(oldVersion: string, newVersion: string): BumpKind {
  const oldParts = oldVersion.split(".").map(Number);
  const newParts = newVersion.split(".").map(Number);

  if (newParts[0]! > oldParts[0]!) return "major";
  if (newParts[1]! > oldParts[1]!) return "minor";
  if (newParts[2]! > oldParts[2]!) return "patch";

  return "none";
}

interface InferVersionUpdatesOptions {
  workspacePackages: WorkspacePackage[];
  packageCommits: Map<string, GitCommit[]>;
  workspaceRoot: string;
  showPrompt?: boolean;
  globalCommitsPerPackage: Map<string, GitCommit[]>;
}

export async function inferVersionUpdates({
  workspacePackages,
  packageCommits,
  workspaceRoot,
  showPrompt,
  globalCommitsPerPackage,
}: InferVersionUpdatesOptions): Promise<PackageRelease[]> {
  const versionUpdates: PackageRelease[] = [];
  const processedPackages = new Set<string>();

  logger.debug(`Starting version inference for ${packageCommits.size} packages with commits`);

  // First pass: process packages with commits
  for (const [pkgName, pkgCommits] of packageCommits) {
    logger.log("-------------");

    const pkg = workspacePackages.find((p) => p.name === pkgName);
    if (!pkg) {
      logger.error(`Package ${pkgName} not found in workspace packages, skipping`);
      continue;
    }

    processedPackages.add(pkgName);

    logger.log(`Processing package: ${pkg.name}`);
    logger.log(`  - Package-specific commits: ${pkgCommits.length}`);

    // Get this package's global commits
    const globalCommits = globalCommitsPerPackage.get(pkgName) || [];

    if (globalCommits.length > 0) {
      logger.log(`  - Global commits for this package: ${globalCommits.length}`);
    }

    // Combine package-specific commits with its global commits
    const allCommitsForPackage = [...pkgCommits, ...globalCommits];

    logger.log(`  - Total commits: ${allCommitsForPackage.length}`);

    const bump = determineHighestBump(allCommitsForPackage);
    logger.log(`  - Determined bump type: ${bump}`);

    if (bump === "none") {
      logger.info(`No version bump needed for package ${pkg.name}`);
      continue;
    }

    let newVersion = getNextVersion(pkg.version, bump);

    if (!isCI && showPrompt) {
      logger.debug(`\nPackage ${pkg.name} has changes requiring a ${bump} bump.`);
      const selectedVersion = await selectVersionPrompt(
        workspaceRoot,
        pkg,
        pkg.version,
        newVersion,
      );

      // User cancelled or skipped
      if (selectedVersion === null) {
        continue;
      }

      newVersion = selectedVersion;
    }

    logger.log(`  - Version update: ${pkg.version} → ${newVersion}`);

    versionUpdates.push({
      package: pkg,
      currentVersion: pkg.version,
      newVersion,
      bumpType: bump,
      hasDirectChanges: true,
    });
  }

  logger.debug(`Completed version inference. Total updates: ${versionUpdates.length}`);

  // Second pass: if prompts enabled and not in CI, allow manual bumps for packages without commits
  if (!isCI && showPrompt) {
    for (const pkg of workspacePackages) {
      // Skip packages we already processed
      if (processedPackages.has(pkg.name)) continue;

      // Prompt for manual version bump (suggested version is current = no change suggested)
      const newVersion = await selectVersionPrompt(
        workspaceRoot,
        pkg,
        pkg.version,
        pkg.version,
      );

      // User cancelled - stop prompting remaining packages
      if (newVersion === null) {
        break;
      }

      // Only add if user changed the version
      if (newVersion !== pkg.version) {
        const bumpType = _calculateBumpType(pkg.version, newVersion);

        versionUpdates.push({
          package: pkg,
          currentVersion: pkg.version,
          newVersion,
          bumpType,
          hasDirectChanges: false,
        });
      }
    }
  }

  return versionUpdates;
}

export async function updatePackageJson(
  pkg: WorkspacePackage,
  newVersion: string,
  dependencyUpdates: Map<string, string>,
): Promise<void> {
  const packageJsonPath = join(pkg.path, "package.json");

  logger.debug(`Updating package.json for ${pkg.name}`);
  logger.debug(`  - New version: ${newVersion}`);
  logger.debug(`  - Dependency updates to apply: ${dependencyUpdates.size}`);

  // Read current package.json
  const content = await readFile(packageJsonPath, "utf-8");
  const packageJson: PackageJson = JSON.parse(content);

  // Update version
  packageJson.version = newVersion;

  // Update workspace dependencies
  for (const [depName, depVersion] of dependencyUpdates) {
    if (packageJson.dependencies?.[depName]) {
      const oldVersion = packageJson.dependencies[depName];
      if (oldVersion === "workspace:*") {
        // Don't update workspace protocol dependencies
        // PNPM will handle this automatically
        logger.debug(`  - Skipping workspace:* dependency: ${depName}`);
        continue;
      }

      packageJson.dependencies[depName] = `^${depVersion}`;
      logger.debug(`  - Updated dependency ${depName}: ${oldVersion} → ^${depVersion}`);
    }

    if (packageJson.devDependencies?.[depName]) {
      const oldVersion = packageJson.devDependencies[depName];
      if (oldVersion === "workspace:*") {
        // Don't update workspace protocol dependencies
        // PNPM will handle this automatically
        logger.debug(`  - Skipping workspace:* devDependency: ${depName}`);
        continue;
      }

      packageJson.devDependencies[depName] = `^${depVersion}`;
      logger.debug(`  - Updated devDependency ${depName}: ${oldVersion} → ^${depVersion}`);
    }

    if (packageJson.peerDependencies?.[depName]) {
      const oldVersion = packageJson.peerDependencies[depName];
      if (oldVersion === "workspace:*") {
        // Don't update workspace protocol dependencies
        // PNPM will handle this automatically
        logger.debug(`  - Skipping workspace:* peerDependency: ${depName}`);
        continue;
      }

      // For peer dependencies, might want to use a different range
      // For now, use ^
      packageJson.peerDependencies[depName] = `^${depVersion}`;
      logger.debug(`  - Updated peerDependency ${depName}: ${oldVersion} → ^${depVersion}`);
    }
  }

  // Write back with formatting
  const updated = `${JSON.stringify(packageJson, null, 2)}\n`;
  await writeFile(packageJsonPath, updated, "utf-8");
  logger.debug(`  - Successfully wrote updated package.json`);
}

/**
 * Get all dependency updates needed for a package
 */
export function getDependencyUpdates(
  pkg: WorkspacePackage,
  allUpdates: PackageRelease[],
): Map<string, string> {
  const updates = new Map<string, string>();

  // Check all workspace dependencies
  const allDeps = [
    ...pkg.workspaceDependencies,
    ...pkg.workspaceDevDependencies,
  ];

  logger.debug(`Checking dependency updates for ${pkg.name}`);
  logger.debug(`  - Total workspace dependencies: ${allDeps.length}`);

  for (const dep of allDeps) {
    // Find if this dependency is being updated
    const update = allUpdates.find((u) => u.package.name === dep);
    if (update) {
      logger.debug(`  - Dependency ${dep} will be updated: ${update.currentVersion} → ${update.newVersion} (${update.bumpType})`);
      updates.set(dep, update.newVersion);
    }
  }

  if (updates.size === 0) {
    logger.debug(`  - No dependency updates needed`);
  } else {
    logger.debug(`  - Total dependency updates: ${updates.size}`);
  }

  return updates;
}
