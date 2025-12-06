import fs from "node:fs/promises";
import path from "node:path";
import { Command, CommandExecutor } from "@effect/platform";
import { NodeTerminal } from "@effect/platform-node";
import { Effect, Schema } from "effect";
import { WorkspaceError } from "../errors.js";

const PackageJsonSchema = Schema.Struct({
  name: Schema.String,
  dependencies: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.String })),
  devDependencies: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.String })),
});

const WorkspacePackageSchema = Schema.Struct({
  name: Schema.String,
  version: Schema.optional(Schema.String),
  path: Schema.String,
});

// pnpm list --json output can be an array of packages or an object with a packages property
const WorkspaceListSchema = Schema.Union(
  Schema.Array(WorkspacePackageSchema),
  Schema.transform(
    Schema.Struct({ packages: Schema.Array(WorkspacePackageSchema) }),
    Schema.Array(WorkspacePackageSchema),
    {
      decode: (obj) => obj.packages,
      encode: (arr) => ({ packages: arr }),
    },
  ),
);

export type WorkspacePackage = Schema.Schema.Type<typeof WorkspacePackageSchema>;

export class WorkspaceService extends Effect.Service<WorkspaceService>()("@ucdjs/release-scripts/WorkspaceService", {
  effect: Effect.gen(function* () {
    const executor = yield* CommandExecutor.CommandExecutor;

    const listPackages = yield* executor.string(Command.make("pnpm", "-r", "ls", "--json")).pipe(
      Effect.flatMap((stdout) =>
        Effect.try({
          try: () => JSON.parse(stdout),
          catch: (e) =>
            new WorkspaceError({
              message: "Failed to parse pnpm JSON output",
              operation: "discover",
              cause: e,
            }),
        }),
      ),
      Effect.flatMap((json) =>
        Schema.decodeUnknown(WorkspaceListSchema)(json).pipe(
          Effect.mapError(
            (e) =>
              new WorkspaceError({
                message: "Failed to decode pnpm output",
                operation: "discover",
                cause: e,
              }),
          ),
        ),
      ),
      Effect.cached,
    );

    const findPackageByName = (name: string) =>
      listPackages.pipe(
        Effect.map((pkgs) => pkgs.find((p) => p.name === name)),
      );

    const readPackageJson = (pkgPath: string) =>
      Effect.tryPromise({
        try: async () =>
          JSON.parse(
            await fs.readFile(path.join(pkgPath, "package.json"), "utf8"),
          ),
        catch: (e) =>
          new WorkspaceError({
            message: `Failed to read package.json for ${pkgPath}`,
            cause: e,
            operation: "readPackageJson",
          }),
      }).pipe(
        Effect.flatMap((json) =>
          Schema.decodeUnknown(PackageJsonSchema)(json).pipe(
            Effect.mapError(
              (e) =>
                new WorkspaceError({
                  message: `Invalid package.json for ${pkgPath}`,
                  cause: e,
                  operation: "readPackageJson",
                }),
            ),
          ),
        ),
      );

    const getPackageGraph = listPackages.pipe(
      Effect.flatMap((pkgs) =>
        Effect.forEach(pkgs, (p) =>
          p.path
            ? readPackageJson(p.path).pipe(
                Effect.map((pj) => ({
                  name: p.name,
                  deps: [
                    ...Object.keys(pj.dependencies ?? {}),
                    ...Object.keys(pj.devDependencies ?? {}),
                  ],
                })),
              )
            : Effect.succeed({ name: p.name, deps: [] })).pipe(
          Effect.map((entries) => {
            const graph: Record<string, string[]> = {};
            for (const e of entries) graph[e.name] = e.deps;
            return graph;
          }),
        ),
      ),
    );

    return {
      listPackages,
      findPackageByName,
      readPackageJson,
      getPackageGraph,
    } as const;
  }),
  dependencies: [],
}) {}
