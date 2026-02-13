import type { NormalizedReleaseScriptsOptions } from "./options";
import { DependencyGraphService } from "#services/dependency-graph";
import { GitService } from "#services/git";
import { NPMService } from "#services/npm";
import { WorkspaceService } from "#services/workspace";
import { Command, CommandExecutor } from "@effect/platform";
import { Console, Effect } from "effect";
import semver from "semver";

interface PublishResult {
  packageName: string;
  version: string;
  status: "published" | "skipped" | "failed";
  reason?: string;
}

function isPrerelease(version: string): boolean {
  const parsed = semver.parse(version);
  return parsed !== null && parsed.prerelease.length > 0;
}

function getDistTag(version: string): string {
  return isPrerelease(version) ? "next" : "latest";
}

function buildPackage(packagePath: string) {
  return Effect.gen(function* () {
    const executor = yield* CommandExecutor.CommandExecutor;

    const command = Command.make("pnpm", "run", "build").pipe(
      Command.workingDirectory(packagePath),
    );

    const result = yield* executor.string(command).pipe(
      Effect.mapError((err) => new Error(`Failed to build package at ${packagePath}: ${err.message}`)),
    );

    return result.trim();
  });
}

export function constructPublishProgram(
  config: NormalizedReleaseScriptsOptions,
) {
  return Effect.gen(function* () {
    const git = yield* GitService;
    const npm = yield* NPMService;
    const workspace = yield* WorkspaceService;
    const dependencyGraph = yield* DependencyGraphService;

    yield* git.workspace.assertWorkspaceReady;

    const currentBranch = yield* git.branches.get;
    if (currentBranch !== config.branch.default) {
      return yield* Effect.fail(new Error(
        `Publish must be run on the default branch "${config.branch.default}". Current branch: "${currentBranch}"`,
      ));
    }

    yield* Console.log(`On default branch "${config.branch.default}".`);

    const packages = yield* workspace.discoverWorkspacePackages;

    const publicPackages = packages.filter((pkg) => !pkg.packageJson.private);

    yield* Console.log(`Found ${publicPackages.length} public package${publicPackages.length === 1 ? "" : "s"} to check.`);

    const orderedPackages = yield* dependencyGraph.topologicalOrder(publicPackages);

    const results: PublishResult[] = [];

    for (const updateOrder of orderedPackages) {
      const pkg = updateOrder.package;
      const version = pkg.version;
      const tagName = `${pkg.name}@${version}`;

      const exists = yield* npm.versionExists(pkg.name, version);
      if (exists) {
        yield* Console.log(`Skipping ${pkg.name}@${version} - already published.`);
        results.push({
          packageName: pkg.name,
          version,
          status: "skipped",
          reason: "Already published to npm",
        });
        continue;
      }

      yield* Console.log(`Building ${pkg.name}...`);
      yield* buildPackage(pkg.path);
      yield* Console.log(`Build complete for ${pkg.name}.`);

      const distTag = getDistTag(version);
      yield* Console.log(`Publishing ${pkg.name}@${version} with tag "${distTag}"...`);

      const publishResult = yield* npm.publish({
        packagePath: pkg.path,
        tagName: distTag,
        otp: config.npm.otp,
        provenance: config.npm.provenance,
        dryRun: config.dryRun,
      }).pipe(
        Effect.map(() => ({ success: true as const })),
        Effect.catchAll((err) => Effect.succeed({ success: false as const, error: err })),
      );

      if (publishResult.success) {
        yield* Console.log(`Published ${pkg.name}@${version}.`);

        if (!config.dryRun) {
          yield* Console.log(`Creating tag ${tagName}...`);
          yield* git.tags.create(tagName, `Release ${tagName}`);
          yield* git.tags.push(tagName);
          yield* Console.log(`Tag ${tagName} created and pushed.`);
        } else {
          yield* Console.log(`[Dry Run] Would create and push tag ${tagName}.`);
        }

        results.push({
          packageName: pkg.name,
          version,
          status: "published",
        });
      } else {
        const error = publishResult.error;
        yield* Console.log(`Failed to publish ${pkg.name}@${version}: ${error.message}`);
        results.push({
          packageName: pkg.name,
          version,
          status: "failed",
          reason: error.message,
        });
      }
    }

    const published = results.filter((r) => r.status === "published");
    const skipped = results.filter((r) => r.status === "skipped");
    const failed = results.filter((r) => r.status === "failed");

    yield* Console.log("\nPublish Summary:");
    yield* Console.log(`   Published: ${published.length}`);
    yield* Console.log(`   Skipped: ${skipped.length}`);
    yield* Console.log(`   Failed: ${failed.length}`);

    if (failed.length > 0) {
      yield* Console.log("\nFailed packages:");
      for (const f of failed) {
        yield* Console.log(`   - ${f.packageName}@${f.version}: ${f.reason}`);
      }

      return yield* Effect.fail(new Error("Some packages failed to publish."));
    }

    if (published.length === 0 && skipped.length > 0) {
      yield* Console.log("\nAll packages were already published.");
    } else if (published.length > 0) {
      yield* Console.log("\nPublish complete!");
    }
  });
}
