import type { ReleaseScriptsOptionsInput } from "./options";
import type { WorkspacePackage } from "./services/workspace.service";
import { DependencyGraphService } from "#services/dependency-graph";
import { GitService } from "#services/git";
import { GitHubService } from "#services/github";
import { PackageUpdaterService } from "#services/package-updater";
import { VersionCalculatorService } from "#services/version-calculator";
import { WorkspaceService } from "#services/workspace";
import { NodeCommandExecutor, NodeFileSystem } from "@effect/platform-node";
import { Console, Effect, Layer } from "effect";
import { normalizeReleaseScriptsOptions, ReleaseScriptsOptions } from "./options";
import {
  loadOverrides,
  mergeCommitsAffectingGloballyIntoPackage,
  mergePackageCommitsIntoPackages,
} from "./utils/helpers";
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
    Layer.provide(GitService.Default),
    Layer.provide(GitHubService.Default),
    Layer.provide(DependencyGraphService.Default),
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
      const program = Effect.gen(function* () {
        const git = yield* GitService;
        const github = yield* GitHubService;
        const dependencyGraph = yield* DependencyGraphService;
        const packageUpdater = yield* PackageUpdaterService;
        const versionCalculator = yield* VersionCalculatorService;
        const workspace = yield* WorkspaceService;

        yield* safeguardProgram;

        const releasePullRequest = yield* github.getPullRequestByBranch(config.branch.release);
        if (!releasePullRequest || !releasePullRequest.head) {
          return yield* Effect.fail(new Error(`Release pull request for branch "${config.branch.release}" does not exist.`));
        }

        yield* Console.log(`✅ Release pull request #${releasePullRequest.number} exists.`);

        const currentBranch = yield* git.branches.get;
        if (currentBranch !== config.branch.default) {
          yield* git.branches.checkout(config.branch.default);
          yield* Console.log(`✅ Checked out to default branch "${config.branch.default}".`);
        }

        const overrides = yield* loadOverrides({
          sha: releasePullRequest.head.sha,
          overridesPath: ".github/ucdjs-release.overrides.json",
        });

        yield* Console.log("Loaded overrides:", overrides);

        const packages = (yield* workspace.discoverWorkspacePackages.pipe(
          Effect.flatMap(mergePackageCommitsIntoPackages),
          Effect.flatMap((pkgs) => mergeCommitsAffectingGloballyIntoPackage(pkgs, config.globalCommitMode)),
        ));

        yield* Console.log("Discovered packages with commits and global commits:", packages);

        const releases = yield* versionCalculator.calculateBumps(packages as any, overrides);
        const ordered = yield* dependencyGraph.topologicalOrder(packages as any);

        yield* Console.log("Calculated releases:", releases);
        yield* Console.log("Release order:", ordered);

        yield* packageUpdater.applyReleases(packages, releases);
      });

      return runProgram(program);
    },
    async publish(): Promise<void> {
      const program = Effect.gen(function* () {
        return yield* Effect.fail(new Error("Not implemented yet."));
      });

      return runProgram(program);
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
