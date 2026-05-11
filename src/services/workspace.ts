import { join } from "node:path";

import { PromptService } from "./prompts";
import type { FindWorkspacePackagesOptions, PackageJson } from "../shared/types";
import { getIsCI, logger, runEffect } from "../shared/utils";
import { Context, Data, Effect, FileSystem, Layer } from "effect";
import farver from "farver";

import type { NormalizedReleaseScriptsOptions } from "../options";

interface RawProject {
  name: string;
  path: string;
  version: string;
  private: boolean;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

export interface WorkspacePackage {
  name: string;
  version: string;
  path: string;
  packageJson: PackageJson;
  workspaceDependencies: string[];
  workspaceDevDependencies: string[];
}

export class WorkspaceError extends Data.TaggedError("WorkspaceError")<{
  operation: string;
  message: string;
}> {}

export interface WorkspaceServiceShape {
  readonly discoverWorkspacePackages: (
    workspaceRoot: string,
    options: NormalizedReleaseScriptsOptions,
  ) => Effect.Effect<WorkspacePackage[], unknown, unknown>;
}

function toWorkspaceError(operation: string, error: unknown): WorkspaceError {
  const message = error instanceof Error ? error.message : String(error);
  return new WorkspaceError({
    operation,
    message,
  });
}

export class WorkspaceService extends Context.Service<WorkspaceService, WorkspaceServiceShape>()(
  "@ucdjs/release-scripts/WorkspaceService",
) {}

function shouldIncludePackage(pkg: PackageJson, options?: FindWorkspacePackagesOptions): boolean {
  if (!options) {
    return true;
  }

  if (options.excludePrivate && pkg.private) {
    return false;
  }

  if (options.include && options.include.length > 0) {
    if (!options.include.includes(pkg.name)) {
      return false;
    }
  }

  if (options.exclude?.includes(pkg.name)) {
    return false;
  }

  return true;
}

// oxlint-disable-next-line require-yield
export const makeWorkspaceService = Effect.fn("makeWorkspaceService")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const readWorkspacePackage = Effect.fn("readWorkspacePackage")(function* (
    rawProject: RawProject,
    allPackageNames: Set<string>,
    options?: FindWorkspacePackagesOptions,
  ) {
    const packageJsonPath = join(rawProject.path, "package.json");
    const content = yield* fs.readFileString(packageJsonPath);
    const packageJson: PackageJson = JSON.parse(content);

    if (!shouldIncludePackage(packageJson, options)) {
      return null;
    }

    return {
      name: rawProject.name,
      version: rawProject.version,
      path: rawProject.path,
      packageJson,
      workspaceDependencies: Object.keys(rawProject.dependencies || []).filter((dep) => {
        return allPackageNames.has(dep);
      }),
      workspaceDevDependencies: Object.keys(rawProject.devDependencies || []).filter((dep) => {
        return allPackageNames.has(dep);
      }),
    } satisfies WorkspacePackage;
  });

  const findWorkspacePackages = Effect.fn("findWorkspacePackages")(function* (
    workspaceRoot: string,
    options?: FindWorkspacePackagesOptions,
  ) {
    try {
      const result = yield* runEffect("pnpm", ["-r", "ls", "--json"], {
        nodeOptions: {
          cwd: workspaceRoot,
          stdio: "pipe",
        },
      });

      const rawProjects: RawProject[] = JSON.parse(result.stdout);

      const allPackageNames = new Set<string>(rawProjects.map((p) => p.name));
      const excludedPackages = new Set<string>();

      const packages = yield* Effect.all(
        rawProjects.map((rawProject) =>
          readWorkspacePackage(rawProject, allPackageNames, options).pipe(
            Effect.tap((pkg) =>
              pkg === null ? Effect.sync(() => excludedPackages.add(rawProject.name)) : Effect.void,
            ),
          ),
        ),
      );

      if (excludedPackages.size > 0) {
        logger.info(`Excluded packages: ${farver.green([...excludedPackages].join(", "))}`);
      }

      return packages.filter((pkg): pkg is WorkspacePackage => pkg !== null);
    } catch (error) {
      logger.error("Error discovering workspace packages:", error);
      throw error;
    }
  });

  const discoverWorkspacePackages: WorkspaceServiceShape["discoverWorkspacePackages"] = Effect.fn(
    "discoverWorkspacePackages",
  )(function* (workspaceRoot, options) {
    const prompts = yield* PromptService;
    let workspaceOptions: FindWorkspacePackagesOptions;
    let explicitPackages: string[] | undefined;

    if (options.packages == null || options.packages === true) {
      workspaceOptions = { excludePrivate: false };
    } else if (Array.isArray(options.packages)) {
      workspaceOptions = { excludePrivate: false, include: options.packages };
      explicitPackages = options.packages;
    } else {
      workspaceOptions = options.packages;
      if (options.packages.include) {
        explicitPackages = options.packages.include;
      }
    }

      let workspacePackages: WorkspacePackage[];
      try {
        workspacePackages = yield* findWorkspacePackages(workspaceRoot, workspaceOptions);
      } catch (error) {
        return yield* Effect.fail(toWorkspaceError("discoverWorkspacePackages", error));
      }

    if (explicitPackages) {
      const foundNames = new Set(workspacePackages.map((p) => p.name));
      const missing = explicitPackages.filter((p) => !foundNames.has(p));

      if (missing.length > 0) {
        return yield* Effect.fail(
          toWorkspaceError(
            "discoverWorkspacePackages",
            `Package${missing.length > 1 ? "s" : ""} not found in workspace: ${missing.join(", ")}. ` +
            `Check your package names or run 'pnpm ls' to see available packages`,
          ),
        );
      }
    }

    const isPackagePromptEnabled = options.prompts?.packages !== false;
    logger.verbose("Package prompt gating", {
      isCI: getIsCI(),
      isPackagePromptEnabled,
      hasExplicitPackages: Boolean(explicitPackages),
      include: workspaceOptions.include ?? [],
      exclude: workspaceOptions.exclude ?? [],
      excludePrivate: workspaceOptions.excludePrivate ?? false,
    });

    if (!getIsCI() && isPackagePromptEnabled && !explicitPackages) {
      const selectedNames = yield* prompts.selectPackagePrompt(workspacePackages);
      workspacePackages = workspacePackages.filter((pkg) => selectedNames.includes(pkg.name));
    }

    return workspacePackages;
  });

  return WorkspaceService.of({
    discoverWorkspacePackages,
  });
});

export const WorkspaceServiceLive = Layer.effect(WorkspaceService, makeWorkspaceService());
