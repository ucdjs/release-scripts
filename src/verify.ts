import type { NormalizedReleaseScriptsOptions } from "./options";
import { DependencyGraphService } from "#services/dependency-graph";
import { GitService } from "#services/git";
import { GitHubService } from "#services/github";
import { VersionCalculatorService } from "#services/version-calculator";
import { WorkspaceService } from "#services/workspace";
import { Console, Effect } from "effect";
import {
  loadOverrides,
  mergeCommitsAffectingGloballyIntoPackage,
  mergePackageCommitsIntoPackages,
} from "./utils/helpers";

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

    // STEP 4: Calculate the updates
    // STEP 5: Read package.jsons from release branch (without checkout)
    // STEP 6: Detect if Release PR is out of sync
    // STEP 7: Set Commit Status
  });
}
