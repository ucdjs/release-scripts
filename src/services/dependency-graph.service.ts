import type { WorkspacePackage } from "./workspace.service";
import { Effect } from "effect";

export interface PackageUpdateOrder {
  package: WorkspacePackage;
  level: number;
}

export class DependencyGraphService extends Effect.Service<DependencyGraphService>()(
  "@ucdjs/release-scripts/DependencyGraphService",
  {
    effect: Effect.gen(function* () {
      function buildGraph(packages: readonly WorkspacePackage[]) {
        const nameToPackage = new Map<string, WorkspacePackage>();
        const adjacency = new Map<string, Set<string>>();
        const inDegree = new Map<string, number>();

        for (const pkg of packages) {
          nameToPackage.set(pkg.name, pkg);
          adjacency.set(pkg.name, new Set());
          inDegree.set(pkg.name, 0);
        }

        for (const pkg of packages) {
          const deps = new Set([
            ...pkg.workspaceDependencies,
            ...pkg.workspaceDevDependencies,
          ]);

          for (const depName of deps) {
            if (!nameToPackage.has(depName)) {
              continue;
            }

            adjacency.get(depName)?.add(pkg.name);
            inDegree.set(pkg.name, (inDegree.get(pkg.name) ?? 0) + 1);
          }
        }

        return { nameToPackage, adjacency, inDegree } as const;
      }

      function topologicalOrder(packages: readonly WorkspacePackage[]): Effect.Effect<PackageUpdateOrder[], Error> {
        return Effect.gen(function* () {
          const { nameToPackage, adjacency, inDegree } = buildGraph(packages);

          const queue: Array<string> = [];
          const levels = new Map<string, number>();

          for (const [name, degree] of inDegree) {
            if (degree === 0) {
              queue.push(name);
              levels.set(name, 0);
            }
          }

          let queueIndex = 0;
          const ordered: PackageUpdateOrder[] = [];

          while (queueIndex < queue.length) {
            const current = queue[queueIndex++]!;
            const currentLevel = levels.get(current) ?? 0;

            const pkg = nameToPackage.get(current);
            if (pkg) {
              ordered.push({ package: pkg, level: currentLevel });
            }

            for (const neighbor of adjacency.get(current) ?? []) {
              const nextLevel = currentLevel + 1;
              const existingLevel = levels.get(neighbor) ?? 0;
              if (nextLevel > existingLevel) {
                levels.set(neighbor, nextLevel);
              }

              const newDegree = (inDegree.get(neighbor) ?? 0) - 1;
              inDegree.set(neighbor, newDegree);
              if (newDegree === 0) {
                queue.push(neighbor);
              }
            }
          }

          if (ordered.length !== packages.length) {
            const processed = new Set(ordered.map((o) => o.package.name));
            const unprocessed = packages.filter((p) => !processed.has(p.name)).map((p) => p.name);
            return yield* Effect.fail(new Error(`Cycle detected in workspace dependencies. Packages involved: ${unprocessed.join(", ")}`));
          }

          return ordered;
        });
      }

      return {
        topologicalOrder,
      } as const;
    }),
    dependencies: [],
  },
) {}
