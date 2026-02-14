import type { WorkspacePackage } from "#core/workspace";
import type { BumpKind, PackageRelease } from "#shared/types";
import type { GitCommit } from "commit-parser";
import { getNextVersion } from "./semver";

export function determineHighestBump(commits: GitCommit[]): BumpKind {
  if (commits.length === 0) {
    return "none";
  }

  let highestBump: BumpKind = "none";

  for (const commit of commits) {
    const bump = determineBumpType(commit);

    if (bump === "major") {
      return "major";
    }

    if (bump === "minor") {
      highestBump = "minor";
    } else if (bump === "patch" && highestBump === "none") {
      highestBump = "patch";
    }
  }

  return highestBump;
}

export function createVersionUpdate(
  pkg: WorkspacePackage,
  bump: BumpKind,
  hasDirectChanges: boolean,
): PackageRelease {
  const newVersion = getNextVersion(pkg.version, bump);

  return {
    package: pkg,
    currentVersion: pkg.version,
    newVersion,
    bumpType: bump,
    hasDirectChanges,
  };
}

function determineBumpType(commit: GitCommit): BumpKind {
  if (!commit.isConventional) {
    return "none";
  }

  if (commit.isBreaking) {
    return "major";
  }

  if (commit.type === "feat") {
    return "minor";
  }

  if (commit.type === "fix" || commit.type === "perf") {
    return "patch";
  }

  return "none";
}
