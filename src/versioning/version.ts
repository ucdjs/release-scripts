import type { WorkspacePackage } from "#core/workspace";
import type { BumpKind, PackageJson, PackageRelease } from "#shared/types";
import type { GitCommit } from "commit-parser";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { selectVersionPrompt } from "#core/prompts";
import { calculateBumpType, getNextVersion } from "#operations/semver";
import { determineHighestBump } from "#operations/version";
import { isCI, logger } from "#shared/utils";
import { buildPackageDependencyGraph, createDependentUpdates } from "#versioning/package";
import farver from "farver";

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
  const scopeLength = commits.map(({ scope }) => scope?.length).reduce((a, b) => Math.max(a || 0, b || 0), 0) || 0;

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

export interface VersionOverride {
  type: BumpKind;
  version: string;
}

export type VersionOverrides = Record<string, VersionOverride>;

interface CalculateVersionUpdatesOptions {
  workspacePackages: WorkspacePackage[];
  packageCommits: Map<string, GitCommit[]>;
  workspaceRoot: string;
  showPrompt?: boolean;
  globalCommitsPerPackage: Map<string, GitCommit[]>;
  overrides?: VersionOverrides;
}

async function calculateVersionUpdates({
  workspacePackages,
  packageCommits,
  workspaceRoot,
  showPrompt,
  globalCommitsPerPackage,
  overrides: initialOverrides = {},
}: CalculateVersionUpdatesOptions): Promise<{
  updates: PackageRelease[];
  overrides: VersionOverrides;
}> {
  const versionUpdates: PackageRelease[] = [];
  const processedPackages = new Set<string>();
  const newOverrides: VersionOverrides = { ...initialOverrides };

  const bumpRanks: Record<BumpKind, number> = { major: 3, minor: 2, patch: 1, none: 0 };

  logger.verbose(`Starting version inference for ${packageCommits.size} packages with commits`);

  // First pass: process packages with commits
  for (const [pkgName, pkgCommits] of packageCommits) {
    const pkg = workspacePackages.find((p) => p.name === pkgName);
    if (!pkg) {
      logger.error(`Package ${pkgName} not found in workspace packages, skipping`);
      continue;
    }

    processedPackages.add(pkgName);

    const globalCommits = globalCommitsPerPackage.get(pkgName) || [];
    const allCommitsForPackage = [...pkgCommits, ...globalCommits];

    const determinedBump = determineHighestBump(allCommitsForPackage);
    const override = newOverrides[pkgName];
    const effectiveBump = override?.type || determinedBump;
    const canPrompt = !isCI && showPrompt;

    if (effectiveBump === "none" && !canPrompt) {
      continue;
    }

    let newVersion = override?.version || getNextVersion(pkg.version, effectiveBump);
    let finalBumpType: BumpKind = effectiveBump;

    if (canPrompt) {
      logger.clearScreen();
      logger.section(`📝 Commits for ${farver.cyan(pkg.name)}`);
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

      if (selectedVersion === null) continue;

      const userBump = calculateBumpType(pkg.version, selectedVersion);
      finalBumpType = userBump;

      if (selectedVersion === pkg.version) {
        // Persist explicit "as-is" only when automatic bump exists.
        // Prompted reruns can still change this because we don't short-circuit when prompting.
        if (determinedBump !== "none") {
          newOverrides[pkgName] = { type: "none", version: pkg.version };
          logger.info(`Version override recorded for ${pkgName}: ${determinedBump} → none`);
        } else if (newOverrides[pkgName]) {
          delete newOverrides[pkgName];
          logger.info(`Version override removed for ${pkgName}.`);
        }
        continue;
      }

      if (bumpRanks[userBump] < bumpRanks[determinedBump]) {
        newOverrides[pkgName] = { type: userBump, version: selectedVersion };
        logger.info(`Version override recorded for ${pkgName}: ${determinedBump} → ${userBump}`);
      } else if (newOverrides[pkgName] && bumpRanks[userBump] >= bumpRanks[determinedBump]) {
        // If the user manually selects a version that's NOT a downgrade,
        // remove any existing override for that package.
        delete newOverrides[pkgName];
        logger.info(`Version override removed for ${pkgName}.`);
      }

      newVersion = selectedVersion;
    }

    versionUpdates.push({
      package: pkg,
      currentVersion: pkg.version,
      newVersion,
      bumpType: finalBumpType,
      hasDirectChanges: allCommitsForPackage.length > 0,
    });
  }

  // Second pass for manual bumps (if not in verify mode)
  if (!isCI && showPrompt) {
    for (const pkg of workspacePackages) {
      if (processedPackages.has(pkg.name)) continue;

      logger.clearScreen();
      logger.section(`📦 Package: ${pkg.name}`);
      logger.item("No direct commits found");

      const newVersion = await selectVersionPrompt(workspaceRoot, pkg, pkg.version, pkg.version);
      if (newVersion === null) break;

      if (newVersion !== pkg.version) {
        const bumpType = calculateBumpType(pkg.version, newVersion);
        versionUpdates.push({
          package: pkg,
          currentVersion: pkg.version,
          newVersion,
          bumpType,
          hasDirectChanges: false,
        });
        // We don't record an override here as there was no automatic bump to override.
      }
    }
  }

  return { updates: versionUpdates, overrides: newOverrides };
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
  overrides,
}: CalculateVersionUpdatesOptions): Promise<{
  allUpdates: PackageRelease[];
  applyUpdates: () => Promise<void>;
  overrides: VersionOverrides;
}> {
  // Calculate direct version updates
  const { updates: directUpdates, overrides: newOverrides } = await calculateVersionUpdates({
    workspacePackages,
    packageCommits,
    workspaceRoot,
    showPrompt,
    globalCommitsPerPackage,
    overrides,
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
    overrides: newOverrides,
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

  function updateDependency(
    deps: Record<string, string> | undefined,
    depName: string,
    depVersion: string,
    isPeerDependency = false,
  ): void {
    if (!deps) return;

    const oldVersion = deps[depName];
    if (!oldVersion) return;

    if (oldVersion === "workspace:*") {
      // Don't update workspace protocol dependencies
      // PNPM will handle this automatically
      logger.verbose(`  - Skipping workspace:* dependency: ${depName}`);
      return;
    }

    if (isPeerDependency) {
      // For peer dependencies, use a looser range to avoid version conflicts
      // Match the major version to maintain compatibility
      const majorVersion = depVersion.split(".")[0];
      deps[depName] = `>=${depVersion} <${Number(majorVersion) + 1}.0.0`;
    } else {
      deps[depName] = `^${depVersion}`;
    }

    logger.verbose(`  - Updated dependency ${depName}: ${oldVersion} → ${deps[depName]}`);
  }

  // Update workspace dependencies
  for (const [depName, depVersion] of dependencyUpdates) {
    updateDependency(packageJson.dependencies, depName, depVersion);
    updateDependency(packageJson.devDependencies, depName, depVersion);
    updateDependency(packageJson.peerDependencies, depName, depVersion, true);
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
