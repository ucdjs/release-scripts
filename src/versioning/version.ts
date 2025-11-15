import type { WorkspacePackage } from "#core/workspace";
import type { BumpKind, PackageJson, PackageRelease } from "#shared/types";
import type { GitCommit } from "commit-parser";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { selectVersionPrompt } from "#core/prompts";
import { isCI, logger } from "#shared/utils";
import { determineHighestBump } from "#versioning/commits";
import { buildPackageDependencyGraph, createDependentUpdates } from "#versioning/package";
import farver from "farver";

export function isValidSemver(version: string): boolean {
  // Basic semver validation: X.Y.Z with optional pre-release/build metadata
  const semverRegex = /^\d+\.\d+\.\d+(?:[-+].+)?$/;
  return semverRegex.test(version);
}

export function getNextVersion(currentVersion: string, bump: BumpKind): string {
  if (bump === "none") {
    logger.verbose(`No version bump needed, keeping version ${currentVersion}`);
    return currentVersion;
  }

  if (!isValidSemver(currentVersion)) {
    throw new Error(`Cannot bump version for invalid semver: ${currentVersion}`);
  }

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

  return `${newMajor}.${newMinor}.${newPatch}`;
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
  if (!isValidSemver(oldVersion) || !isValidSemver(newVersion)) {
    throw new Error(`Cannot calculate bump type for invalid semver: ${oldVersion} or ${newVersion}`);
  }

  const oldParts = oldVersion.split(".").map(Number);
  const newParts = newVersion.split(".").map(Number);

  if (newParts[0]! > oldParts[0]!) return "major";
  if (newParts[1]! > oldParts[1]!) return "minor";
  if (newParts[2]! > oldParts[2]!) return "patch";

  return "none";
}

const messageColorMap: Record<string, (c: string) => string> = {
  feat: farver.green,
  feature: farver.green,

  refactor: farver.cyan,
  style: farver.cyan,

  docs: farver.blue,
  doc: farver.blue,
  types: farver.blue,
  type: farver.blue,

  chore: farver.gray,
  ci: farver.gray,
  build: farver.gray,
  deps: farver.gray,
  dev: farver.gray,

  fix: farver.yellow,
  test: farver.yellow,

  perf: farver.magenta,

  revert: farver.red,
  breaking: farver.red,
};

function formatCommitsForDisplay(commits: GitCommit[]): string {
  if (commits.length === 0) {
    return farver.dim("No commits found");
  }

  const maxCommitsToShow = 10;
  const commitsToShow = commits.slice(0, maxCommitsToShow);
  const hasMore = commits.length > maxCommitsToShow;

  const typeLength = commits.map(({ type }) => type.length).reduce((a, b) => Math.max(a, b), 0);
  const scopeLength = commits.map(({ scope }) => scope.length).reduce((a, b) => Math.max(a, b), 0);

  const formattedCommits = commitsToShow.map((commit) => {
    let color = messageColorMap[commit.type] || ((c: string) => c);
    if (commit.isBreaking) {
      color = (s) => farver.inverse.red(s);
    }

    const paddedType = commit.type.padStart(typeLength + 1, " ");
    const paddedScope = !commit.scope
      ? " ".repeat(scopeLength ? scopeLength + 2 : 0)
      : farver.dim("(") + commit.scope + farver.dim(")") + " ".repeat(scopeLength - commit.scope.length);

    return [
      farver.dim(commit.shortHash),
      " ",
      color === farver.gray ? color(paddedType) : farver.bold(color(paddedType)),
      " ",
      paddedScope,
      farver.dim(":"),
      " ",
      color === farver.gray ? color(commit.description) : commit.description,
    ].join("");
  }).join("\n");

  if (hasMore) {
    return `${formattedCommits}\n  ${farver.dim(`... and ${commits.length - maxCommitsToShow} more commits`)}`;
  }

  return formattedCommits;
}

interface CalculateVersionUpdatesOptions {
  workspacePackages: WorkspacePackage[];
  packageCommits: Map<string, GitCommit[]>;
  workspaceRoot: string;
  showPrompt?: boolean;
  globalCommitsPerPackage: Map<string, GitCommit[]>;
}

/**
 * Calculate version updates for packages based on their commits
 */
async function calculateVersionUpdates({
  workspacePackages,
  packageCommits,
  workspaceRoot,
  showPrompt,
  globalCommitsPerPackage,
}: CalculateVersionUpdatesOptions): Promise<PackageRelease[]> {
  const versionUpdates: PackageRelease[] = [];
  const processedPackages = new Set<string>();

  logger.verbose(`Starting version inference for ${packageCommits.size} packages with commits`);

  // First pass: process packages with commits
  for (const [pkgName, pkgCommits] of packageCommits) {
    const pkg = workspacePackages.find((p) => p.name === pkgName);
    if (!pkg) {
      logger.error(`Package ${pkgName} not found in workspace packages, skipping`);
      continue;
    }

    processedPackages.add(pkgName);

    // Get this package's global commits
    const globalCommits = globalCommitsPerPackage.get(pkgName) || [];

    if (globalCommits.length > 0) {
      logger.verbose(`  - Global commits for this package: ${globalCommits.length}`);
    }

    // Combine package-specific commits with its global commits
    const allCommitsForPackage = [...pkgCommits, ...globalCommits];

    const bump = determineHighestBump(allCommitsForPackage);

    if (bump === "none") {
      continue;
    }

    let newVersion = getNextVersion(pkg.version, bump);

    if (!isCI && showPrompt) {
      // Display commits that are causing the version bump
      logger.section("📝 Commits affecting this package");
      const commitDisplay = formatCommitsForDisplay(allCommitsForPackage);
      const commitLines = commitDisplay.split("\n");
      commitLines.forEach((line) => logger.item(line));
      logger.emptyLine();

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

    logger.item(`Version update: ${pkg.version} → ${newVersion}`);

    versionUpdates.push({
      package: pkg,
      currentVersion: pkg.version,
      newVersion,
      bumpType: bump,
      hasDirectChanges: true,
    });
  }

  // Second pass: if prompts enabled and not in CI, allow manual bumps for packages without commits
  if (!isCI && showPrompt) {
    for (const pkg of workspacePackages) {
      // Skip packages we already processed
      if (processedPackages.has(pkg.name)) continue;

      logger.section(`📦 Package: ${pkg.name}`);
      logger.item("No direct commits found");

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

/**
 * Calculate version updates and prepare dependent updates
 * Returns both the updates and a function to apply them
 */
export async function calculateAndPrepareVersionUpdates({
  workspacePackages,
  packageCommits,
  workspaceRoot,
  showPrompt,
  globalCommitsPerPackage,
}: CalculateVersionUpdatesOptions): Promise<{
  allUpdates: PackageRelease[];
  applyUpdates: () => Promise<void>;
}> {
  // Calculate direct version updates
  const directUpdates = await calculateVersionUpdates({
    workspacePackages,
    packageCommits,
    workspaceRoot,
    showPrompt,
    globalCommitsPerPackage,
  });

  // Build dependency graph and calculate dependent updates
  const graph = buildPackageDependencyGraph(workspacePackages);
  const allUpdates = createDependentUpdates(graph, workspacePackages, directUpdates);

  // Create apply function that updates all package.json files
  const applyUpdates = async () => {
    await Promise.all(
      allUpdates.map(async (update: PackageRelease) => {
        const depUpdates = getDependencyUpdates(update.package, allUpdates);
        await updatePackageJson(
          update.package,
          update.newVersion,
          depUpdates,
        );
      }),
    );
  };

  return {
    allUpdates,
    applyUpdates,
  };
}

async function updatePackageJson(
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
      const oldVersion = packageJson.dependencies[depName];
      if (oldVersion === "workspace:*") {
        // Don't update workspace protocol dependencies
        // PNPM will handle this automatically
        logger.verbose(`  - Skipping workspace:* dependency: ${depName}`);
        continue;
      }

      packageJson.dependencies[depName] = `^${depVersion}`;
      logger.verbose(`  - Updated dependency ${depName}: ${oldVersion} → ^${depVersion}`);
    }

    if (packageJson.devDependencies?.[depName]) {
      const oldVersion = packageJson.devDependencies[depName];
      if (oldVersion === "workspace:*") {
        // Don't update workspace protocol dependencies
        // PNPM will handle this automatically
        logger.verbose(`  - Skipping workspace:* devDependency: ${depName}`);
        continue;
      }

      packageJson.devDependencies[depName] = `^${depVersion}`;
      logger.verbose(`  - Updated devDependency ${depName}: ${oldVersion} → ^${depVersion}`);
    }

    if (packageJson.peerDependencies?.[depName]) {
      const oldVersion = packageJson.peerDependencies[depName];
      if (oldVersion === "workspace:*") {
        // Don't update workspace protocol dependencies
        // PNPM will handle this automatically
        logger.verbose(`  - Skipping workspace:* peerDependency: ${depName}`);
        continue;
      }

      // For peer dependencies, use a looser range to avoid version conflicts
      // Match the major version to maintain compatibility
      const majorVersion = depVersion.split(".")[0];
      packageJson.peerDependencies[depName] = `>=${depVersion} <${Number(majorVersion) + 1}.0.0`;
      logger.verbose(`  - Updated peerDependency ${depName}: ${oldVersion} → ^${depVersion}`);
    }
  }

  // Write back with formatting
  const updated = `${JSON.stringify(packageJson, null, 2)}\n`;
  await writeFile(packageJsonPath, updated, "utf-8");
  logger.verbose(`  - Successfully wrote updated package.json`);
}

/**
 * Get all dependency updates needed for a package
 */
function getDependencyUpdates(
  pkg: WorkspacePackage,
  allUpdates: PackageRelease[],
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
      logger.verbose(`  - Dependency ${dep} will be updated: ${update.currentVersion} → ${update.newVersion} (${update.bumpType})`);
      updates.set(dep, update.newVersion);
    }
  }

  if (updates.size === 0) {
    logger.verbose(`  - No dependency updates needed`);
  }

  return updates;
}
