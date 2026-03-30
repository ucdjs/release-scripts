import type { BumpKind } from "#shared/types";
import semver from "semver";

export function isValidSemver(version: string): boolean {
  return semver.valid(version) != null;
}

export function getNextVersion(currentVersion: string, bump: BumpKind): string {
  if (bump === "none") {
    return currentVersion;
  }

  if (!isValidSemver(currentVersion)) {
    throw new Error(`Cannot bump version for invalid semver: ${currentVersion}`);
  }

  // If currently a prerelease, stay in the same prerelease track rather than
  // promoting to stable. Use the existing identifier (e.g. "beta") if present.
  if (semver.prerelease(currentVersion)) {
    const identifier = getPrereleaseIdentifier(currentVersion);
    const next = identifier
      ? semver.inc(currentVersion, "prerelease", identifier)
      : semver.inc(currentVersion, "prerelease");
    if (!next) {
      throw new Error(`Failed to bump prerelease version ${currentVersion}`);
    }
    return next;
  }

  const next = semver.inc(currentVersion, bump);
  if (!next) {
    throw new Error(`Failed to bump version ${currentVersion} with bump ${bump}`);
  }

  return next;
}

/**
 * Like getNextVersion but always produces a stable version, even when
 * currentVersion is a prerelease. Use this when the caller explicitly wants
 * to promote to a stable release (e.g. patch/minor/major prompt choices).
 */
export function getNextStableVersion(currentVersion: string, bump: Exclude<BumpKind, "none">): string {
  if (!isValidSemver(currentVersion)) {
    throw new Error(`Cannot bump version for invalid semver: ${currentVersion}`);
  }

  const next = semver.inc(currentVersion, bump);
  if (!next) {
    throw new Error(`Failed to bump version ${currentVersion} with bump ${bump}`);
  }

  return next;
}

export function calculateBumpType(oldVersion: string, newVersion: string): BumpKind {
  if (!isValidSemver(oldVersion) || !isValidSemver(newVersion)) {
    throw new Error(`Cannot calculate bump type for invalid semver: ${oldVersion} or ${newVersion}`);
  }

  const diff = semver.diff(oldVersion, newVersion);
  if (!diff) {
    return "none";
  }

  if (diff === "major" || diff === "premajor") return "major";
  if (diff === "minor" || diff === "preminor") return "minor";
  if (diff === "patch" || diff === "prepatch" || diff === "prerelease") return "patch";

  if (semver.gt(newVersion, oldVersion)) {
    return "patch";
  }

  return "none";
}

export function getPrereleaseIdentifier(version: string): string | undefined {
  const parsed = semver.parse(version);
  if (!parsed || parsed.prerelease.length === 0) {
    return undefined;
  }

  const identifier = parsed.prerelease[0];
  return typeof identifier === "string" ? identifier : undefined;
}

export function getNextPrereleaseVersion(
  currentVersion: string,
  mode: "next" | "prepatch" | "preminor" | "premajor",
  identifier?: string,
): string {
  if (!isValidSemver(currentVersion)) {
    throw new Error(`Cannot bump prerelease for invalid semver: ${currentVersion}`);
  }

  const releaseType = mode === "next" ? "prerelease" : mode;
  const next = identifier
    ? semver.inc(currentVersion, releaseType, identifier)
    : semver.inc(currentVersion, releaseType);
  if (!next) {
    throw new Error(`Failed to compute prerelease version for ${currentVersion}`);
  }

  return next;
}
