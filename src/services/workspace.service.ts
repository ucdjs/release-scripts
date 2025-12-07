import type { FindWorkspacePackagesOptions } from "../options";
import fs from "node:fs/promises";
import path from "node:path";
import { Command, CommandExecutor } from "@effect/platform";
import { Effect, Schema } from "effect";
import { WorkspaceError } from "../errors";
import { ReleaseScriptsOptions } from "../options";

export const DependencyObjectSchema = Schema.Record({
  key: Schema.String,
  value: Schema.String,
});

export const PackageJsonSchema = Schema.Struct({
  name: Schema.String,
  private: Schema.optional(Schema.Boolean),
  version: Schema.optional(Schema.String),
  dependencies: Schema.optional(DependencyObjectSchema),
  devDependencies: Schema.optional(DependencyObjectSchema),
  peerDependencies: Schema.optional(DependencyObjectSchema),
});

export type PackageJson = Schema.Schema.Type<typeof PackageJsonSchema>;

export const WorkspacePackageSchema = Schema.Struct({
  name: Schema.String,
  version: Schema.String,
  path: Schema.String,
  packageJson: PackageJsonSchema,
  workspaceDependencies: Schema.Array(Schema.String),
  workspaceDevDependencies: Schema.Array(Schema.String),
});

export type WorkspacePackage = Schema.Schema.Type<typeof WorkspacePackageSchema>;

const WorkspaceListSchema = Schema.Array(Schema.Struct({
  name: Schema.String,
  path: Schema.String,
  version: Schema.String,
  private: Schema.Boolean,
  dependencies: Schema.optional(DependencyObjectSchema),
  devDependencies: Schema.optional(DependencyObjectSchema),
  peerDependencies: Schema.optional(DependencyObjectSchema),
}));

export class WorkspaceService extends Effect.Service<WorkspaceService>()("@ucdjs/release-scripts/WorkspaceService", {
  effect: Effect.gen(function* () {
    const executor = yield* CommandExecutor.CommandExecutor;
    const config = yield* ReleaseScriptsOptions;

    const workspacePackageListOutput = yield* executor.string(Command.make("pnpm", "-r", "ls", "--json").pipe(
      Command.workingDirectory(config.workspaceRoot),
    )).pipe(
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

    function readPackageJson(pkgPath: string) {
      return Effect.tryPromise({
        try: async () => JSON.parse(
          await fs.readFile(path.join(pkgPath, "package.json"), "utf8"),
        ),
        catch: (e) => new WorkspaceError({
          message: `Failed to read package.json for ${pkgPath}`,
          cause: e,
          operation: "readPackageJson",
        }),
      }).pipe(
        Effect.flatMap((json) => Schema.decodeUnknown(PackageJsonSchema)(json).pipe(
          Effect.mapError(
            (e) => new WorkspaceError({
              message: `Invalid package.json for ${pkgPath}`,
              cause: e,
              operation: "readPackageJson",
            }),
          ),
        )),
      );
    }

    const discoverWorkspacePackages = Effect.gen(function* () {
      let workspaceOptions: FindWorkspacePackagesOptions;
      let explicitPackages: string[] | undefined;

      // Normalize package options and determine if packages were explicitly specified
      if (config.packages == null || config.packages === true) {
        workspaceOptions = { excludePrivate: false };
      } else if (Array.isArray(config.packages)) {
        workspaceOptions = { excludePrivate: false, include: config.packages };
        explicitPackages = config.packages;
      } else {
        workspaceOptions = config.packages;
        if (config.packages.include) {
          explicitPackages = config.packages.include;
        }
      }

      const workspacePackages = yield* findWorkspacePackages(
        workspaceOptions,
      );

      // If specific packages were requested, validate they were all found
      if (explicitPackages) {
        const foundNames = new Set(workspacePackages.map((p) => p.name));
        const missing = explicitPackages.filter((p) => !foundNames.has(p));

        if (missing.length > 0) {
          return yield* Effect.fail(
            new Error(`Package${missing.length > 1 ? "s" : ""} not found in workspace: ${missing.join(", ")}`),
          );
        }
      }

      // Show interactive prompt only if:
      // 1. Not in CI
      // 2. Prompt is enabled
      // 3. No explicit packages were specified (user didn't pre-select specific packages)
      // const isPackagePromptEnabled = config.prompts?.packages !== false;
      // if (!isCI && isPackagePromptEnabled && !explicitPackages) {
      //   const selectedNames = await selectPackagePrompt(workspacePackages);
      //   workspacePackages = workspacePackages.filter((pkg) =>
      //     selectedNames.includes(pkg.name),
      //   );
      // }

      return workspacePackages;
    });

    function findWorkspacePackages(options?: FindWorkspacePackagesOptions) {
      return workspacePackageListOutput.pipe(
        Effect.flatMap((rawProjects) => {
          const allPackageNames = new Set<string>(rawProjects.map((p) => p.name));
          const excludedPackages = new Set<string>();

          return Effect.all(
            rawProjects.map((rawProject) =>
              readPackageJson(rawProject.path).pipe(
                Effect.flatMap((packageJson) => {
                  if (!shouldIncludePackage(packageJson, options)) {
                    excludedPackages.add(rawProject.name);
                    return Effect.succeed(null);
                  }

                  const pkg = {
                    name: rawProject.name,
                    version: rawProject.version,
                    path: rawProject.path,
                    packageJson,
                    workspaceDependencies: Object.keys(rawProject.dependencies || {}).filter((dep) =>
                      allPackageNames.has(dep),
                    ),
                    workspaceDevDependencies: Object.keys(rawProject.devDependencies || {}).filter((dep) =>
                      allPackageNames.has(dep),
                    ),
                  };

                  return Schema.decodeUnknown(WorkspacePackageSchema)(pkg).pipe(
                    Effect.mapError(
                      (e) => new WorkspaceError({
                        message: `Invalid workspace package structure for ${rawProject.name}`,
                        cause: e,
                        operation: "findWorkspacePackages",
                      }),
                    ),
                  );
                }),
                Effect.catchAll(() => {
                  return Effect.logWarning(`Skipping invalid package ${rawProject.name}`).pipe(
                    Effect.as(null),
                  );
                }),
              ),
            ),
          ).pipe(
            Effect.map((packages) =>
              packages.filter(
                (pkg): pkg is WorkspacePackage => pkg !== null,
              ),
            ),
          );
        }),
      );
    }

    function shouldIncludePackage(pkg: PackageJson, options?: FindWorkspacePackagesOptions): boolean {
      if (!options) {
        return true;
      }

      // Check if private packages should be excluded
      if (options.excludePrivate && pkg.private) {
        return false;
      }

      // Check include list (if specified, only these packages are included)
      if (options.include && options.include.length > 0) {
        if (!options.include.includes(pkg.name)) {
          return false;
        }
      }

      // Check exclude list
      if (options.exclude?.includes(pkg.name)) {
        return false;
      }

      return true;
    }

    function findPackageByName(packageName: string) {
      return discoverWorkspacePackages.pipe(
        Effect.map((packages) =>
          packages.find((pkg) => pkg.name === packageName) || null,
        ),
      );
    }

    return {
      readPackageJson,
      findWorkspacePackages,
      discoverWorkspacePackages,
      findPackageByName,
    } as const;
  }),
  dependencies: [],
}) { }
