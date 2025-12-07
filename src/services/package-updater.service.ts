import type { PackageRelease } from "../shared/types";
import type { WorkspacePackage } from "./workspace.service";
import fs from "node:fs/promises";
import path from "node:path";
import { Effect } from "effect";
import { ConfigOptions } from "../options";

function nextRange(oldRange: string, newVersion: string): string {
  const workspacePrefix = oldRange.startsWith("workspace:") ? "workspace:" : "";
  const raw = workspacePrefix ? oldRange.slice("workspace:".length) : oldRange;

  if (raw === "*" || raw === "latest") {
    return `${workspacePrefix}${raw}`;
  }

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

export class PackageUpdaterService extends Effect.Service<PackageUpdaterService>()(
  "@ucdjs/release-scripts/PackageUpdaterService",
  {
    effect: Effect.gen(function* () {
      const config = yield* ConfigOptions;

      function writePackageJson(pkgPath: string, json: unknown) {
        const fullPath = path.join(pkgPath, "package.json");
        const content = `${JSON.stringify(json, null, 2)}\n`;

        if (config.dryRun) {
          return Effect.succeed(`Dry run: skip writing ${fullPath}`);
        }

        return Effect.tryPromise({
          try: async () => {
            await fs.writeFile(fullPath, content, "utf8");
          },
          catch: (e) => e as Error,
        });
      }

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

              return yield* writePackageJson(pkg.path, nextJson).pipe(
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
    dependencies: [],
  },
) {}
