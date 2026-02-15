import type { PublishStatus } from "#core/npm";
import type { NormalizedReleaseScriptsOptions } from "../options";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseChangelog } from "#core/changelog";
import { commitPaths, createAndPushPackageTag, getCurrentBranch, pushBranch } from "#core/git";
import { checkVersionExists, publishPackage } from "#core/npm";
import { discoverWorkspacePackages } from "#core/workspace";
import { exitWithError } from "#shared/errors";
import { logger, ucdjsReleaseOverridesPath } from "#shared/utils";
import { buildPackageDependencyGraph, getPackagePublishOrder } from "#versioning/package";
import farver from "farver";
import semver from "semver";

async function getReleaseBodyFromChangelog(
  workspaceRoot: string,
  packageName: string,
  packagePath: string,
  version: string,
): Promise<string | undefined> {
  const changelogPath = join(packagePath, "CHANGELOG.md");

  try {
    const changelogContent = await readFile(changelogPath, "utf-8");
    const parsed = parseChangelog(changelogContent);
    const entry = parsed.versions.find((v) => v.version === version);

    if (!entry) {
      return [
        `## ${packageName}@${version}`,
        "",
        "⚠️ Could not find a matching changelog entry for this version.",
        "",
        `Expected version ${version} in ${changelogPath}.`,
      ].join("\n");
    }

    return entry.content.trim();
  } catch {
    logger.verbose(`Could not read changelog entry for ${version} at ${changelogPath}`);
    return [
      `## ${packageName}@${version}`,
      "",
      "⚠️ Could not read package changelog while creating this release.",
      "",
      `Expected changelog file: ${changelogPath}`,
    ].join("\n");
  }
}

async function cleanupPublishedOverrides(
  options: NormalizedReleaseScriptsOptions,
  workspacePackages: { name: string; version: string }[],
  publishedPackageNames: string[],
): Promise<boolean> {
  if (publishedPackageNames.length === 0) {
    return false;
  }

  if (options.dryRun) {
    logger.verbose("Dry-run: skipping override cleanup");
    return false;
  }

  const overridesPath = join(options.workspaceRoot, ucdjsReleaseOverridesPath);
  let overrides: Record<string, { version: string; type: import("#shared/types").BumpKind }>;

  try {
    overrides = JSON.parse(await readFile(overridesPath, "utf-8"));
  } catch {
    return false;
  }

  const versionsByPackage = new Map(workspacePackages.map((pkg) => [pkg.name, pkg.version]));
  const publishedSet = new Set(publishedPackageNames);
  const removed: string[] = [];

  for (const [pkgName, override] of Object.entries(overrides)) {
    if (!publishedSet.has(pkgName)) {
      continue;
    }

    const currentVersion = versionsByPackage.get(pkgName);
    const current = currentVersion ? semver.valid(currentVersion) : null;
    const target = semver.valid(override.version);

    if (current && target && semver.gte(current, target)) {
      delete overrides[pkgName];
      removed.push(pkgName);
    }
  }

  if (removed.length === 0) {
    return false;
  }

  logger.step(`Cleaning up satisfied overrides (${removed.length})...`);

  if (Object.keys(overrides).length === 0) {
    await rm(overridesPath, { force: true });
    logger.success("Removed release override file (all entries satisfied)");
    return true;
  }

  await writeFile(overridesPath, JSON.stringify(overrides, null, 2), "utf-8");
  logger.success(`Removed satisfied overrides: ${removed.join(", ")}`);
  return true;
}

export async function publishWorkflow(options: NormalizedReleaseScriptsOptions): Promise<void> {
  logger.section("📦 Publishing Packages");

  // Discover workspace packages
  const discovered = await discoverWorkspacePackages(options.workspaceRoot, options);
  if (!discovered.ok) {
    exitWithError("Failed to discover packages.", undefined, discovered.error);
  }

  const workspacePackages = discovered.value;
  logger.item(`Found ${workspacePackages.length} packages in workspace`);

  // Build dependency graph for publish ordering
  const graph = buildPackageDependencyGraph(workspacePackages);

  // Filter out private packages
  const publicPackages = workspacePackages.filter((pkg) => !pkg.packageJson.private);
  logger.item(`Publishing ${publicPackages.length} public packages (private packages excluded)`);

  if (publicPackages.length === 0) {
    logger.warn("No public packages to publish");
    return;
  }

  // Get topological publish order
  const packagesToPublish = new Set(publicPackages.map((p) => p.name));
  const publishOrder = getPackagePublishOrder(graph, packagesToPublish);

  // Filter to only packages that actually need publishing (have updates)
  // We'll check each package's current version vs registry
  const status: PublishStatus = {
    published: [],
    skipped: [],
    failed: [],
  };

  for (const order of publishOrder) {
    const pkg = order.package;
    const version = pkg.version;
    const packageName = pkg.name;

    logger.section(`📦 ${farver.cyan(packageName)} ${farver.gray(`(level ${order.level})`)}`);

    // Check if version already exists on NPM
    logger.step(`Checking if ${farver.cyan(`${packageName}@${version}`)} exists on NPM...`);
    const existsResult = await checkVersionExists(packageName, version);

    if (!existsResult.ok) {
      logger.error(`Failed to check version: ${existsResult.error.message}`);
      status.failed.push(packageName);
      // Stop immediately on error
      exitWithError(
        `Publishing failed for ${packageName}.`,
        "Check your network connection and NPM registry access",
        existsResult.error,
      );
    }

    if (existsResult.value) {
      logger.info(`Version ${farver.cyan(version)} already exists on NPM, skipping`);
      status.skipped.push(packageName);
      continue;
    }

    // Publish to NPM
    logger.step(`Publishing ${farver.cyan(`${packageName}@${version}`)} to NPM...`);
    const publishResult = await publishPackage(packageName, version, options.workspaceRoot, options);

    if (!publishResult.ok) {
      logger.error(`Failed to publish: ${publishResult.error.message}`);
      status.failed.push(packageName);

      // Provide helpful error messages for common issues
      let hint: string | undefined;
      if (publishResult.error.code === "E403") {
        hint = "Authentication failed. Ensure your NPM token or OIDC configuration is correct";
      } else if (publishResult.error.code === "EPUBLISHCONFLICT") {
        hint = "Version conflict. The version may have been published recently";
      } else if (publishResult.error.code === "EOTP") {
        hint = "2FA/OTP required. Provide the otp option or use OIDC authentication";
      }

      exitWithError(`Publishing failed for ${packageName}`, hint, publishResult.error);
    }

    logger.success(`Published ${farver.cyan(`${packageName}@${version}`)}`);
    status.published.push(packageName);

    // Create and push git tag
    logger.step(`Creating git tag ${farver.cyan(`${packageName}@${version}`)}...`);
    const tagResult = await createAndPushPackageTag(packageName, version, options.workspaceRoot);
    const tagName = `${packageName}@${version}`;

    if (!tagResult.ok) {
      logger.error(`Failed to create/push tag: ${tagResult.error.message}`);
      status.failed.push(packageName);
      exitWithError(
        `Publishing failed for ${packageName}: could not create git tag`,
        "Ensure the workflow token can push tags (contents: write) and git credentials are configured",
        tagResult.error,
      );
    }

    logger.success(`Created and pushed tag ${farver.cyan(tagName)}`);

    logger.step(`Creating GitHub release for ${farver.cyan(tagName)}...`);
    try {
      const releaseBody = await getReleaseBodyFromChangelog(
        options.workspaceRoot,
        packageName,
        pkg.path,
        version,
      );

      const releaseResult = await options.githubClient.upsertReleaseByTag({
        tagName,
        name: tagName,
        body: releaseBody,
        prerelease: Boolean(semver.prerelease(version)),
      });

      if (releaseResult.release.htmlUrl) {
        logger.success(
          `${releaseResult.created ? "Created" : "Updated"} GitHub release: ${releaseResult.release.htmlUrl}`,
        );
      } else {
        logger.success(`${releaseResult.created ? "Created" : "Updated"} GitHub release for ${farver.cyan(tagName)}`);
      }
    } catch (error) {
      status.failed.push(packageName);
      exitWithError(
        `Publishing failed for ${packageName}: could not create GitHub release`,
        "Ensure the workflow token can write repository contents and releases",
        error,
      );
    }
  }

  // Print summary
  logger.section("📊 Publishing Summary");
  logger.item(`${farver.green("✓")} Published: ${status.published.length} package(s)`);
  if (status.published.length > 0) {
    for (const pkg of status.published) {
      logger.item(`  ${farver.green("•")} ${pkg}`);
    }
  }

  if (status.skipped.length > 0) {
    logger.item(`${farver.yellow("⚠")} Skipped (already exists): ${status.skipped.length} package(s)`);
    for (const pkg of status.skipped) {
      logger.item(`  ${farver.yellow("•")} ${pkg}`);
    }
  }

  if (status.failed.length > 0) {
    logger.item(`${farver.red("✖")} Failed: ${status.failed.length} package(s)`);
    for (const pkg of status.failed) {
      logger.item(`  ${farver.red("•")} ${pkg}`);
    }
  }

  if (status.failed.length > 0) {
    exitWithError(`Publishing completed with ${status.failed.length} failure(s)`);
  }

  const didCleanupOverrides = await cleanupPublishedOverrides(options, workspacePackages, status.published);

  if (didCleanupOverrides && !options.dryRun) {
    logger.step("Committing override cleanup...");
    const commitResult = await commitPaths(
      [ucdjsReleaseOverridesPath],
      "chore: cleanup release overrides",
      options.workspaceRoot,
    );

    if (!commitResult.ok) {
      exitWithError("Failed to commit override cleanup.", undefined, commitResult.error);
    }

    if (commitResult.value) {
      const currentBranch = await getCurrentBranch(options.workspaceRoot);
      if (!currentBranch.ok) {
        exitWithError("Failed to detect current branch for override cleanup push.", undefined, currentBranch.error);
      }

      const pushResult = await pushBranch(currentBranch.value, options.workspaceRoot);
      if (!pushResult.ok) {
        exitWithError("Failed to push override cleanup commit.", undefined, pushResult.error);
      }

      logger.success(`Pushed override cleanup commit to ${farver.cyan(currentBranch.value)}`);
    }
  }

  logger.success("All packages published successfully!");
}
