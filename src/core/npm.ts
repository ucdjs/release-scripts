import type { Result } from "#types";
import type { NormalizedReleaseScriptsOptions } from "../options";
import process from "node:process";
import { formatUnknownError } from "#shared/errors";
import { runIfNotDry } from "#shared/utils";
import { err, ok } from "#types";

export interface NPMError {
  type: "npm";
  operation: string;
  message: string;
  code?: string;
  stderr?: string;
  status?: number;
}

export interface NPMPackageMetadata {
  "name": string;
  "dist-tags": Record<string, string>;
  "versions": Record<string, unknown>;
  "time"?: Record<string, string>;
}

function toNPMError(operation: string, error: unknown, code?: string): NPMError {
  const formatted = formatUnknownError(error);
  return {
    type: "npm",
    operation,
    message: formatted.message,
    code: code || formatted.code,
    stderr: formatted.stderr,
    status: formatted.status,
  };
}

/**
 * Get the NPM registry URL
 * Respects NPM_CONFIG_REGISTRY environment variable, defaults to npmjs.org
 */
function getRegistryURL(): string {
  return process.env.NPM_CONFIG_REGISTRY || "https://registry.npmjs.org";
}

/**
 * Fetch package metadata from NPM registry
 * @param packageName - The package name (e.g., "lodash" or "@scope/name")
 * @returns Result with package metadata or error
 */
export async function getPackageMetadata(
  packageName: string,
): Promise<Result<NPMPackageMetadata, NPMError>> {
  try {
    const registry = getRegistryURL();
    const encodedName = packageName.startsWith("@")
      ? `@${encodeURIComponent(packageName.slice(1))}`
      : encodeURIComponent(packageName);

    const response = await fetch(`${registry}/${encodedName}`, {
      headers: {
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      if (response.status === 404) {
        return err(toNPMError("getPackageMetadata", `Package not found: ${packageName}`, "E404"));
      }
      return err(toNPMError("getPackageMetadata", `HTTP ${response.status}: ${response.statusText}`));
    }

    const metadata = await response.json() as NPMPackageMetadata;
    return ok(metadata);
  } catch (error) {
    return err(toNPMError("getPackageMetadata", error, "ENETWORK"));
  }
}

/**
 * Check if a specific package version exists on NPM
 * @param packageName - The package name
 * @param version - The version to check (e.g., "1.2.3")
 * @returns Result with boolean (true if version exists) or error
 */
export async function checkVersionExists(
  packageName: string,
  version: string,
): Promise<Result<boolean, NPMError>> {
  const metadataResult = await getPackageMetadata(packageName);

  if (!metadataResult.ok) {
    // If package doesn't exist at all, version definitely doesn't exist
    if (metadataResult.error.code === "E404") {
      return ok(false);
    }
    return err(metadataResult.error);
  }

  const metadata = metadataResult.value;
  const exists = version in metadata.versions;

  return ok(exists);
}

/**
 * Build a package before publishing
 * @param packageName - The package name to build
 * @param workspaceRoot - Path to the workspace root
 * @param options - Normalized release scripts options
 * @returns Result indicating success or failure
 */
export async function buildPackage(
  packageName: string,
  workspaceRoot: string,
  options: NormalizedReleaseScriptsOptions,
): Promise<Result<void, NPMError>> {
  if (!options.npm.runBuild) {
    return ok(undefined);
  }

  try {
    await runIfNotDry("pnpm", ["--filter", packageName, "build"], {
      nodeOptions: {
        cwd: workspaceRoot,
        stdio: "inherit",
      },
    });
    return ok(undefined);
  } catch (error) {
    return err(toNPMError("buildPackage", error));
  }
}

/**
 * Publish a package to NPM
 * Uses pnpm to handle workspace protocol and catalog: resolution automatically
 * @param packageName - The package name to publish
 * @param workspaceRoot - Path to the workspace root
 * @param options - Normalized release scripts options
 * @returns Result indicating success or failure
 */
export async function publishPackage(
  packageName: string,
  workspaceRoot: string,
  options: NormalizedReleaseScriptsOptions,
): Promise<Result<void, NPMError>> {
  const args: string[] = [
    "--filter",
    packageName,
    "publish",
    "--access",
    options.npm.access,
    "--no-git-checks",
  ];

  // Add OTP if provided (for 2FA)
  if (options.npm.otp) {
    args.push("--otp", options.npm.otp);
  }

  // Add tag if specified (defaults to 'latest')
  // Users can override via NPM_CONFIG_TAG environment variable
  if (process.env.NPM_CONFIG_TAG) {
    args.push("--tag", process.env.NPM_CONFIG_TAG);
  }

  // Set up environment for OIDC/provenance
  const env: Record<string, string | undefined> = {
    ...process.env,
  };

  if (options.npm.provenance) {
    env.NPM_CONFIG_PROVENANCE = "true";
  }

  try {
    await runIfNotDry("pnpm", args, {
      nodeOptions: {
        cwd: workspaceRoot,
        stdio: "inherit",
        env,
      },
    });
    return ok(undefined);
  } catch (error) {
    const formatted = formatUnknownError(error);
    const errorMessage = formatted.message;
    // Check for specific error codes
    const code = errorMessage.includes("E403")
      ? "E403"
      : errorMessage.includes("EPUBLISHCONFLICT")
        ? "EPUBLISHCONFLICT"
        : errorMessage.includes("EOTP")
          ? "EOTP"
          : undefined;

    return err(toNPMError("publishPackage", error, code));
  }
}

/**
 * Publish workflow status for tracking progress
 */
export interface PublishStatus {
  published: string[];
  skipped: string[];
  failed: string[];
}
