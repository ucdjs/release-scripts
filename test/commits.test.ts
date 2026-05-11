import { describe, expect, it } from "vitest";

import {
  DEPENDENCY_FILES,
  fileMatchesPackageFolder,
  filterGlobalCommits,
  findCommitRange,
  isGlobalCommit,
} from "../src/commits";
import { determineHighestBump } from "../src/versions";
import { createCommit } from "./_shared";

describe("determineHighestBump", () => {
  it("should return 'none' for empty commit list", () => {
    const result = determineHighestBump([]);
    expect(result).toBe("none");
  });

  it("should return 'patch' if only patch commits are present", () => {
    const result = determineHighestBump([
      createCommit({
        message: "fix: bug fix",
        type: "fix",
        isConventional: true,
      }),
      createCommit({
        message: "chore: update dependencies",
        type: "fix",
        isConventional: true,
      }),
    ]);

    expect(result).toBe("patch");
  });

  it("should return 'minor' if minor and patch commits are present", () => {
    const result = determineHighestBump([
      createCommit({
        message: "feat: new feature",
        type: "feat",
        isConventional: true,
      }),
      createCommit({
        message: "fix: bug fix",
        type: "fix",
        isConventional: true,
      }),
    ]);

    expect(result).toBe("minor");
  });

  it("should return 'major' if a breaking change commit is present", () => {
    const result = determineHighestBump([
      createCommit({
        message: "feat: new feature\n\nBREAKING CHANGE: changes API",
        type: "feat",
        isConventional: true,
        isBreaking: true,
      }),
      createCommit({
        message: "fix: bug fix",
        type: "fix",
        isConventional: true,
      }),
    ]);

    expect(result).toBe("major");
  });

  it("should ignore non-conventional commits", () => {
    const result = determineHighestBump([
      createCommit({
        message: "Some random commit message",
        isConventional: false,
        type: "",
      }),
      createCommit({
        message: "fix: bug fix",
        type: "fix",
        isConventional: true,
      }),
    ]);

    expect(result).toBe("patch");
  });
});

describe("fileMatchesPackageFolder", () => {
  it("matches files inside package folder", () => {
    expect(
      fileMatchesPackageFolder("packages/a/src/index.ts", new Set(["packages/a"]), "/repo"),
    ).toBe(true);
  });

  it("does not match files outside package folders", () => {
    expect(fileMatchesPackageFolder("package.json", new Set(["packages/a"]), "/repo")).toBe(false);
  });

  it("handles absolute package paths", () => {
    expect(
      fileMatchesPackageFolder("packages/a/file.ts", new Set(["/repo/packages/a"]), "/repo"),
    ).toBe(true);
  });

  it("handles file path with leading ./", () => {
    expect(fileMatchesPackageFolder("./packages/a/file.ts", new Set(["packages/a"]), "/repo")).toBe(
      true,
    );
  });

  it("does not match partial folder name matches", () => {
    expect(fileMatchesPackageFolder("packages/abc/file.ts", new Set(["packages/a"]), "/repo")).toBe(
      false,
    );
  });
});

describe("isGlobalCommit", () => {
  const packagePaths = new Set(["packages/a", "packages/b"]);

  it("returns true when no files touch package folders", () => {
    expect(isGlobalCommit("/repo", ["package.json", "tsconfig.json"], packagePaths)).toBe(true);
  });

  it("returns false when any file touches a package folder", () => {
    expect(isGlobalCommit("/repo", ["packages/a/src/index.ts", "README.md"], packagePaths)).toBe(
      false,
    );
  });

  it("returns false for empty file list", () => {
    expect(isGlobalCommit("/repo", [], packagePaths)).toBe(false);
  });

  it("returns false for undefined file list", () => {
    expect(isGlobalCommit("/repo", undefined, packagePaths)).toBe(false);
  });
});

describe("findCommitRange", () => {
  it("returns oldest and newest commit hashes", () => {
    const map = new Map([
      ["pkg-a", [createCommit({ shortHash: "newest1" }), createCommit({ shortHash: "oldest1" })]],
      ["pkg-b", [createCommit({ shortHash: "newest2" }), createCommit({ shortHash: "oldest2" })]],
    ]);
    const result = findCommitRange(map);
    expect(result).not.toBeNull();
    expect(result!.newest).toBe("newest1");
    expect(result!.oldest).toBe("oldest2");
  });

  it("returns null for empty map", () => {
    expect(findCommitRange(new Map())).toBeNull();
  });

  it("returns null when all packages have empty commit lists", () => {
    const map = new Map([["pkg-a", []]]);
    expect(findCommitRange(map)).toBeNull();
  });
});

describe("filterGlobalCommits", () => {
  const packagePaths = new Set(["packages/a", "packages/b"]);

  it("returns all global commits in 'all' mode", () => {
    const commits = [
      createCommit({ shortHash: "c1" }),
      createCommit({ shortHash: "c2" }),
      createCommit({ shortHash: "c3" }),
    ];
    const filesMap = new Map([
      ["c1", ["package.json"]],
      ["c2", ["packages/a/src/index.ts"]],
      ["c3", ["tsconfig.json"]],
    ]);

    const result = filterGlobalCommits(commits, filesMap, packagePaths, "/repo", "all");
    expect(result).toHaveLength(2);
    expect(result.map((c) => c.shortHash)).toEqual(["c1", "c3"]);
  });

  it("returns only dependency-touching commits in 'dependencies' mode", () => {
    const commits = [
      createCommit({ shortHash: "c1" }),
      createCommit({ shortHash: "c2" }),
      createCommit({ shortHash: "c3" }),
    ];
    const filesMap = new Map([
      ["c1", ["package.json"]],
      ["c2", ["packages/a/src/index.ts"]],
      ["c3", ["tsconfig.json"]],
    ]);

    const result = filterGlobalCommits(commits, filesMap, packagePaths, "/repo", "dependencies");
    expect(result).toHaveLength(1);
    expect(result[0]!.shortHash).toBe("c1");
  });

  it("excludes commits touching package folders", () => {
    const commits = [createCommit({ shortHash: "c1" })];
    const filesMap = new Map([["c1", ["packages/a/index.ts"]]]);

    const result = filterGlobalCommits(commits, filesMap, packagePaths, "/repo", "all");
    expect(result).toHaveLength(0);
  });

  it("excludes commits with no file mapping", () => {
    const commits = [createCommit({ shortHash: "c1" })];
    const filesMap = new Map<string, string[]>();

    const result = filterGlobalCommits(commits, filesMap, packagePaths, "/repo", "all");
    expect(result).toHaveLength(0);
  });
});

describe("dependency files constant", () => {
  it("includes expected files", () => {
    expect(DEPENDENCY_FILES).toContain("package.json");
    expect(DEPENDENCY_FILES).toContain("pnpm-lock.yaml");
    expect(DEPENDENCY_FILES).toContain("pnpm-workspace.yaml");
  });
});
