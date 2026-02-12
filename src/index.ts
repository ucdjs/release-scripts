import type { ReleaseScriptsOptionsInput } from "./options";
import type { WorkspacePackage } from "./services/workspace.service";
import { ChangelogService } from "#services/changelog";
import { DependencyGraphService } from "#services/dependency-graph";
import { GitService } from "#services/git";
import { GitHubService } from "#services/github";
import { NPMService } from "#services/npm";
import { PackageUpdaterService } from "#services/package-updater";
import { VersionCalculatorService } from "#services/version-calculator";
import { WorkspaceService } from "#services/workspace";
import { NodeCommandExecutor, NodeFileSystem } from "@effect/platform-node";
import { Console, Effect, Layer } from "effect";
import { normalizeReleaseScriptsOptions, ReleaseScriptsOptions } from "./options";
import { constructPrepareProgram } from "./prepare";
import { constructPublishProgram } from "./publish";
import { constructVerifyProgram } from "./verify";

export interface ReleaseScripts {
  verify: () => Promise<void>;
  prepare: () => Promise<void>;
  publish: () => Promise<void>;
  packages: {
    list: () => Promise<readonly WorkspacePackage[]>;
    get: (packageName: string) => Promise<WorkspacePackage | null>;
  };
}

export async function createReleaseScripts(options: ReleaseScriptsOptionsInput): Promise<ReleaseScripts> {
  const config = normalizeReleaseScriptsOptions(options);

  const AppLayer = Layer.succeed(ReleaseScriptsOptions, config).pipe(
    Layer.provide(NodeCommandExecutor.layer),
    Layer.provide(NodeFileSystem.layer),
    Layer.provide(ChangelogService.Default),
    Layer.provide(GitService.Default),
    Layer.provide(GitHubService.Default),
    Layer.provide(DependencyGraphService.Default),
    Layer.provide(NPMService.Default),
    Layer.provide(PackageUpdaterService.Default),
    Layer.provide(VersionCalculatorService.Default),
    Layer.provide(WorkspaceService.Default),
  );

  const runProgram = <A, E, R>(program: Effect.Effect<A, E, R>): Promise<A> => {
    const provided = program.pipe(Effect.provide(AppLayer));
    return Effect.runPromise(provided as Effect.Effect<A, E, never>);
  };

  const safeguardProgram = Effect.gen(function* () {
    const git = yield* GitService;
    return yield* git.workspace.assertWorkspaceReady;
  });

  try {
    await runProgram(safeguardProgram);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await Effect.runPromise(Console.error(`❌ Initialization failed: ${message}`));
    throw err;
  }

  return {
    async verify(): Promise<void> {
      return runProgram(constructVerifyProgram(config));
    },
    async prepare(): Promise<void> {
      return runProgram(constructPrepareProgram(config));
    },
    async publish(): Promise<void> {
      return runProgram(constructPublishProgram(config));
    },
    packages: {
      async list(): Promise<readonly WorkspacePackage[]> {
        const program = Effect.gen(function* () {
          const workspace = yield* WorkspaceService;
          return yield* workspace.discoverWorkspacePackages;
        });

        return runProgram(program);
      },
      async get(packageName: string): Promise<WorkspacePackage | null> {
        const program = Effect.gen(function* () {
          const workspace = yield* WorkspaceService;

          const pkg = yield* workspace.findPackageByName(packageName);
          return pkg || null;
        });

        return runProgram(program);
      },
    },
  };
}
