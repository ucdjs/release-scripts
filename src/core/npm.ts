import type { Result } from "#types";
import type { NormalizedReleaseScriptsOptions } from "../options";
import process from "node:process";
import { formatUnknownError } from "#shared/errors";
import { logger, runIfNotDry } from "#shared/utils";
import { err, ok } from "#types";
import semver from "semver";

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

function classifyPublishErrorCode(error: unknown): string | undefined {
  const formatted = formatUnknownError(error);
  const combined = [formatted.message, formatted.stderr].filter(Boolean).join("\n");

  if (combined.includes("E403") || combined.toLowerCase().includes("access token expired or revoked")) {
    return "E403";
  }

  if (combined.includes("EPUBLISHCONFLICT") || combined.includes("E409") || combined.includes("409 Conflict") || combined.includes("Failed to save packument")) {
    return "EPUBLISHCONFLICT";
  }

  if (combined.includes("EOTP")) {
    return "EOTP";
  }

  return undefined;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
 * Publish a package to NPM
 * Uses pnpm to handle workspace protocol and catalog: resolution automatically
 * @param packageName - The package name to publish
 * @param version - The package version to publish
 * @param workspaceRoot - Path to the workspace root
 * @param options - Normalized release scripts options
 * @returns Result indicating success or failure
 */
export async function publishPackage(
  packageName: string,
  version: string,
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

  // Add tag if specified by env, otherwise infer for prereleases.
  // Stable releases default to npm's default tag behavior (latest).
  const explicitTag = process.env.NPM_CONFIG_TAG;
  const prereleaseTag = (() => {
    const prerelease = semver.prerelease(version);
    if (!prerelease || prerelease.length === 0) {
      return undefined;
    }

    const identifier = prerelease[0];
    if (identifier === "alpha" || identifier === "beta") {
      return identifier;
    }

    return "next";
  })();

  const publishTag = explicitTag || prereleaseTag;
  if (publishTag) {
    args.push("--tag", publishTag);
  }

  // Set up environment for OIDC/provenance
  const env: Record<string, string | undefined> = {
    ...process.env,
  };

  if (options.npm.provenance) {
    env.NPM_CONFIG_PROVENANCE = "true";
  }

  const maxAttempts = 4;
  const backoffMs = [3_000, 8_000, 15_000];

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await runIfNotDry("pnpm", args, {
        nodeOptions: {
          cwd: workspaceRoot,
          stdio: "pipe",
          env,
        },
      });

      if (result?.stdout && result.stdout.trim()) {
        logger.verbose(result.stdout.trim());
      }

      if (result?.stderr && result.stderr.trim()) {
        logger.verbose(result.stderr.trim());
      }

      return ok(undefined);
    } catch (error) {
      const code = classifyPublishErrorCode(error);
      const isRetriableConflict = code === "EPUBLISHCONFLICT" && attempt < maxAttempts;

      if (isRetriableConflict) {
        const delay = backoffMs[attempt - 1] ?? backoffMs[backoffMs.length - 1]!;
        logger.warn(
          `Publish conflict for ${packageName}@${version} (attempt ${attempt}/${maxAttempts}). Retrying in ${Math.ceil(delay / 1000)}s...`,
        );
        await wait(delay);
        continue;
      }

      return err(toNPMError("publishPackage", error, code));
    }
  }

  return err(
    toNPMError(
      "publishPackage",
      new Error(`Failed to publish ${packageName}@${version} after ${maxAttempts} attempts`),
      "EPUBLISHCONFLICT",
    ),
  );
}

/**
 * Publish workflow status for tracking progress
 */
export interface PublishStatus {
  published: string[];
  skipped: string[];
  failed: string[];
}
