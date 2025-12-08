import type { WorkspacePackageWithCommits } from "../utils/helpers";
import type { BumpKind, PackageRelease } from "./package-updater.service";
import { Effect } from "effect";
import semver from "semver";
import { VersionCalculationError } from "../errors";

const BUMP_PRIORITY: Record<BumpKind, number> = {
  none: 0,
  patch: 1,
  minor: 2,
  major: 3,
};

function maxBump(current: BumpKind, incoming: BumpKind): BumpKind {
  const incomingPriority = BUMP_PRIORITY[incoming] ?? 0;
  const currentPriority = BUMP_PRIORITY[current] ?? 0;
  return incomingPriority > currentPriority ? incoming : current;
}

function bumpFromCommit(commit: { type?: string; isBreaking?: boolean }): BumpKind {
  if (commit.isBreaking) return "major";
  if (commit.type === "feat") return "minor";
  if (commit.type === "fix" || commit.type === "perf") return "patch";
  return "none";
}

function determineBump(commits: ReadonlyArray<{ type?: string; isBreaking?: boolean }>): BumpKind {
  return commits.reduce<BumpKind>((acc, commit) => maxBump(acc, bumpFromCommit(commit)), "none");
}

export class VersionCalculatorService extends Effect.Service<VersionCalculatorService>()(
  "@ucdjs/release-scripts/VersionCalculatorService",
  {
    effect: Effect.gen(function* () {
      function calculateBumps(
        packages: readonly WorkspacePackageWithCommits[],
        overrides: Readonly<Record<string, string>>,
      ) {
        return Effect.all(
          packages.map((pkg) =>
            Effect.gen(function* () {
              const allCommits = [...pkg.commits, ...pkg.globalCommits];
              const bumpType = determineBump(allCommits);
              const hasDirectChanges = pkg.commits.length > 0;

              let nextVersion: string | null = null;

              const override = overrides[pkg.name];
              if (override) {
                if (!semver.valid(override)) {
                  return yield* Effect.fail(new VersionCalculationError({
                    message: `Invalid override version for ${pkg.name}: ${override}`,
                    packageName: pkg.name,
                  }));
                }
                nextVersion = override;
              }

              if (nextVersion === null) {
                if (bumpType === "none") {
                  nextVersion = pkg.version;
                } else {
                  const bumped = semver.inc(pkg.version, bumpType);
                  if (!bumped) {
                    return yield* Effect.fail(new VersionCalculationError({
                      message: `Failed to bump version for ${pkg.name} using bump type ${bumpType}`,
                      packageName: pkg.name,
                    }));
                  }
                  nextVersion = bumped;
                }
              }

              // TODO: Insert interactive version prompt here if prompts.versions is enabled.

              return {
                package: {
                  name: pkg.name,
                  version: pkg.version,
                  path: pkg.path,
                  packageJson: pkg.packageJson,
                  workspaceDependencies: pkg.workspaceDependencies,
                  workspaceDevDependencies: pkg.workspaceDevDependencies,
                },
                currentVersion: pkg.version,
                newVersion: nextVersion,
                bumpType,
                hasDirectChanges,
              } satisfies PackageRelease;
            }),
          ),
          { concurrency: 10 },
        );
      }

      return {
        calculateBumps,
      } as const;
    }),
    dependencies: [],
  },
) {}
