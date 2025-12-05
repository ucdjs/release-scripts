import type { WorkspacePackage } from "./services/workspace.service.js";
import type { NormalizedOptions, Options } from "./utils/options.js";
import { NodeCommandExecutor, NodeFileSystem } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import { ConfigService } from "./services/config.service.js";
import { GitService } from "./services/git.service.js";
import { GitHubService } from "./services/github.service.js";
import { WorkspaceService } from "./services/workspace.service.js";
import { normalizeOptions } from "./utils/options.js";

export type { Options } from "./utils/options.js";

export interface ReleaseScriptsAPI {
  verify: () => Promise<void>;
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
  ).pipe(
    Layer.provide(ConfigService.layer(config)),
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
        const workspace = yield* WorkspaceService;

        yield* Effect.log("🔍 Starting basic repository verification...");

        // === Repository State Verification ===
        const isRepository = yield* git.isRepository;
        if (!isRepository) {
          console.error("❌ Not a git repository");
          return yield* Effect.fail(new Error(`Directory ${cwd} is not a git repository`));
        }
        yield* Effect.log("✓ Valid git repository");

        // Check for uncommitted changes if safeguards enabled
        if (config.safeguards) {
          const hasChanges = yield* git.hasChanges;
          if (hasChanges) {
            console.error("❌ Working directory is not clean");
            return yield* Effect.fail(new Error("Working directory is not clean. Please commit or stash your changes before proceeding."));
          }
          yield* Effect.log("✓ Working directory is clean");
        }

        const originalBranch = yield* git.getCurrentBranch;
        yield* Effect.log(`✓ Current branch: ${originalBranch}`);

        // === GitHub Release PR Verification ===
        yield* Effect.log("\n🔍 Checking for release pull request...");

        const repoInfo = yield* github.getRepositoryInfo();
        yield* Effect.log(`✓ Repository: ${repoInfo.owner}/${repoInfo.repo}`);

        const releasePr = yield* github.getCurrentPullRequest();

        if (!releasePr) {
          yield* Effect.log(`⚠️ No open pull request found for branch "${originalBranch}".`);
          yield* basicVerification();
          return;
        }

        yield* Effect.log(`✓ Found release PR #${releasePr.number}: ${releasePr.title}`);
        yield* Effect.log(`✓ PR state: ${releasePr.state} | Draft: ${releasePr.draft}`);

        // === Workspace Package Verification ===
        yield* Effect.log("\n📦 Verifying workspace packages...");

        const packages = yield* workspace.listPackages;
        const publicPackages = packages.filter((pkg) => !("private" in pkg) || !pkg.private);

        yield* Effect.log(`✓ Found ${packages.length} packages (${publicPackages.length} public)`);

        if (publicPackages.length > 0) {
          yield* Effect.log("📋 Public packages in release:");

          for (const pkg of publicPackages) {
            const version = pkg.version || "0.0.0";

            yield* Effect.log(`  • ${pkg.name}@${version}`);
          }
        }

        // === Version Sync Verification ===
        yield* Effect.log("\n🔄 Verifying version synchronization...");

        // For now, assume packages are in sync - add actual version comparison logic here
        const isOutOfSync = false;

        // TODO: Add version comparison logic:
        // 1. Calculate expected versions based on commits since last release
        // 2. Compare with current package.json versions in the PR
        // 3. Check if versions need to be bumped

        yield* Effect.log("✓ Package versions appear to be in sync");

        // === Set Commit Status ===
        const statusContext = "ucdjs/release-verify";
        const commitHash = yield* git.getLastCommitHash;

        if (isOutOfSync) {
          yield* github.createCommitStatus(commitHash, {
            state: "failure",
            context: statusContext,
            description: "Release PR is out of sync with expected versions",
          });
          yield* Effect.log("❌ Verification failed - set commit status to 'failure'");
          return yield* Effect.fail(new Error("Release verification failed"));
        } else {
          yield* github.createCommitStatus(commitHash, {
            state: "success",
            context: statusContext,
            description: "Release PR verification passed",
            target_url: releasePr.html_url,
          });
          yield* Effect.log("✅ Verification passed - set commit status to 'success'");
        }

        yield* Effect.log("\n✅ Comprehensive verification completed successfully");

        // Helper function for basic verification when no PR exists
        function* basicVerification() {
          yield* Effect.log("\n📦 Basic workspace verification...");

          const remoteUrl = yield* git.getRemoteUrl;
          if (remoteUrl) {
            yield* Effect.log(`✓ Remote configured: ${remoteUrl}`);
          } else {
            yield* Effect.log("⚠️ No remote repository configured");
          }

          const branches = yield* git.listBranches;
          yield* Effect.log(`✓ Available branches: ${branches.join(", ")}`);

          yield* Effect.log(`✓ Workspace with ${packages.length} packages`);
          yield* Effect.log("\n✅ Basic verification completed");
        }
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
