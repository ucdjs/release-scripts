import type {
  FindWorkspacePackagesOptions,
  GlobalCommitMode,
  PackageRelease,
  SharedOptions,
} from "#shared/types";
import process from "node:process";
import {
  getDefaultBranch,
  isWorkingDirectoryClean,
} from "#core/git";
import { discoverWorkspacePackages } from "#core/workspace";
import { exitWithError, logger, normalizeReleaseOptions, normalizeSharedOptions } from "#shared/utils";
import {
  getAllWorkspaceCommits,
  getGlobalCommits,
  getLastTag,
  getWorkspacePackageCommits,
} from "#versioning/commits";
import {
  buildPackageDependencyGraph,
  createDependentUpdates,
} from "#versioning/package";
import { inferVersionUpdates } from "#versioning/version";
import farver from "farver";

export interface ReleaseOptions extends SharedOptions {
  branch?: {
    /**
     * Branch name for the release PR (defaults to "release/next")
     */
    release?: string;

    /**
     * Default branch name (e.g., "main")
     */
    default?: string;
  };

  /**
   * Whether to enable safety safeguards (e.g., checking for clean working directory)
   * @default true
   */
  safeguards?: boolean;

  /**
   * Pull request configuration
   */
  pullRequest?: {
    /**
     * Title for the release pull request
     */
    title?: string;

    /**
     * Body for the release pull request
     *
     * If not provided, a default body will be generated.
     *
     * NOTE:
     * You can use custom template expressions, see [h3js/rendu](https://github.com/h3js/rendu)
     */
    body?: string;
  };

  globalCommitMode?: GlobalCommitMode;
}

export interface ReleaseResult {
  /**
   * Packages that will be updated
   */
  updates: PackageRelease[];

  /**
   * URL of the created or updated PR
   */
  prUrl?: string;

  /**
   * Whether a new PR was created (vs updating existing)
   */
  created: boolean;
}

export async function release(
  options: ReleaseOptions,
): Promise<ReleaseResult | null> {
  const {
    workspaceRoot,
    ...normalizedOptions
  } = await normalizeReleaseOptions(options);

  if (normalizedOptions.safeguards && !(await isWorkingDirectoryClean(workspaceRoot))) {
    exitWithError("Working directory is not clean. Please commit or stash your changes before proceeding.");
  }

  const workspacePackages = await discoverWorkspacePackages(
    workspaceRoot,
    options,
  );

  logger.log(`Discovered ${workspacePackages.length} workspace packages`);
  for (const pkg of workspacePackages) {
    logger.log(`- ${pkg.name} (${farver.dim(pkg.version)})`);
    logger.log(`  path: ${pkg.path}`);
  }

  if (workspacePackages.length === 0) {
    logger.info(farver.yellow("No packages found to release."));
    return null;
  }

  // TODO: what if the last tag pushed has included some important changes for another package?
  // That package would miss those changes in its changelog.
  // Maybe we should get the last tag for each package instead?
  // And then filter commits, after that tag?

  const lastTagPushed = await getLastTag(workspaceRoot);
  logger.log(`Last pushed tag: ${lastTagPushed || farver.dim("none")}`);

  if (!lastTagPushed) {
    logger.warn("No tags found in the repository. All commits will be considered for release.");
  }

  const allCommits = await getAllWorkspaceCommits(workspaceRoot, lastTagPushed);

  // Get commits affecting each package
  const packageCommits = await getWorkspacePackageCommits(workspaceRoot, workspacePackages);

  // Get global commits, that may affect multiple packages
  const globalCommitsAffectingPackages = await getGlobalCommits(
    workspaceRoot,
    allCommits,
    packageCommits,
    normalizedOptions.globalCommitMode,
  );

  const versionUpdates = await inferVersionUpdates({
    workspacePackages,
    packageCommits,
    workspaceRoot,
    showPrompt: options.prompts?.versions !== false,
    allCommits,
    globalCommits: globalCommitsAffectingPackages,
  });

  if (versionUpdates.length === 0) {
    logger.warn("No packages have changes requiring a release");
  }

  const graph = buildPackageDependencyGraph(workspacePackages);
  console.error("Dependency graph built");
  console.error(graph);

  // Get all packages needing updates (includes transitive dependents)
  const allUpdates = createDependentUpdates(
    graph,
    workspacePackages,
    versionUpdates,
  );

  logger.log(`Total packages to update (including dependents): ${allUpdates.length}`);
  for (const update of allUpdates) {
    logger.log(`- ${update.package.name}: ${farver.dim(update.currentVersion)} -> ${farver.bold(update.newVersion)}`);
  }

  return {
    updates: [],
    // prUrl: pullRequest?.html_url,
    // created: !prExists,
    created: false,
  };
}
