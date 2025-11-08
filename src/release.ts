import type {
  BumpKind,
  ReleaseOptions,
  ReleaseResult,
  VersionUpdate,
  WorkspacePackage,
} from "./types";
import process from "node:process";
import { analyzePackageCommits } from "./commits";
import { createDependentUpdates } from "./dependencies";
import {
  checkoutBranch,
  commitChanges,
  createBranch,
  doesBranchExist,
  generatePRBody,
  getCurrentBranch,
  isWorkingDirectoryClean,
  pullLatestChanges,
  pushBranch,
  rebaseBranch,
} from "./git";
import { getExistingPullRequest, upsertPullRequest } from "./github";
import { promptPackageSelection, promptVersionOverrides } from "./prompts";
import { globalOptions } from "./utils";
import { createVersionUpdate, getDependencyUpdates, updatePackageJson } from "./version";
import { buildDependencyGraph, findWorkspacePackages, getPackageUpdateOrder } from "./workspace";

const isCI = process.env.CI === "true";

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

  if (safeguards && !isWorkingDirectoryClean(workspaceRoot)) {
    console.error("Working directory is not clean. Please commit or stash your changes before proceeding.");
    return null;
  }

  const { workspacePackages, packagesToAnalyze: initialPackages } = await discoverPackages(
    workspaceRoot,
    options,
  );

  if (initialPackages.length === 0) {
    return null;
  }

  // Determine if we should show package selection prompt
  const isPackagePromptEnabled = options.prompts?.packages !== false;
  const isPackagesPreConfigured = Array.isArray(options.packages) || (typeof options.packages === "object" && options.packages.included != null);

  let packagesToAnalyze = initialPackages;

  if (!isCI && isPackagePromptEnabled && !isPackagesPreConfigured) {
    const selectedNames = await promptPackageSelection(initialPackages);
    packagesToAnalyze = initialPackages.filter((pkg) => selectedNames.includes(pkg.name));
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
        name: u.package.name,
        currentVersion: u.currentVersion,
        suggestedVersion: u.newVersion,
        bumpType: u.bumpType,
      })),
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

  const graph = buildDependencyGraph(workspacePackages);
  const packagesNeedingUpdate = new Set(versionUpdates.map((u) => u.package.name));

  // Get all packages in update order (includes dependents)
  const updateOrder = getPackageUpdateOrder(graph, packagesNeedingUpdate);

  const allUpdates = createDependentUpdates(
    updateOrder,
    versionUpdates,
  );

  // Save current branch to return to it later
  const currentBranch = await getCurrentBranch(workspaceRoot);
  const existingPullRequest = await getExistingPullRequest({
    owner,
    repo,
    branch: releaseBranch,
    githubToken,
  });

  if (existingPullRequest) {
    console.log("Existing pull request found for release branch:", existingPullRequest.html_url);

    // Checkout release branch
    const hasCheckedOut = await checkoutBranch(releaseBranch, workspaceRoot);
    if (!hasCheckedOut) {
      throw new Error(`Failed to checkout branch: ${releaseBranch}`);
    }

    // Pull latest changes from remote release branch
    const hasLatestRemoteChanges = await pullLatestChanges(releaseBranch, workspaceRoot);
    if (!hasLatestRemoteChanges) {
      throw new Error(`Failed to pull latest changes for branch: ${releaseBranch}`);
    }

    // Rebase release branch onto current branch (usually main) to get latest commits
    console.log("Rebasing release branch onto", currentBranch);
    await rebaseBranch(currentBranch, workspaceRoot);

    // Now update package.json files (on release branch)
    await updatePackageJsonFiles(allUpdates);

    // Commit the changes (if there are any)
    const hasCommitted = await commitChanges("chore: update release versions", workspaceRoot);

    if (hasCommitted) {
      console.log("Changes committed, pushing to remote");

      // Push with --force-with-lease to preserve any manual commits
      await pushBranch(releaseBranch, workspaceRoot, { forceWithLease: true });

      // Update PR body
      const prBody = generatePRBody(allUpdates);
      if (existingPullRequest.number) {
        console.log("Updated existing pull request:", existingPullRequest.html_url);
        await upsertPullRequest({
          owner,
          repo,
          pullNumber: existingPullRequest.number,
          title: existingPullRequest.title,
          body: prBody,
          head: releaseBranch,
          base: currentBranch,
          githubToken,
        });
      }
    } else {
      console.log("No changes to commit, skipping push and PR update");
    }

    // Checkout back to original branch
    await checkoutBranch(currentBranch, workspaceRoot);

    return {
      updates: allUpdates,
      prUrl: existingPullRequest?.html_url,
      created: false,
    };
  }

  console.log("No existing pull request found for release branch");
  console.log("A new pull request will be created upon release");

  const doWeHaveBranch = await doesBranchExist(releaseBranch, workspaceRoot);

  if (!doWeHaveBranch) {
    // Create the release branch if it doesn't exist
    await createBranch(releaseBranch, currentBranch, workspaceRoot);
  }

  // Checkout the release branch
  const hasCheckedOut = await checkoutBranch(releaseBranch, workspaceRoot);
  if (!hasCheckedOut) {
    throw new Error(`Failed to checkout branch: ${releaseBranch}`);
  }

  // Rebase release branch onto current branch (usually main) to get latest commits
  console.log("Rebasing release branch onto", currentBranch);
  await rebaseBranch(currentBranch, workspaceRoot);

  // Update package.json files
  await updatePackageJsonFiles(allUpdates);

  // Commit the changes (if there are any)
  const hasCommitted = await commitChanges("chore: update release versions", workspaceRoot);

  if (!hasCommitted) {
    console.log("No changes to commit");
    await checkoutBranch(currentBranch, workspaceRoot);
    throw new Error("No changes to commit for new release");
  }

  // Push the release branch to remote
  await pushBranch(releaseBranch, workspaceRoot, { force: doWeHaveBranch });

  // Create the PR
  const prTitle = "Release: Update package versions";
  const prBody = generatePRBody(allUpdates);

  // Create PR via GitHub API
  const newPullRequest = await upsertPullRequest({
    owner,
    repo,
    title: prTitle,
    body: prBody,
    head: releaseBranch,
    base: currentBranch,
    githubToken,
  });

  // Checkout back to original branch
  await checkoutBranch(currentBranch, workspaceRoot);

  return {
    updates: allUpdates,
    prUrl: newPullRequest?.html_url,
    created: true,
  };
}

async function discoverPackages(
  workspaceRoot: string,
  options: ReleaseOptions,
): Promise<{
  workspacePackages: WorkspacePackage[];
  packagesToAnalyze: WorkspacePackage[];
}> {
  let workspacePackages: WorkspacePackage[];
  let packagesToAnalyze: WorkspacePackage[];

  // If packages is true, discover all packages
  if (typeof options.packages === "boolean" && options.packages === true) {
    workspacePackages = await findWorkspacePackages(
      workspaceRoot,
      {
        excludePrivate: false,
      },
    );

    packagesToAnalyze = workspacePackages;

    return { workspacePackages, packagesToAnalyze };
  }

  // If packages is an array of strings, filter to those packages
  if (Array.isArray(options.packages)) {
    const packageNames = options.packages as string[];
    workspacePackages = await findWorkspacePackages(
      workspaceRoot,
      {
        excludePrivate: false,
        included: packageNames,
      },
    );
    packagesToAnalyze = workspacePackages.filter((pkg) =>
      packageNames.includes(pkg.name),
    );

    if (packagesToAnalyze.length !== packageNames.length) {
      const found = new Set(packagesToAnalyze.map((p) => p.name));
      const missing = packageNames.filter((p) => !found.has(p));
      throw new Error(`Packages not found in workspace: ${missing.join(", ")}`);
    }

    return { workspacePackages, packagesToAnalyze };
  }

  // Otherwise, discover packages based on packageOptions
  workspacePackages = await findWorkspacePackages(
    workspaceRoot,
    options.packages,
  );
  packagesToAnalyze = workspacePackages;

  return { workspacePackages, packagesToAnalyze };
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
