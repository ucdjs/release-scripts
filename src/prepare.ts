import type { NormalizedReleaseScriptsOptions } from "./options";
import { ChangelogService } from "#services/changelog";
import { DependencyGraphService } from "#services/dependency-graph";
import { GitService } from "#services/git";
import { GitHubService } from "#services/github";
import { PackageUpdaterService } from "#services/package-updater";
import { VersionCalculatorService } from "#services/version-calculator";
import { WorkspaceService } from "#services/workspace";
import { Console, Effect } from "effect";
import {
  loadOverrides,
  mergeCommitsAffectingGloballyIntoPackage,
  mergePackageCommitsIntoPackages,
} from "./utils/helpers";

export function constructPrepareProgram(
  config: NormalizedReleaseScriptsOptions,
) {
  return Effect.gen(function* () {
    const changelog = yield* ChangelogService;
    const git = yield* GitService;
    const github = yield* GitHubService;
    const dependencyGraph = yield* DependencyGraphService;
    const packageUpdater = yield* PackageUpdaterService;
    const versionCalculator = yield* VersionCalculatorService;
    const workspace = yield* WorkspaceService;

    yield* git.workspace.assertWorkspaceReady;

    // Step 1: Fetch release PR
    const releasePullRequest = yield* github.getPullRequestByBranch(config.branch.release);
    if (!releasePullRequest || !releasePullRequest.head) {
      return yield* Effect.fail(new Error(`Release pull request for branch "${config.branch.release}" does not exist.`));
    }

    yield* Console.log(`✅ Release pull request #${releasePullRequest.number} exists.`);

    // Step 2: Checkout release branch
    const currentBranch = yield* git.branches.get;
    if (currentBranch !== config.branch.release) {
      yield* git.branches.checkout(config.branch.release);
      yield* Console.log(`✅ Checked out to release branch "${config.branch.release}".`);
    }

    // Step 3: Rebase release branch onto main
    yield* Console.log(`🔄 Rebasing "${config.branch.release}" onto "${config.branch.default}"...`);
    yield* git.branches.rebase(config.branch.default);
    yield* Console.log(`✅ Rebase complete.`);

    // Step 4: Load overrides from main branch
    const overrides = yield* loadOverrides({
      sha: config.branch.default,
      overridesPath: ".github/ucdjs-release.overrides.json",
    });

    if (Object.keys(overrides).length > 0) {
      yield* Console.log("📋 Loaded version overrides:", overrides);
    }

    // Step 5: Discover packages with commits (from main branch)
    const originalBranch = yield* git.branches.get;
    yield* git.branches.checkout(config.branch.default);

    const packages = (yield* workspace.discoverWorkspacePackages.pipe(
      Effect.flatMap(mergePackageCommitsIntoPackages),
      Effect.flatMap((pkgs) => mergeCommitsAffectingGloballyIntoPackage(pkgs, config.globalCommitMode)),
    ));

    yield* Console.log(`📦 Discovered ${packages.length} packages with commits.`);

    // Step 6: Calculate version bumps
    const releases = yield* versionCalculator.calculateBumps(packages, overrides);
    yield* dependencyGraph.topologicalOrder(packages);

    const releasesCount = releases.length;
    yield* Console.log(`📊 ${releasesCount} package${releasesCount === 1 ? "" : "s"} will be released.`);

    // Go back to release branch for updates
    yield* git.branches.checkout(originalBranch);

    // Step 7: Apply package.json updates
    yield* Console.log("✏️  Updating package.json files...");
    yield* packageUpdater.applyReleases(packages, releases);
    yield* Console.log("✅ package.json files updated.");

    // Step 8: Generate changelogs
    yield* Console.log("📝 Generating changelogs...");
    const changelogFiles: string[] = [];

    for (const release of releases) {
      const pkg = packages.find((p) => p.name === release.package.name);
      if (!pkg || !pkg.commits) continue;

      const result = yield* changelog.generateChangelog(pkg, release.newVersion, pkg.commits);

      // Write changelog to file
      yield* Effect.tryPromise({
        try: async () => {
          const fs = await import("node:fs/promises");
          await fs.writeFile(result.filePath, result.markdown, "utf-8");
        },
        catch: (e) => new Error(`Failed to write changelog: ${String(e)}`),
      });

      changelogFiles.push(result.filePath);
    }

    yield* Console.log(`✅ Generated ${changelogFiles.length} changelog file${changelogFiles.length === 1 ? "" : "s"}.`);

    // Step 9: Stage changes (only files we modified)
    const filesToStage = [
      ...releases.map((r) => `${r.package.path}/package.json`),
      ...changelogFiles,
    ];

    yield* Console.log(`📌 Staging ${filesToStage.length} file${filesToStage.length === 1 ? "" : "s"}...`);
    yield* git.commits.stage(filesToStage);

    // Step 10: Commit changes
    const commitMessage = `chore(release): prepare release

${releasesCount} package${releasesCount === 1 ? "" : "s"} updated:
${releases.map((r) => `  - ${r.package.name}@${r.newVersion}`).join("\n")}`;

    yield* Console.log("💾 Creating commit...");
    yield* git.commits.write(commitMessage);
    yield* Console.log("✅ Commit created.");

    // Step 11: Force push to release branch
    yield* Console.log(`⬆️  Force pushing to "${config.branch.release}"...`);
    yield* git.commits.forcePush(config.branch.release);
    yield* Console.log("✅ Force push complete.");

    // Step 12: Update PR body with changelog
    yield* Console.log("📄 Updating pull request...");
    const prBody = yield* github.generateReleasePRBody(
      releases.map((r) => ({
        packageName: r.package.name,
        version: r.newVersion,
        previousVersion: r.package.version,
      })),
    );
    yield* github.updatePullRequest(releasePullRequest.number, {
      body: prBody,
    });
    yield* Console.log("✅ Pull request updated.");

    yield* Console.log(`\n🎉 Release preparation complete! View PR: #${releasePullRequest.number}`);
  });
}
