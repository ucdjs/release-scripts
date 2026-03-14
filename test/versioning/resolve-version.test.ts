import { describe, expect, it } from "vitest";
import { resolveAutoVersion } from "../../src/versioning/version";
import { createCommit, createWorkspacePackage } from "../_shared";

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
    // determinedBump still reflects the actual commits
    expect(result.determinedBump).toBe("patch");
  });

  it("applies override type without version", () => {
    const pkg = createWorkspacePackage("/repo/a", { version: "1.0.0" });
    const commits = [createCommit({ type: "fix" })];
    const result = resolveAutoVersion(pkg, commits, [], { type: "minor", version: "" });
    expect(result.effectiveBump).toBe("minor");
    // resolved version falls back to auto since override version is empty
    expect(result.resolvedVersion).toBe("1.0.1");
  });

  it("uses override type when set to none (as-is)", () => {
    const pkg = createWorkspacePackage("/repo/a", { version: "1.0.0" });
    const commits = [createCommit({ type: "feat" })];
    const result = resolveAutoVersion(pkg, commits, [], { type: "none", version: "1.0.0" });
    // "none" is a truthy string, so effectiveBump = "none"
    expect(result.effectiveBump).toBe("none");
    expect(result.resolvedVersion).toBe("1.0.0");
  });
});
