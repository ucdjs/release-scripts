import type { WorkspacePackage } from "./services/workspace.service.js";
import process from "node:process";
import { NodeCommandExecutor, NodeFileSystem } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import { GitService } from "./services/git.service.js";
import { GitHubService } from "./services/github.service.js";
import { WorkspaceService } from "./services/workspace.service.js";

export interface Options {
  /**
   * Repository identifier (e.g., "owner/repo")
   */
  repo: `${string}/${string}`;

  /**
   * Root directory of the workspace (defaults to process.cwd())
   */
  workspaceRoot?: string;

  /**
   * Specific packages to prepare for release.
   * - true: discover all packages
   * - FindWorkspacePackagesOptions: discover with filters
   * - string[]: specific package names
   */
  packages?: true | unknown | string[];

  /**
   * GitHub token for authentication
   */
  githubToken: string;

  branch?: {
    release?: string;
    default?: string;
  };

  safeguards?: boolean;
}

export interface ReleaseScriptsAPI {
  verify: () => Promise<void>;
  packages: {
    list: () => Promise<readonly WorkspacePackage[]>;
    get: (packageName: string) => Promise<WorkspacePackage | null>;
  };
}

export async function createReleaseScripts(config: Options): Promise<ReleaseScriptsAPI> {
  const {
    workspaceRoot: cwd = process.cwd(),
  } = config;

  const MainLayer = Layer.mergeAll(
    GitService.Default,
    WorkspaceService.Default,
    GitHubService.Default,
  ).pipe(
    Layer.provide(NodeCommandExecutor.layer),
    Layer.provide(NodeFileSystem.layer),
  );

  const runProgram = <A, E, R>(program: Effect.Effect<A, E, R>): Promise<A> =>
    Effect.runPromise(Effect.provide(program, MainLayer) as Effect.Effect<A, E>);

  const initProgram = Effect.gen(function* () {
    const git = yield* GitService;

    const isRepository = yield* git.isRepository;
    if (!isRepository) {
      return yield* Effect.fail(new Error(`The directory ${cwd} is not a git repository.`));
    }

    const hasChanges = yield* git.hasChanges;
    if (hasChanges) {
      return yield* Effect.fail(new Error("The git repository has uncommitted changes."));
    }

    return yield* Effect.succeed(void 0);
  });

  await Effect.runPromise(Effect.provide(initProgram, MainLayer).pipe(
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

        const isRepository = yield* git.isRepository;
        if (!isRepository) {
          return yield* Effect.fail(new Error(`The directory ${cwd} is not a git repository.`));
        }

        const releasePullRequest = yield* github.getCurrentPullRequest();

        if (!releasePullRequest || !releasePullRequest.head) {
          return yield* Effect.fail(new Error("No pull request found for the current branch."));
        }

        const originalBranch = yield* git.getCurrentBranch;

        console.log(`✅ Verification successful on branch ${originalBranch}.`);
      });

      return runProgram(program);
    },

    packages: {
      async list(): Promise<readonly WorkspacePackage[]> {
        const program = Effect.gen(function* () {
          const workspace = yield* WorkspaceService;
          return yield* workspace.listPackages;
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
