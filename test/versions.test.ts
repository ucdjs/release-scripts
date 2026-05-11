import {
  calculateBumpType,
  computeDependencyRange,
  determineHighestBump,
  getNextPrereleaseVersion,
  getNextVersion,
  getPrereleaseIdentifier,
  isValidSemver,
  resolveAutoVersion,
} from "../src/versions";
import { describe, expect, it } from "vitest";

import { createCommit, createWorkspacePackage } from "./_shared";

describe("semver operations", () => {
  it("validates semver strings", () => {
    expect(isValidSemver("1.2.3")).toBe(true);
    expect(isValidSemver("1.2.3-beta.1")).toBe(true);
    expect(isValidSemver("1.2")).toBe(false);
  });

  it("calculates next versions", () => {
    expect(getNextVersion("1.0.0", "major")).toBe("2.0.0");
    expect(getNextVersion("1.0.0", "minor")).toBe("1.1.0");
    expect(getNextVersion("1.0.0", "patch")).toBe("1.0.1");
    expect(getNextVersion("1.0.0", "none")).toBe("1.0.0");
  });

  it("calculates bump types", () => {
    expect(calculateBumpType("1.0.0", "2.0.0")).toBe("major");
    expect(calculateBumpType("1.0.0", "1.1.0")).toBe("minor");
    expect(calculateBumpType("1.0.0", "1.0.1")).toBe("patch");
    expect(calculateBumpType("1.0.0", "1.0.0")).toBe("none");
  });

  it("supports prerelease helpers", () => {
    expect(getPrereleaseIdentifier("0.1.0-beta.46")).toBe("beta");
    expect(getPrereleaseIdentifier("0.1.0")).toBeUndefined();

    expect(getNextPrereleaseVersion("0.1.0-beta.46", "next", "beta")).toBe("0.1.0-beta.47");
    expect(getNextPrereleaseVersion("0.1.0", "prepatch", "beta")).toBe("0.1.1-beta.0");
    expect(getNextPrereleaseVersion("0.1.0", "preminor", "alpha")).toBe("0.2.0-alpha.0");
  });

  it("maps prerelease bumps to semantic bump kinds", () => {
    expect(calculateBumpType("0.1.0-beta.46", "0.1.0-beta.47")).toBe("patch");
    expect(calculateBumpType("0.1.0-beta.46", "0.1.1-beta.0")).toBe("patch");
    expect(calculateBumpType("0.1.0-beta.46", "0.2.0-beta.0")).toBe("minor");
  });
});

describe("version operations", () => {
  it("returns none for empty commits", () => {
    expect(determineHighestBump([])).toBe("none");
  });

  it("returns patch for fix commits", () => {
    const result = determineHighestBump([createCommit({ type: "fix", isConventional: true })]);
    expect(result).toBe("patch");
  });

  it("returns minor for feat commits", () => {
    const result = determineHighestBump([createCommit({ type: "feat", isConventional: true })]);
    expect(result).toBe("minor");
  });

  it("returns major for breaking commits", () => {
    const result = determineHighestBump([
      createCommit({ type: "feat", isBreaking: true, isConventional: true }),
    ]);
    expect(result).toBe("major");
  });
});

describe("computeDependencyRange", () => {
  it("returns null for workspace:* ranges", () => {
    expect(computeDependencyRange("workspace:*", "1.0.0", false)).toBeNull();
  });

  it("returns ^version for regular dependencies", () => {
    expect(computeDependencyRange("^0.5.0", "1.0.0", false)).toBe("^1.0.0");
  });

  it("returns range for peer dependencies", () => {
    expect(computeDependencyRange("^1.0.0", "2.0.0", true)).toBe(">=2.0.0 <3.0.0");
  });

  it("handles 0.x peer dependencies", () => {
    expect(computeDependencyRange("^0.1.0", "0.2.0", true)).toBe(">=0.2.0 <1.0.0");
  });

  it("ignores old range value for regular deps", () => {
    expect(computeDependencyRange("~0.5.0", "1.0.0", false)).toBe("^1.0.0");
    expect(computeDependencyRange(">=0.5.0", "1.0.0", false)).toBe("^1.0.0");
  });

  it("handles peer dependency with large major", () => {
    expect(computeDependencyRange("^10.0.0", "11.0.0", true)).toBe(">=11.0.0 <12.0.0");
  });
});

describe("resolveAutoVersion", () => {
  it("returns none bump for empty commits", () => {
    const pkg = createWorkspacePackage("/repo/a", { version: "1.0.0" });
    const result = resolveAutoVersion(pkg, [], []);
    expect(result.determinedBump).toBe("none");
    expect(result.resolvedVersion).toBe("1.0.0");
    expect(result.autoVersion).toBe("1.0.0");
  });

  it("returns minor for feat commits", () => {
    const pkg = createWorkspacePackage("/repo/a", { version: "1.0.0" });
    const commits = [createCommit({ type: "feat" })];
    const result = resolveAutoVersion(pkg, commits, []);
    expect(result.determinedBump).toBe("minor");
    expect(result.autoVersion).toBe("1.1.0");
    expect(result.resolvedVersion).toBe("1.1.0");
  });

  it("returns patch for fix commits", () => {
    const pkg = createWorkspacePackage("/repo/a", { version: "1.0.0" });
    const commits = [createCommit({ type: "fix" })];
    const result = resolveAutoVersion(pkg, commits, []);
    expect(result.determinedBump).toBe("patch");
    expect(result.autoVersion).toBe("1.0.1");
  });

  it("returns major for breaking change commits", () => {
    const pkg = createWorkspacePackage("/repo/a", { version: "1.0.0" });
    const commits = [createCommit({ type: "feat", isBreaking: true })];
    const result = resolveAutoVersion(pkg, commits, []);
    expect(result.determinedBump).toBe("major");
    expect(result.autoVersion).toBe("2.0.0");
  });

  it("combines package and global commits", () => {
    const pkg = createWorkspacePackage("/repo/a", { version: "1.0.0" });
    const pkgCommits = [createCommit({ type: "fix", shortHash: "abc0001" })];
    const globalCommits = [createCommit({ type: "feat", shortHash: "abc0002" })];
    const result = resolveAutoVersion(pkg, pkgCommits, globalCommits);
    expect(result.determinedBump).toBe("minor");
  });

  it("applies override version when present", () => {
    const pkg = createWorkspacePackage("/repo/a", { version: "1.0.0" });
    const commits = [createCommit({ type: "fix" })];
    const result = resolveAutoVersion(pkg, commits, [], { type: "major", version: "2.0.0" });
    expect(result.effectiveBump).toBe("major");
    expect(result.resolvedVersion).toBe("2.0.0");
    expect(result.determinedBump).toBe("patch");
  });

  it("applies override type without version", () => {
    const pkg = createWorkspacePackage("/repo/a", { version: "1.0.0" });
    const commits = [createCommit({ type: "fix" })];
    const result = resolveAutoVersion(pkg, commits, [], { type: "minor", version: "" });
    expect(result.effectiveBump).toBe("minor");
    expect(result.resolvedVersion).toBe("1.0.1");
  });

  it("uses override type when set to none (as-is)", () => {
    const pkg = createWorkspacePackage("/repo/a", { version: "1.0.0" });
    const commits = [createCommit({ type: "feat" })];
    const result = resolveAutoVersion(pkg, commits, [], { type: "none", version: "1.0.0" });
    expect(result.effectiveBump).toBe("none");
    expect(result.resolvedVersion).toBe("1.0.0");
  });
});
