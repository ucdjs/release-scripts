import type { WorkspacePackage } from "./workspace.service";
import { Effect } from "effect";
import semver from "semver";
import { WorkspaceService } from "./workspace.service";

const DASH_RE = / - /;
const RANGE_OPERATION_RE = /^(?:>=|<=|[><=])/;

function nextRange(oldRange: string, newVersion: string): string {
  const workspacePrefix = oldRange.startsWith("workspace:") ? "workspace:" : "";
  const raw = workspacePrefix ? oldRange.slice("workspace:".length) : oldRange;

  if (raw === "*" || raw === "latest") {
    return `${workspacePrefix}${raw}`;
  }

  // Check if this is a complex range (contains operators/spaces beyond simple ^ or ~)
  const isComplexRange = raw.includes("||") || DASH_RE.test(raw) || RANGE_OPERATION_RE.test(raw) || (raw.includes(" ") && !DASH_RE.test(raw));

  if (isComplexRange) {
    // For complex ranges, check if the new version satisfies the existing range
    if (semver.satisfies(newVersion, raw)) {
      // New version is within range, keep the range as-is
      return `${workspacePrefix}${raw}`;
    }

    // TODO: Implement range updating logic for when new version is outside the existing range
    // For now, we fail/error to avoid silently breaking dependency constraints
    throw new Error(
      `Cannot update range "${oldRange}" to version ${newVersion}: `
      + `new version is outside the existing range. `
      + `Complex range updating is not yet implemented.`,
    );
  }

  // Handle simple ^ and ~ prefixes
  const prefix = raw.startsWith("^") || raw.startsWith("~") ? raw[0] : "";
  return `${workspacePrefix}${prefix}${newVersion}`;
}

function updateDependencyRecord(
  record: Record<string, string> | undefined,
  releaseMap: ReadonlyMap<string, string>,
): { updated: boolean; next: Record<string, string> | undefined } {
  if (!record) return { updated: false, next: undefined };

  let changed = false;
  const next: Record<string, string> = { ...record };

  for (const [dep, currentRange] of Object.entries(record)) {
    const bumped = releaseMap.get(dep);
    if (!bumped) continue;

    const updatedRange = nextRange(currentRange, bumped);
    if (updatedRange !== currentRange) {
      next[dep] = updatedRange;
      changed = true;
    }
  }

  return { updated: changed, next: changed ? next : record };
}

export type BumpKind = "none" | "patch" | "minor" | "major";
export interface PackageRelease {
  /**
   * The package being updated
   */
  package: WorkspacePackage;

  /**
   * Current version
   */
  currentVersion: string;

  /**
   * New version to release
   */
  newVersion: string;

  /**
   * Type of version bump
   */
  bumpType: BumpKind;

  /**
   * Whether this package has direct changes (vs being updated due to dependency changes)
   */
  hasDirectChanges: boolean;
}

export class PackageUpdaterService extends Effect.Service<PackageUpdaterService>()(
  "@ucdjs/release-scripts/PackageUpdaterService",
  {
    effect: Effect.gen(function* () {
      const workspace = yield* WorkspaceService;

      function applyReleases(
        allPackages: readonly WorkspacePackage[],
        releases: readonly PackageRelease[],
      ) {
        const releaseMap = new Map<string, string>();
        for (const release of releases) {
          releaseMap.set(release.package.name, release.newVersion);
        }

        return Effect.all(
          allPackages.map((pkg) =>
            Effect.gen(function* () {
              const releaseVersion = releaseMap.get(pkg.name);
              const nextJson = { ...pkg.packageJson } as Record<string, unknown>;

              let updated = false;

              if (releaseVersion && pkg.packageJson.version !== releaseVersion) {
                nextJson.version = releaseVersion;
                updated = true;
              }

              const depsResult = updateDependencyRecord(pkg.packageJson.dependencies, releaseMap);
              if (depsResult.updated) {
                nextJson.dependencies = depsResult.next;
                updated = true;
              }

              const devDepsResult = updateDependencyRecord(pkg.packageJson.devDependencies, releaseMap);
              if (devDepsResult.updated) {
                nextJson.devDependencies = devDepsResult.next;
                updated = true;
              }

              const peerDepsResult = updateDependencyRecord(pkg.packageJson.peerDependencies, releaseMap);
              if (peerDepsResult.updated) {
                nextJson.peerDependencies = peerDepsResult.next;
                updated = true;
              }

              if (!updated) {
                return "skipped" as const;
              }

              return yield* workspace.writePackageJson(pkg.path, nextJson).pipe(
                Effect.map(() => "written" as const),
              );
            }),
          ),
        );
      }

      return {
        applyReleases,
      } as const;
    }),
    dependencies: [
      WorkspaceService.Default,
    ],
  },
) {}
