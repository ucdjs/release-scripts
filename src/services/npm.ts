import process from "node:process";

import type { NormalizedReleaseScriptsOptions } from "../options";
import { formatUnknownError } from "../shared/errors";
import { logger, runIfNotDryEffect } from "../shared/utils";
import { Cause, Context, Data, Effect, Exit, Layer } from "effect";
import semver from "semver";

export class NPMError extends Data.TaggedError("NPMError")<{
  operation: string;
  message: string;
  code?: string;
  stderr?: string;
  status?: number;
}> {}

interface NPMPackageMetadata {
  name: string;
  "dist-tags": Record<string, string>;
  versions: Record<string, unknown>;
  time?: Record<string, string>;
}

export interface NpmServiceShape {
  readonly checkVersionExists: (
    packageName: string,
    version: string,
  ) => Effect.Effect<boolean, unknown, unknown>;
  readonly publishPackage: (
    packageName: string,
    version: string,
    workspaceRoot: string,
    options: NormalizedReleaseScriptsOptions,
  ) => Effect.Effect<void, unknown, unknown>;
}

function toNPMError(operation: string, error: unknown, code?: string): NPMError {
  const formatted = formatUnknownError(error);
  return new NPMError({
    operation,
    message: formatted.message,
    code: code || formatted.code,
    stderr: formatted.stderr,
    status: formatted.status,
  });
}

function classifyPublishErrorCode(error: unknown): string | undefined {
  const formatted = formatUnknownError(error);
  const combined = [formatted.message, formatted.stderr].filter(Boolean).join("\n");

  if (
    combined.includes("E403") ||
    combined.toLowerCase().includes("access token expired or revoked")
  ) {
    return "E403";
  }

  if (
    combined.includes("EPUBLISHCONFLICT") ||
    combined.includes("E409") ||
    combined.includes("409 Conflict") ||
    combined.includes("Failed to save packument")
  ) {
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

function getRegistryURL(): string {
  return process.env.NPM_CONFIG_REGISTRY || "https://registry.npmjs.org";
}

export class NpmService extends Context.Service<NpmService, NpmServiceShape>()(
  "@ucdjs/release-scripts/NpmService",
) {}

// oxlint-disable-next-line require-yield
export const makeNpmService = Effect.fn("makeNpmService")(function* () {
  const getPackageMetadata = Effect.fn("getPackageMetadata")(function* (packageName: string) {
    const registry = getRegistryURL();
    const encodedName = packageName.startsWith("@")
      ? `@${encodeURIComponent(packageName.slice(1))}`
      : encodeURIComponent(packageName);

    const responseExit = yield* Effect.exit(
      Effect.tryPromise(() =>
        fetch(`${registry}/${encodedName}`, {
          headers: {
            Accept: "application/json",
          },
          signal: AbortSignal.timeout(30_000),
        }),
      ),
    );

    if (Exit.isFailure(responseExit)) {
      return yield* Effect.fail(toNPMError("getPackageMetadata", responseExit.cause, "ENETWORK"));
    }

    const response = responseExit.value;

    if (!response.ok) {
      if (response.status === 404) {
        return yield* Effect.fail(
          toNPMError("getPackageMetadata", `Package not found: ${packageName}`, "E404"),
        );
      }
      return yield* Effect.fail(
        toNPMError("getPackageMetadata", `HTTP ${response.status}: ${response.statusText}`),
      );
    }

    const metadata = (yield* Effect.tryPromise(() => response.json())) as NPMPackageMetadata;
    return metadata;
  });

  const checkVersionExists: NpmServiceShape["checkVersionExists"] = Effect.fn(
    "checkVersionExists",
  )(function* (packageName, version) {
    const metadataExit = yield* Effect.exit(getPackageMetadata(packageName));
    if (Exit.isFailure(metadataExit)) {
      const error = Cause.squash(metadataExit.cause);
      if (formatUnknownError(error).code === "E404") {
        return false;
      }
      return yield* Effect.fail(error);
    }

    return version in metadataExit.value.versions;
  });

  const publishPackage: NpmServiceShape["publishPackage"] = Effect.fn("publishPackage")(function* (
    packageName,
    version,
    workspaceRoot,
    options,
  ) {
    const args: string[] = [
      "--filter",
      packageName,
      "publish",
      "--access",
      options.npm.access,
      "--no-git-checks",
    ];

    if (options.npm.otp) {
      args.push("--otp", options.npm.otp);
    }

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
        const result = yield* runIfNotDryEffect("pnpm", args, {
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

        return;
      } catch (error) {
        const code = classifyPublishErrorCode(error);
        const isRetriableConflict = code === "EPUBLISHCONFLICT" && attempt < maxAttempts;

        if (isRetriableConflict) {
          const delay = backoffMs[attempt - 1] ?? backoffMs.at(-1)!;
          logger.warn(
            `Publish conflict for ${packageName}@${version} (attempt ${attempt}/${maxAttempts}). Retrying in ${Math.ceil(delay / 1000)}s...`,
          );
          yield* Effect.tryPromise(() => wait(delay));
          continue;
        }

        return yield* Effect.fail(toNPMError("publishPackage", error, code));
      }
    }

    return yield* Effect.fail(
      toNPMError(
        "publishPackage",
        new Error(`Failed to publish ${packageName}@${version} after ${maxAttempts} attempts`),
        "EPUBLISHCONFLICT",
      ),
    );
  });

  return NpmService.of({
    checkVersionExists,
    publishPackage,
  });
});

export const NpmServiceLive = Layer.effect(NpmService, makeNpmService());

export const checkVersionExists = Effect.fn("checkVersionExists")(function* (
  packageName: string,
  version: string,
) {
  const npm = yield* NpmService;
  return yield* npm.checkVersionExists(packageName, version);
});

export const publishPackage = Effect.fn("publishPackage")(function* (
  packageName: string,
  version: string,
  workspaceRoot: string,
  options: NormalizedReleaseScriptsOptions,
) {
  const npm = yield* NpmService;
  return yield* npm.publishPackage(packageName, version, workspaceRoot, options);
});

export interface PublishStatus {
  published: string[];
  skipped: string[];
  failed: string[];
}
