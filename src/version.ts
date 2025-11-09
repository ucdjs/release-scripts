import type { GitCommit } from "commit-parser";
import type { BumpKind, GlobalCommitMode, PackageJson, VersionUpdate } from "./types";
import type { WorkspacePackage } from "./workspace";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { combineWithGlobalCommits, determineHighestBump } from "./commits";
import { promptVersionOverride } from "./prompts";
import { isCI, logger } from "./utils";

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
  const newVersion = getNextVersion(pkg.version, bump);

  return {
    package: pkg,
    currentVersion: pkg.version,
    newVersion,
    bumpType: bump,
    hasDirectChanges,
  };
}

interface InferVersionUpdatesOptions {
  workspacePackages: WorkspacePackage[];
  packageCommits: Map<string, GitCommit[]>;
  workspaceRoot: string;
  allCommits: GitCommit[];
  showPrompt?: boolean;
  globalCommitMode?: GlobalCommitMode;
}

/**
 * Infer version updates from package commits with optional interactive overrides
 *
 * @returns Version updates for packages with changes
 */
export async function inferVersionUpdates({
  workspacePackages,
  packageCommits,
  allCommits,
  workspaceRoot,
  showPrompt,
  globalCommitMode,
}: InferVersionUpdatesOptions): Promise<VersionUpdate[]> {
  const versionUpdates: VersionUpdate[] = [];

  for (const [pkgName, pkgCommits] of packageCommits) {
    if (pkgCommits.length === 0) continue;

    const pkg = workspacePackages.find((p) => p.name === pkgName);
    if (!pkg) continue;

    // Combine package commits with global commits based on settings
    const commits = combineWithGlobalCommits(
      workspaceRoot,
      pkgCommits,
      allCommits,
      globalCommitMode,
    );

    const bump = determineHighestBump(commits);
    if (bump === "none") {
      logger.info(`No version bump needed for package ${pkg.name}`);
      continue;
    }

    let newVersion = getNextVersion(pkg.version, bump);

    if (!isCI && showPrompt) {
      newVersion = await promptVersionOverride(
        pkg,
        workspaceRoot,
        pkg.version,
        newVersion,
        bump,
      );
    }

    versionUpdates.push({
      package: pkg,
      currentVersion: pkg.version,
      newVersion,
      bumpType: bump,
      hasDirectChanges: true,
    });
  }

  return versionUpdates;
}

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
