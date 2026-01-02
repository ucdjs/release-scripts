import type { WorkspacePackage } from "#services/workspace";
import type { NormalizedReleaseScriptsOptions } from "./options";
import { DependencyGraphService } from "#services/dependency-graph";
import { GitService } from "#services/git";
import { GitHubService } from "#services/github";
import { VersionCalculatorService } from "#services/version-calculator";
import { WorkspaceService } from "#services/workspace";
import { Console, Effect } from "effect";
import semver from "semver";
import {
  loadOverrides,
  mergeCommitsAffectingGloballyIntoPackage,
  mergePackageCommitsIntoPackages,
} from "./utils/helpers";

interface DriftReason {
  readonly packageName: string;
  readonly reason: string;
}

function satisfiesRange(range: string, version: string): boolean {
  // For simple ranges, use semver.satisfies. For complex ranges, semver still works;
  // we accept ranges that already include the new version.
  return semver.satisfies(version, range, { includePrerelease: true });
}

function snapshotPackageJson(pkg: WorkspacePackage, ref: string) {
  return Effect.gen(function* () {
    const git = yield* GitService;

    return yield* git.workspace.readFile(`${pkg.path}/package.json`, ref).pipe(
      Effect.flatMap((content) => Effect.try({
        try: () => JSON.parse(content) as Record<string, unknown>,
        catch: (e) => new Error(`Failed to parse package.json for ${pkg.name} at ${ref}: ${String(e)}`),
      })),
    );
  });
}

function findDrift(
  packages: readonly WorkspacePackage[],
  releases: readonly {
    package: WorkspacePackage;
    newVersion: string;
  }[],
  branchSnapshots: Map<string, Record<string, unknown> | Error>,
): DriftReason[] {
  const releaseVersionByName = new Map<string, string>();
  for (const rel of releases) {
    releaseVersionByName.set(rel.package.name, rel.newVersion);
  }

  const reasons: DriftReason[] = [];

  for (const pkg of packages) {
    const snapshot = branchSnapshots.get(pkg.name);
    if (snapshot == null) {
      reasons.push({ packageName: pkg.name, reason: "package.json missing on release branch" });
      continue;
    }

    if (snapshot instanceof Error) {
      reasons.push({ packageName: pkg.name, reason: snapshot.message });
      continue;
    }

    const expectedVersion = releaseVersionByName.get(pkg.name) ?? pkg.version;
    const branchVersion = typeof snapshot.version === "string" ? snapshot.version : undefined;

    if (!branchVersion) {
      reasons.push({ packageName: pkg.name, reason: "package.json on release branch lacks version" });
      continue;
    }

    if (branchVersion !== expectedVersion) {
      reasons.push({ packageName: pkg.name, reason: `version mismatch: expected ${expectedVersion}, found ${branchVersion}` });
    }

    // Check workspace dependency ranges for updated packages
    const dependencySections = ["dependencies", "devDependencies", "peerDependencies"] as const;
    for (const section of dependencySections) {
      const deps = snapshot[section];
      if (!deps || typeof deps !== "object") continue;

      for (const [depName, range] of Object.entries(deps as Record<string, unknown>)) {
        const bumpedVersion = releaseVersionByName.get(depName);
        if (!bumpedVersion) continue;

        if (typeof range !== "string") {
          reasons.push({ packageName: pkg.name, reason: `${section}.${depName} is not a string range` });
          continue;
        }

        if (!satisfiesRange(range, bumpedVersion)) {
          reasons.push({ packageName: pkg.name, reason: `${section}.${depName} does not include ${bumpedVersion}` });
        }
      }
    }
  }

  return reasons;
}

export function constructVerifyProgram(
  config: NormalizedReleaseScriptsOptions,
) {
  return Effect.gen(function* () {
    const git = yield* GitService;
    const github = yield* GitHubService;
    const dependencyGraph = yield* DependencyGraphService;
    const versionCalculator = yield* VersionCalculatorService;
    const workspace = yield* WorkspaceService;

    yield* git.workspace.assertWorkspaceReady;

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

    const releases = yield* versionCalculator.calculateBumps(packages, overrides);
    const ordered = yield* dependencyGraph.topologicalOrder(packages);

    yield* Console.log("Calculated releases:", releases);
    yield* Console.log("Release order:", ordered);

    const releaseHeadSha = releasePullRequest.head.sha;

    const branchSnapshots = new Map<string, Record<string, unknown> | Error>();
    for (const pkg of packages) {
      const snapshot = yield* snapshotPackageJson(pkg, releaseHeadSha).pipe(
        Effect.catchAll((err) => Effect.succeed(err instanceof Error ? err : new Error(String(err)))),
      );
      branchSnapshots.set(pkg.name, snapshot);
    }

    const drift = findDrift(packages, releases, branchSnapshots);

    if (drift.length === 0) {
      yield* Console.log("✅ Release branch is in sync with expected releases.");
    } else {
      yield* Console.log("❌ Release branch is out of sync:", drift);
    }

    const status = drift.length === 0
      ? { state: "success" as const, description: "Release artifacts in sync", context: "release/verify" }
      : { state: "failure" as const, description: "Release branch out of sync", context: "release/verify" };

    yield* github.setCommitStatus(releaseHeadSha, status);

    if (drift.length > 0) {
      return yield* Effect.fail(new Error("Release branch is out of sync."));
    }
  });
}
