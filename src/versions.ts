import { join } from "node:path";

import { PromptService } from "./services/prompts";
import { Effect, FileSystem } from "effect";
import type { WorkspacePackage } from "./services/workspace";
import type { BumpKind, PackageJson, PackageRelease } from "./types";
import { getIsCI, logger } from "./errors";
import { buildPackageDependencyGraph, createDependentUpdates } from "./packages";
import type { GitCommit } from "commit-parser";
import farver from "farver";
import semver from "semver";

export function isValidSemver(version: string): boolean {
  return semver.valid(version) != null;
}

export function getPrereleaseIdentifier(version: string): string | undefined {
  const parsed = semver.parse(version);
  if (!parsed || parsed.prerelease.length === 0) {
    return undefined;
  }

  const identifier = parsed.prerelease[0];
  return typeof identifier === "string" ? identifier : undefined;
}

export function getNextVersion(currentVersion: string, bump: BumpKind): string {
  if (bump === "none") {
    return currentVersion;
  }

  if (!isValidSemver(currentVersion)) {
    throw new Error(`Cannot bump version for invalid semver: ${currentVersion}`);
  }

  if (semver.prerelease(currentVersion)) {
    const identifier = getPrereleaseIdentifier(currentVersion);
    const next = identifier
      ? semver.inc(currentVersion, "prerelease", identifier)
      : semver.inc(currentVersion, "prerelease");
    if (!next) {
      throw new Error(`Failed to bump prerelease version ${currentVersion}`);
    }
    return next;
  }

  const next = semver.inc(currentVersion, bump);
  if (!next) {
    throw new Error(`Failed to bump version ${currentVersion} with bump ${bump}`);
  }

  return next;
}

export function getNextStableVersion(
  currentVersion: string,
  bump: Exclude<BumpKind, "none">,
): string {
  if (!isValidSemver(currentVersion)) {
    throw new Error(`Cannot bump version for invalid semver: ${currentVersion}`);
  }

  const next = semver.inc(currentVersion, bump);
  if (!next) {
    throw new Error(`Failed to bump version ${currentVersion} with bump ${bump}`);
  }

  return next;
}

export function calculateBumpType(oldVersion: string, newVersion: string): BumpKind {
  if (!isValidSemver(oldVersion) || !isValidSemver(newVersion)) {
    throw new Error(
      `Cannot calculate bump type for invalid semver: ${oldVersion} or ${newVersion}`,
    );
  }

  const diff = semver.diff(oldVersion, newVersion);
  if (!diff) {
    return "none";
  }

  if (diff === "major" || diff === "premajor") return "major";
  if (diff === "minor" || diff === "preminor") return "minor";
  if (diff === "patch" || diff === "prepatch" || diff === "prerelease") return "patch";

  if (semver.gt(newVersion, oldVersion)) {
    return "patch";
  }

  return "none";
}

export function getNextPrereleaseVersion(
  currentVersion: string,
  mode: "next" | "prepatch" | "preminor" | "premajor",
  identifier?: string,
): string {
  if (!isValidSemver(currentVersion)) {
    throw new Error(`Cannot bump prerelease for invalid semver: ${currentVersion}`);
  }

  const releaseType = mode === "next" ? "prerelease" : mode;
  const next = identifier
    ? semver.inc(currentVersion, releaseType, identifier)
    : semver.inc(currentVersion, releaseType);
  if (!next) {
    throw new Error(`Failed to compute prerelease version for ${currentVersion}`);
  }

  return next;
}

export function determineHighestBump(commits: GitCommit[]): BumpKind {
  if (commits.length === 0) {
    return "none";
  }

  let highestBump: BumpKind = "none";

  for (const commit of commits) {
    const bump = determineBumpType(commit);

    if (bump === "major") {
      return "major";
    }

    if (bump === "minor") {
      highestBump = "minor";
    } else if (bump === "patch" && highestBump === "none") {
      highestBump = "patch";
    }
  }

  return highestBump;
}

export function createVersionUpdate(
  pkg: WorkspacePackage,
  bump: BumpKind,
  hasDirectChanges: boolean,
): PackageRelease {
  return {
    package: pkg,
    currentVersion: pkg.version,
    newVersion: getNextVersion(pkg.version, bump),
    bumpType: bump,
    hasDirectChanges,
    changeKind: "dependent",
  };
}

function determineBumpType(commit: GitCommit): BumpKind {
  if (!commit.isConventional) {
    return "none";
  }

  if (commit.isBreaking) {
    return "major";
  }

  if (commit.type === "feat") {
    return "minor";
  }

  if (commit.type === "fix" || commit.type === "perf") {
    return "patch";
  }

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
  const scopeLength =
    commits.map(({ scope }) => scope?.length).reduce((a, b) => Math.max(a || 0, b || 0), 0) || 0;

  const formattedCommits = commitsToShow
    .map((commit) => {
      let color = messageColorMap[commit.type] || ((c: string) => c);
      if (commit.isBreaking) {
        color = (s) => farver.inverse.red(s);
      }

      const paddedType = commit.type.padStart(typeLength + 1, " ");
      const paddedScope = !commit.scope
        ? " ".repeat(scopeLength ? scopeLength + 2 : 0)
        : farver.dim("(") +
          commit.scope +
          farver.dim(")") +
          " ".repeat(scopeLength - commit.scope.length);

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
    })
    .join("\n");

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

/**
 * Pure function that resolves version bump from commits and overrides.
 * No IO, no prompts - fully testable in isolation.
 */
export function resolveAutoVersion(
  pkg: WorkspacePackage,
  packageCommits: GitCommit[],
  globalCommits: GitCommit[],
  override?: VersionOverride,
): {
  determinedBump: BumpKind;
  effectiveBump: BumpKind;
  autoVersion: string;
  resolvedVersion: string;
} {
  const allCommits = [...packageCommits, ...globalCommits];
  const determinedBump = determineHighestBump(allCommits);
  const effectiveBump = override?.type || determinedBump;
  const autoVersion = getNextVersion(pkg.version, determinedBump);
  const resolvedVersion = override?.version || autoVersion;

  return { determinedBump, effectiveBump, autoVersion, resolvedVersion };
}

/**
 * Pure function that computes the new dependency range.
 * Returns null if the dependency should not be updated (e.g. workspace:*).
 */
export function computeDependencyRange(
  currentRange: string,
  newVersion: string,
  isPeerDependency: boolean,
): string | null {
  if (currentRange === "workspace:*") {
    return null;
  }

  if (isPeerDependency) {
    const majorVersion = newVersion.split(".")[0];
    return `>=${newVersion} <${Number(majorVersion) + 1}.0.0`;
  }

  return `^${newVersion}`;
}

interface CalculateVersionUpdatesOptions {
  workspacePackages: WorkspacePackage[];
  packageCommits: Map<string, GitCommit[]>;
  workspaceRoot: string;
  showPrompt?: boolean;
  globalCommitsPerPackage: Map<string, GitCommit[]>;
  overrides?: VersionOverrides;
}

const calculateVersionUpdatesEffect = Effect.fn("calculateVersionUpdatesEffect")(function* ({
  workspacePackages,
  packageCommits,
  workspaceRoot,
  showPrompt,
  globalCommitsPerPackage,
  overrides: initialOverrides = {},
}: CalculateVersionUpdatesOptions) {
  const prompts = yield* PromptService;
  const versionUpdates: PackageRelease[] = [];
  const processedPackages = new Set<string>();
  const newOverrides: VersionOverrides = { ...initialOverrides };
  const excludedPackages = new Set<string>();

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

    const override = newOverrides[pkgName];
    const { determinedBump, effectiveBump, autoVersion, resolvedVersion } = resolveAutoVersion(
      pkg,
      pkgCommits,
      globalCommits,
      override,
    );
    const canPrompt = !getIsCI() && showPrompt;

    if (effectiveBump === "none" && !canPrompt) {
      continue;
    }

    let newVersion = resolvedVersion;
    let finalBumpType: BumpKind = effectiveBump;

    if (canPrompt) {
      logger.clearScreen();
      logger.section(`📝 Commits for ${farver.cyan(pkg.name)}`);
      const commitDisplay = formatCommitsForDisplay(allCommitsForPackage);
      const commitLines = commitDisplay.split("\n");
      commitLines.forEach((line) => logger.item(line));
      logger.item(farver.dim(`Auto bump: ${determinedBump} → ${autoVersion}`));
      logger.emptyLine();

      if (override) {
        const overrideChoice = yield* prompts.confirmOverridePrompt(pkg, override.version);
        if (overrideChoice === null) continue;
        if (overrideChoice === "use") {
          newOverrides[pkgName] = { type: override.type, version: override.version };

          if (override.version === pkg.version) {
            excludedPackages.add(pkgName);
          }

          versionUpdates.push({
            package: pkg,
            currentVersion: pkg.version,
            newVersion: override.version,
            bumpType: override.type,
            hasDirectChanges: allCommitsForPackage.length > 0,
            changeKind: override.version === pkg.version ? "as-is" : "manual",
          });
          continue;
        }

        // User chose to pick another version — keep the override version as the
        // suggested default so the prompt highlights what was previously chosen
        // rather than falling back to the auto-detected version.
      }

      const selectedVersion = yield* prompts.selectVersionPrompt(workspaceRoot, pkg, pkg.version, newVersion, {
          defaultChoice: "suggested",
          suggestedHint: override
            ? `override: ${override.version}, auto: ${determinedBump} → ${autoVersion}`
            : `auto: ${determinedBump} → ${autoVersion}`,
        });

      if (selectedVersion === null) continue;

      const userBump = calculateBumpType(pkg.version, selectedVersion);
      finalBumpType = userBump;

      if (selectedVersion === pkg.version) {
        excludedPackages.add(pkgName);

        const nextOverride: VersionOverride = { type: "none", version: pkg.version };
        newOverrides[pkgName] = nextOverride;
        logger.info(`Override set for ${pkgName}: manual as-is (${pkg.version})`);

        // Keep an explicit update entry so downstream flows (changelog generation,
        // release summary, PR body) still include this changed package.
        versionUpdates.push({
          package: pkg,
          currentVersion: pkg.version,
          newVersion: pkg.version,
          bumpType: "none",
          hasDirectChanges: allCommitsForPackage.length > 0,
          changeKind: "as-is",
        });
        continue;
      }

      const nextOverride: VersionOverride = { type: userBump, version: selectedVersion };
      newOverrides[pkgName] = nextOverride;
      logger.info(`Override set for ${pkgName}: manual ${userBump} (${selectedVersion})`);

      newVersion = selectedVersion;
    }

    versionUpdates.push({
      package: pkg,
      currentVersion: pkg.version,
      newVersion,
      bumpType: finalBumpType,
      hasDirectChanges: allCommitsForPackage.length > 0,
      changeKind: canPrompt ? "manual" : "auto",
    });
  }

  // Second pass for manual bumps (if not in verify mode)
  if (!getIsCI() && showPrompt) {
    for (const pkg of workspacePackages) {
      if (processedPackages.has(pkg.name)) continue;

      logger.clearScreen();
      logger.section(`📦 Package: ${pkg.name}`);
      logger.item("No direct commits found");
      logger.item(farver.dim(`Auto bump: none → ${pkg.version}`));

      const newVersion = yield* prompts.selectVersionPrompt(workspaceRoot, pkg, pkg.version, pkg.version, {
          defaultChoice: "auto",
          suggestedHint: `auto: none → ${pkg.version}`,
        });
      if (newVersion === null) break;

      if (newVersion === pkg.version) {
        excludedPackages.add(pkg.name);
        newOverrides[pkg.name] = { type: "none", version: pkg.version };
        logger.info(`Override set for ${pkg.name}: manual as-is (${pkg.version})`);
        continue;
      }

      const bumpType = calculateBumpType(pkg.version, newVersion);
      newOverrides[pkg.name] = { type: bumpType, version: newVersion };
      logger.info(`Override set for ${pkg.name}: manual ${bumpType} (${newVersion})`);
      versionUpdates.push({
        package: pkg,
        currentVersion: pkg.version,
        newVersion,
        bumpType,
        hasDirectChanges: false,
        changeKind: "manual",
      });
      // We don't record an override here as there was no automatic bump to override.
    }
  }

  return { updates: versionUpdates, overrides: newOverrides, excludedPackages };
});

/**
 * Calculate version updates and prepare dependent updates
 * Returns both the updates and a function to apply them
 */
export const calculateAndPrepareVersionUpdates = Effect.fn(
  "calculateAndPrepareVersionUpdates",
)(function* ({
  workspacePackages,
  packageCommits,
  workspaceRoot,
  showPrompt,
  globalCommitsPerPackage,
  overrides,
}: CalculateVersionUpdatesOptions) {
  const {
    updates: directUpdates,
    overrides: newOverrides,
    excludedPackages: promptExcludedPackages,
  } = yield* calculateVersionUpdatesEffect({
    workspacePackages,
    packageCommits,
    workspaceRoot,
    showPrompt,
    globalCommitsPerPackage,
    overrides,
  });

  const graph = buildPackageDependencyGraph(workspacePackages);
  const overrideExcludedPackages = new Set(
    Object.entries(newOverrides)
      .filter(([, override]) => override.type === "none")
      .map(([pkgName]) => pkgName),
  );
  const excludedPackages = new Set<string>([
    ...overrideExcludedPackages,
    ...promptExcludedPackages,
  ]);

  const allUpdates = createDependentUpdates(
    graph,
    workspacePackages,
    directUpdates,
    excludedPackages,
  );

  const applyUpdates = Effect.fn("applyUpdates")(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* Effect.all(
      allUpdates.map((update: PackageRelease) => {
        const depUpdates = getDependencyUpdates(update.package, allUpdates);
        return updatePackageJson(fs, update.package, update.newVersion, depUpdates);
      }),
    );
  });

  return {
    allUpdates,
    applyUpdates,
    overrides: newOverrides,
  };
});


const updatePackageJson = Effect.fn("updatePackageJson")(
  function* (
  fs: FileSystem.FileSystem,
  pkg: WorkspacePackage,
  newVersion: string,
  dependencyUpdates: Map<string, string>,
) {
  const packageJsonPath = join(pkg.path, "package.json");

  const content = yield* fs.readFileString(packageJsonPath);
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

    const newRange = computeDependencyRange(oldVersion, depVersion, isPeerDependency);
    if (newRange === null) {
      logger.verbose(`  - Skipping workspace:* dependency: ${depName}`);
      return;
    }

    deps[depName] = newRange;
    logger.verbose(`  - Updated dependency ${depName}: ${oldVersion} → ${newRange}`);
  }

  // Update workspace dependencies
  for (const [depName, depVersion] of dependencyUpdates) {
    updateDependency(packageJson.dependencies, depName, depVersion);
    updateDependency(packageJson.devDependencies, depName, depVersion);
    updateDependency(packageJson.peerDependencies, depName, depVersion, true);
  }

  const updated = `${JSON.stringify(packageJson, null, 2)}\n`;
  yield* fs.writeFileString(packageJsonPath, updated);
  logger.verbose(`  - Successfully wrote updated package.json`);
});

/**
 * Get all dependency updates needed for a package
 */
function getDependencyUpdates(
  pkg: WorkspacePackage,
  allUpdates: PackageRelease[],
): Map<string, string> {
  const updates = new Map<string, string>();

  // Check all workspace dependencies
  const allDeps = [...pkg.workspaceDependencies, ...pkg.workspaceDevDependencies];

  for (const dep of allDeps) {
    // Find if this dependency is being updated
    const update = allUpdates.find((u) => u.package.name === dep);
    if (update) {
      logger.verbose(
        `  - Dependency ${dep} will be updated: ${update.currentVersion} → ${update.newVersion} (${update.bumpType})`,
      );
      updates.set(dep, update.newVersion);
    }
  }

  if (updates.size === 0) {
    logger.verbose(`  - No dependency updates needed`);
  }

  return updates;
}
