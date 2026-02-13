import type { NormalizedReleaseScriptsOptions } from "./options";
import type { PackageRelease } from "./services/package-updater.service";
import { ChangelogService } from "#services/changelog";
import { DependencyGraphService } from "#services/dependency-graph";
import { GitService } from "#services/git";
import { GitHubService } from "#services/github";
import { PackageUpdaterService } from "#services/package-updater";
import { determineBump, VersionCalculatorService } from "#services/version-calculator";
import { VersionPromptService } from "#services/version-prompt";
import { WorkspaceService } from "#services/workspace";
import { Console, Effect } from "effect";
import semver from "semver";
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
    const versionPrompt = yield* VersionPromptService;
    const workspace = yield* WorkspaceService;

    yield* git.workspace.assertWorkspaceReady;

    // Step 1: Check if release PR exists
    let releasePullRequest = yield* github.getPullRequestByBranch(config.branch.release);
    const isNewRelease = !releasePullRequest;

    // Step 2: Ensure release branch exists
    const branchExists = yield* git.branches.exists(config.branch.release);
    if (!branchExists) {
      yield* Console.log(`Creating release branch "${config.branch.release}" from "${config.branch.default}"...`);
      yield* git.branches.create(config.branch.release, config.branch.default);
      yield* Console.log(`Release branch created.`);
    }

    // Step 3: Checkout release branch (if not already on it)
    const currentBranch = yield* git.branches.get;
    if (currentBranch !== config.branch.release) {
      yield* git.branches.checkout(config.branch.release);
      yield* Console.log(`Checked out to release branch "${config.branch.release}".`);
    }

    // Step 4: Rebase release branch onto main (skip for new branches)
    if (!isNewRelease || branchExists) {
      yield* Console.log(`Rebasing "${config.branch.release}" onto "${config.branch.default}"...`);
      yield* git.branches.rebase(config.branch.default);
      yield* Console.log(`Rebase complete.`);
    }

    // Step 5: Load overrides from main branch
    const overrides = yield* loadOverrides({
      sha: config.branch.default,
      overridesPath: ".github/ucdjs-release.overrides.json",
    });

    if (Object.keys(overrides).length > 0) {
      yield* Console.log("Loaded version overrides:", overrides);
    }

    // Step 6: Discover packages with commits (from main branch)
    const originalBranch = yield* git.branches.get;
    yield* git.branches.checkout(config.branch.default);

    const packages = (yield* workspace.discoverWorkspacePackages.pipe(
      Effect.flatMap(mergePackageCommitsIntoPackages),
      Effect.flatMap((pkgs) => mergeCommitsAffectingGloballyIntoPackage(pkgs, config.globalCommitMode)),
    ));

    yield* Console.log(`Discovered ${packages.length} packages with commits.`);

    // Step 7: Calculate version bumps (with optional interactive prompts)
    yield* dependencyGraph.topologicalOrder(packages);

    const releases: PackageRelease[] = [];

    if (versionPrompt.isEnabled) {
      yield* Console.log("\nInteractive version selection enabled.\n");
      versionPrompt.resetApplyToAll();

      for (let i = 0; i < packages.length; i++) {
        const pkg = packages[i]!;
        const allCommits = [...pkg.commits, ...pkg.globalCommits];
        const conventionalBump = determineBump(allCommits);
        const remainingCount = packages.length - i;

        const override = overrides[pkg.name];
        if (override) {
          if (!semver.valid(override)) {
            return yield* Effect.fail(new Error(`Invalid override version for ${pkg.name}: ${override}`));
          }
          releases.push({
            package: {
              name: pkg.name,
              version: pkg.version,
              path: pkg.path,
              packageJson: pkg.packageJson,
              workspaceDependencies: pkg.workspaceDependencies,
              workspaceDevDependencies: pkg.workspaceDevDependencies,
            },
            currentVersion: pkg.version,
            newVersion: override,
            bumpType: "none",
            hasDirectChanges: pkg.commits.length > 0,
          });
          continue;
        }

        const result = yield* versionPrompt.promptForVersion(pkg, conventionalBump, remainingCount);

        releases.push({
          package: {
            name: pkg.name,
            version: pkg.version,
            path: pkg.path,
            packageJson: pkg.packageJson,
            workspaceDependencies: pkg.workspaceDependencies,
            workspaceDevDependencies: pkg.workspaceDevDependencies,
          },
          currentVersion: pkg.version,
          newVersion: result.newVersion,
          bumpType: result.bumpType,
          hasDirectChanges: pkg.commits.length > 0,
        });
      }
    } else {
      const calculatedReleases = yield* versionCalculator.calculateBumps(packages, overrides);
      releases.push(...calculatedReleases);
    }

    const releasesCount = releases.length;
    yield* Console.log(`\n${releasesCount} package${releasesCount === 1 ? "" : "s"} will be released.`);

    // Go back to release branch for updates
    yield* git.branches.checkout(originalBranch);

    // Step 8: Apply package.json updates
    yield* Console.log("Updating package.json files...");
    yield* packageUpdater.applyReleases(packages, releases);
    yield* Console.log("package.json files updated.");

    // Step 9: Generate changelogs
    yield* Console.log("Generating changelogs...");
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

    yield* Console.log(`Generated ${changelogFiles.length} changelog file${changelogFiles.length === 1 ? "" : "s"}.`);

    // Step 10: Stage changes (only files we modified)
    const filesToStage = [
      ...releases.map((r) => `${r.package.path}/package.json`),
      ...changelogFiles,
    ];

    yield* Console.log(`Staging ${filesToStage.length} file${filesToStage.length === 1 ? "" : "s"}...`);
    yield* git.commits.stage(filesToStage);

    // Step 11: Commit changes
    const commitMessage = `chore(release): prepare release

${releasesCount} package${releasesCount === 1 ? "" : "s"} updated:
${releases.map((r) => `  - ${r.package.name}@${r.newVersion}`).join("\n")}`;

    yield* Console.log("Creating commit...");
    yield* git.commits.write(commitMessage);
    yield* Console.log("Commit created.");

    // Step 12: Push to release branch
    yield* Console.log(`Pushing to "${config.branch.release}"...`);
    if (isNewRelease && !branchExists) {
      // New branch, regular push
      yield* git.commits.push(config.branch.release);
    } else {
      // Existing branch, force push
      yield* git.commits.forcePush(config.branch.release);
    }
    yield* Console.log(`Push complete.`);

    // Step 13: Create or update PR
    const prBody = yield* github.generateReleasePRBody(
      releases.map((r) => ({
        packageName: r.package.name,
        version: r.newVersion,
        previousVersion: r.package.version,
      })),
    );

    if (isNewRelease) {
      yield* Console.log("Creating release pull request...");
      const newPR = yield* github.createPullRequest({
        title: config.pullRequest.title,
        body: prBody,
        head: config.branch.release,
        base: config.branch.default,
        draft: true,
      });
      releasePullRequest = newPR;
      yield* Console.log(`Release pull request #${releasePullRequest.number} created.`);
    } else {
      yield* Console.log("Updating pull request...");
      yield* github.updatePullRequest(releasePullRequest!.number, {
        body: prBody,
      });
      yield* Console.log("Pull request updated.");
    }

    yield* Console.log(`\nRelease preparation complete! View PR: #${releasePullRequest!.number}`);

    // Step 14: Switch back to default branch
    yield* git.branches.checkout(config.branch.default);
    yield* Console.log(`Switched back to "${config.branch.default}".`);
  });
}
