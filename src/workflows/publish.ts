import type { PublishStatus } from "#core/npm";
import type { NormalizedReleaseScriptsOptions } from "../options";
import { createAndPushPackageTag } from "#core/git";
import { buildPackage, checkVersionExists, publishPackage } from "#core/npm";
import { discoverWorkspacePackages } from "#core/workspace";
import { exitWithError } from "#shared/errors";
import { logger } from "#shared/utils";
import { buildPackageDependencyGraph, getPackagePublishOrder } from "#versioning/package";
import farver from "farver";

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

    // Build package if enabled
    if (options.npm.runBuild) {
      logger.step(`Building ${farver.cyan(packageName)}...`);
      const buildResult = await buildPackage(packageName, options.workspaceRoot, options);

      if (!buildResult.ok) {
        logger.error(`Failed to build package: ${buildResult.error.message}`);
        status.failed.push(packageName);
        exitWithError(
          `Publishing failed for ${packageName}: build failed`,
          "Check your build scripts and dependencies",
          buildResult.error,
        );
      }
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

    if (!tagResult.ok) {
      logger.error(`Failed to create/push tag: ${tagResult.error.message}`);
      // Don't fail the whole process if tag creation fails, but warn
      logger.warn(`Package was published but tag was not created. You may need to create it manually.`);
    } else {
      logger.success(`Created and pushed tag ${farver.cyan(`${packageName}@${version}`)}`);
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

  logger.success("All packages published successfully!");
}
