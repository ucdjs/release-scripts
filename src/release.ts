import type {
  BumpKind,
  ReleaseOptions,
  ReleaseResult,
  VersionUpdate,
} from "./types";
import type { WorkspacePackage } from "./workspace";
import process from "node:process";
import { analyzePackageCommits } from "./commits";
import {
  checkoutBranch,
  commitChanges,
  createBranch,
  doesBranchExist,
  getCurrentBranch,
  isBranchAheadOfRemote,
  isWorkingDirectoryClean,
  pullLatestChanges,
  pushBranch,
  rebaseBranch,
} from "./git";
import {
  generatePullRequestBody,
  getExistingPullRequest,
  upsertPullRequest,
} from "./github";
import {
  buildPackageDependencyGraph,
  createDependentUpdates,
  getPackageUpdateOrder,
} from "./package";
import { promptVersionOverrides } from "./prompts";
import { globalOptions, isCI } from "./utils";
import {
  createVersionUpdate,
  getDependencyUpdates,
  updatePackageJson,
} from "./version";
import { discoverWorkspacePackages } from "./workspace";

export async function release(
  options: ReleaseOptions,
): Promise<ReleaseResult | null> {
  const {
    dryRun = false,
    safeguards = true,
    workspaceRoot = process.cwd(),
    releaseBranch = "release/next",
    githubToken,
  } = options;

  globalOptions.dryRun = dryRun;

  if (githubToken.trim() === "" || githubToken == null) {
    throw new Error("GitHub token is required");
  }

  const [owner, repo] = options.repo.split("/");

  if (!owner || !repo) {
    throw new Error(`Invalid repo format: ${options.repo}. Expected "owner/repo".`);
  }

  if (safeguards && !(await isWorkingDirectoryClean(workspaceRoot))) {
    console.error("Working directory is not clean. Please commit or stash your changes before proceeding.");
    return null;
  }

  const { workspacePackages, packagesToAnalyze } = await discoverWorkspacePackages(
    workspaceRoot,
    options,
  );

  if (packagesToAnalyze.length === 0) {
    console.log("No packages found to analyze for release.");
    return null;
  }

  // Analyze commits for packages, to determine version bumps
  const changedPackages = await analyzeCommits(packagesToAnalyze, workspaceRoot);

  if (changedPackages.size === 0) {
    throw new Error("No packages have changes requiring a release");
  }

  let versionUpdates = calculateVersions(
    workspacePackages,
    changedPackages,
  );

  // Prompt for version overrides if enabled
  const isVersionPromptEnabled = options.prompts?.versions !== false;

  if (!isCI && isVersionPromptEnabled) {
    const versionOverrides = await promptVersionOverrides(
      versionUpdates.map((u) => ({
        package: u.package,
        currentVersion: u.currentVersion,
        suggestedVersion: u.newVersion,
        bumpType: u.bumpType,
      })),
      workspaceRoot,
    );

    // Apply overrides
    versionUpdates = versionUpdates.map((update) => {
      const overriddenVersion = versionOverrides.get(update.package.name);
      if (overriddenVersion && overriddenVersion !== update.newVersion) {
        return {
          ...update,
          newVersion: overriddenVersion,
        };
      }
      return update;
    });
  }

  const graph = buildPackageDependencyGraph(workspacePackages);
  const packagesNeedingUpdate = new Set(versionUpdates.map((u) => u.package.name));

  // Get all packages in update order (includes dependents)
  const updateOrder = getPackageUpdateOrder(graph, packagesNeedingUpdate);

  const allUpdates = createDependentUpdates(
    updateOrder,
    versionUpdates,
  );

  // Save current branch to return to it later
  const currentBranch = await getCurrentBranch(workspaceRoot);

  // Check if PR already exists
  const existingPullRequest = await getExistingPullRequest({
    owner,
    repo,
    branch: releaseBranch,
    githubToken,
  });

  const prExists = !!existingPullRequest;
  if (prExists) {
    console.log("Existing pull request found:", existingPullRequest.html_url);
  } else {
    console.log("No existing pull request found, will create new one");
  }

  // Ensure release branch exists
  const branchExists = await doesBranchExist(releaseBranch, workspaceRoot);
  if (!branchExists) {
    console.log("Creating release branch:", releaseBranch);
    await createBranch(releaseBranch, currentBranch, workspaceRoot);
  }

  // Checkout release branch
  const hasCheckedOut = await checkoutBranch(releaseBranch, workspaceRoot);
  if (!hasCheckedOut) {
    throw new Error(`Failed to checkout branch: ${releaseBranch}`);
  }

  // Pull latest changes if branch exists remotely
  if (branchExists) {
    console.log("Pulling latest changes from remote");
    const hasPulled = await pullLatestChanges(releaseBranch, workspaceRoot);
    if (!hasPulled) {
      console.log("Warning: Failed to pull latest changes, continuing anyway");
    }
  }

  // Rebase onto current branch to get latest commits from main
  console.log("Rebasing release branch onto", currentBranch);
  await rebaseBranch(currentBranch, workspaceRoot);

  // Update package.json files
  await updatePackageJsonFiles(allUpdates);

  // Commit the changes (if there are any)
  const hasCommitted = await commitChanges("chore: update release versions", workspaceRoot);

  // Check if branch is ahead of remote (has commits to push)
  const isBranchAhead = await isBranchAheadOfRemote(releaseBranch, workspaceRoot);

  if (!hasCommitted && !isBranchAhead) {
    console.log("No changes to commit and branch is in sync with remote");
    await checkoutBranch(currentBranch, workspaceRoot);

    if (prExists) {
      console.log("No updates needed, PR is already up to date");
      return {
        updates: allUpdates,
        prUrl: existingPullRequest.html_url,
        created: false,
      };
    } else {
      console.error("No changes to commit, and no existing PR. Nothing to do.");
      return null;
    }
  }

  // Push with --force-with-lease for safety
  console.log("Pushing changes to remote");
  await pushBranch(releaseBranch, workspaceRoot, { forceWithLease: true });

  // Create or update PR
  const prTitle = existingPullRequest?.title || (options.pullRequest?.title || "chore: update package versions");
  const prBody = generatePullRequestBody(allUpdates, options.pullRequest?.body);

  const pullRequest = await upsertPullRequest({
    owner,
    repo,
    pullNumber: existingPullRequest?.number,
    title: prTitle,
    body: prBody,
    head: releaseBranch,
    base: currentBranch,
    githubToken,
  });

  console.log(prExists ? "Updated pull request:" : "Created pull request:", pullRequest?.html_url);

  // Checkout back to original branch
  await checkoutBranch(currentBranch, workspaceRoot);

  return {
    updates: allUpdates,
    prUrl: pullRequest?.html_url,
    created: !prExists,
  };
}

async function analyzeCommits(
  packages: WorkspacePackage[],
  workspaceRoot: string,
): Promise<Map<string, BumpKind>> {
  const changedPackages = new Map<string, BumpKind>();

  for (const pkg of packages) {
    const bump = await analyzePackageCommits(pkg, workspaceRoot);

    if (bump !== "none") {
      changedPackages.set(pkg.name, bump);
    }
  }

  return changedPackages;
}

function calculateVersions(
  allPackages: WorkspacePackage[],
  changedPackages: Map<string, BumpKind>,
): VersionUpdate[] {
  const updates: VersionUpdate[] = [];

  for (const [pkgName, bump] of changedPackages) {
    const pkg = allPackages.find((p) => p.name === pkgName);
    if (!pkg) continue;

    updates.push(createVersionUpdate(pkg, bump, true));
  }

  return updates;
}

async function updatePackageJsonFiles(
  updates: VersionUpdate[],
): Promise<void> {
  // Update package.json files in parallel
  await Promise.all(
    updates.map(async (update) => {
      const depUpdates = getDependencyUpdates(update.package, updates);
      await updatePackageJson(
        update.package,
        update.newVersion,
        depUpdates,
      );
    }),
  );
}
