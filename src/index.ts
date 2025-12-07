import type { WorkspacePackage } from "./services/workspace.service.js";
import type { NormalizedOptions, Options } from "./utils/options.js";
import { NodeCommandExecutor, NodeFileSystem } from "@effect/platform-node";
import { Console, Effect, Layer } from "effect";
import { GitService } from "./services/git.service.js";
import { GitHubService } from "./services/github.service.js";
import { VersionUpdaterService } from "./services/version-updater.service.js";
import { WorkspaceService } from "./services/workspace.service.js";
import { loadOverrides, mergeCommitsAffectingGloballyIntoPackage, mergePackageCommitsIntoPackages } from "./utils/helpers.js";
import { ConfigOptions, normalizeOptions } from "./utils/options.js";

export type { Options } from "./utils/options.js";

export interface ReleaseScriptsAPI {
  verify: () => Promise<void>;
  prepare: () => Promise<void>;
  publish: () => Promise<void>;
  packages: {
    list: () => Promise<readonly WorkspacePackage[]>;
    get: (packageName: string) => Promise<WorkspacePackage | null>;
  };
}

export async function createReleaseScripts(options: Options): Promise<ReleaseScriptsAPI> {
  const config = normalizeOptions(options);
  const cwd = config.workspaceRoot;

  const MainLayer = Layer.mergeAll(
    GitService.Default,
    WorkspaceService.Default,
    GitHubService.Default,
    VersionUpdaterService.Default,
  ).pipe(
    Layer.provide(ConfigOptions.layer(config)),
    Layer.provide(NodeCommandExecutor.layer),
    Layer.provide(NodeFileSystem.layer),
  );

  const runProgram = <A, E, R>(program: Effect.Effect<A, E, R>): Promise<A> =>
    Effect.runPromise(Effect.provide(program, MainLayer) as Effect.Effect<A, E>);

  const safeguardProgram = Effect.gen(function* () {
    const git = yield* GitService;

    const isWithinRepository = yield* git.isWithinRepository;
    if (!isWithinRepository) {
      return yield* Effect.fail(new Error(`The directory ${cwd} is not a git repository.`));
    }

    const isWorkingDirectoryClean = yield* git.isWorkingDirectoryClean;
    if (!isWorkingDirectoryClean) {
      return yield* Effect.fail(new Error("The git repository has uncommitted changes."));
    }

    return yield* Effect.succeed(void 0);
  });

  await Effect.runPromise(Effect.provide(safeguardProgram, MainLayer).pipe(
    Effect.catchAll((err) => {
      console.error(`❌ Initialization failed: ${err.message}`);
      return Effect.exit(Effect.fail(err));
    }),
  ));

  return {
    async verify(): Promise<void> {
      const program = Effect.gen(function* () {
        const git = yield* GitService;
        const github = yield* GitHubService;
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

        console.log("Loaded overrides:", overrides);

        const packages = yield* workspace.discoverWorkspacePackages.pipe(
          Effect.flatMap(mergePackageCommitsIntoPackages),
          Effect.flatMap((pkgs) => mergeCommitsAffectingGloballyIntoPackage(pkgs, config.globalCommitMode)),
        );

        console.log("Discovered packages with commits and global commits:", packages);

        // STEP 4: Calculate the updates
        // STEP 5: Read package.jsons from release branch (without checkout)
        // STEP 6: Detect if Release PR is out of sync
        // STEP 7: Set Commit Status
      });

      return runProgram(program);
    },
    async prepare(): Promise<void> {
      const program = Effect.gen(function* () {
        const git = yield* GitService;
        const github = yield* GitHubService;
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

        console.log("Loaded overrides:", overrides);

        const packages = yield* workspace.discoverWorkspacePackages.pipe(
          Effect.flatMap(mergePackageCommitsIntoPackages),
          Effect.flatMap((pkgs) => mergeCommitsAffectingGloballyIntoPackage(pkgs, config.globalCommitMode)),
        );

        console.log("Discovered packages with commits and global commits:", packages);
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
