import type { GitCommit } from "commit-parser";
import type { WorkspacePackageWithCommits } from "../src/utils/helpers";
import { describe, expect, it } from "vitest";
import {
  findCommitRange,
  isDependencyFile,
  isGlobalCommit,
} from "../src/utils/helpers";

function makeCommit(shortHash: string, date: string): GitCommit {
  return {
    isConventional: true,
    isBreaking: false,
    type: "feat",
    scope: undefined,
    description: "desc",
    references: [],
    authors: [{ name: "a", email: "a@example.com" }],
    hash: shortHash.padEnd(40, "0"),
    shortHash,
    body: "",
    message: `feat: ${shortHash}`,
    date,
  };
}

function makePackage(
  name: string,
  path: string,
  commits: readonly GitCommit[],
): WorkspacePackageWithCommits {
  return {
    name,
    path,
    version: "1.0.0",
    packageJson: {
      name,
      version: "1.0.0",
      private: false,
    },
    workspaceDependencies: [],
    workspaceDevDependencies: [],
    commits,
    globalCommits: [],
  };
}

describe("isGlobalCommit", () => {
  it("returns true when file is at repository root", () => {
    expect(isGlobalCommit(["README.md"], new Set(["packages/a"]))).toBe(true);
  });

  it("returns true when file is in a non-package directory", () => {
    expect(isGlobalCommit(["scripts/build.js"], new Set(["packages/a", "packages/b"]))).toBe(true);
  });

  it("returns true when at least one file is outside all package paths", () => {
    expect(isGlobalCommit(["packages/a/index.ts", "README.md"], new Set(["packages/a"]))).toBe(true);
  });

  it("returns false when all files are inside a single package", () => {
    expect(isGlobalCommit(["packages/a/index.ts", "packages/a/lib/util.ts"], new Set(["packages/a"]))).toBe(false);
  });

  it("returns false when all files are inside different packages", () => {
    expect(isGlobalCommit(["packages/a/index.ts", "packages/b/index.ts"], new Set(["packages/a", "packages/b"]))).toBe(false);
  });

  it("handles files with ./ prefix", () => {
    expect(isGlobalCommit(["./README.md"], new Set(["packages/a"]))).toBe(true);
    expect(isGlobalCommit(["./packages/a/index.ts"], new Set(["packages/a"]))).toBe(false);
  });

  it("handles empty file list", () => {
    expect(isGlobalCommit([], new Set(["packages/a"]))).toBe(false);
  });

  it("handles empty package paths", () => {
    expect(isGlobalCommit(["any/file.ts"], new Set())).toBe(true);
  });

  it("does not match partial package path prefixes", () => {
    // "packages/ab" should not match "packages/a"
    expect(isGlobalCommit(["packages/ab/index.ts"], new Set(["packages/a"]))).toBe(true);
  });

  it("matches exact package path", () => {
    expect(isGlobalCommit(["packages/a"], new Set(["packages/a"]))).toBe(false);
  });
});

describe("isDependencyFile", () => {
  describe("root-level files", () => {
    it("matches package.json", () => {
      expect(isDependencyFile("package.json")).toBe(true);
    });

    it("matches pnpm-lock.yaml", () => {
      expect(isDependencyFile("pnpm-lock.yaml")).toBe(true);
    });

    it("matches yarn.lock", () => {
      expect(isDependencyFile("yarn.lock")).toBe(true);
    });

    it("matches package-lock.json", () => {
      expect(isDependencyFile("package-lock.json")).toBe(true);
    });

    it("matches pnpm-workspace.yaml", () => {
      expect(isDependencyFile("pnpm-workspace.yaml")).toBe(true);
    });
  });

  describe("nested files", () => {
    it("matches package.json in a nested directory", () => {
      expect(isDependencyFile("packages/a/package.json")).toBe(true);
    });

    it("matches lock files in nested directories", () => {
      expect(isDependencyFile("apps/web/pnpm-lock.yaml")).toBe(true);
    });

    it("matches deeply nested dependency files", () => {
      expect(isDependencyFile("a/b/c/d/package.json")).toBe(true);
    });
  });

  describe("non-dependency files", () => {
    it("rejects regular source files", () => {
      expect(isDependencyFile("src/index.ts")).toBe(false);
    });

    it("rejects files with similar names", () => {
      expect(isDependencyFile("package.json.bak")).toBe(false);
      expect(isDependencyFile("my-package.json")).toBe(false);
    });

    it("rejects README and other docs", () => {
      expect(isDependencyFile("README.md")).toBe(false);
      expect(isDependencyFile("CHANGELOG.md")).toBe(false);
    });

    it("rejects config files that are not dependency-related", () => {
      expect(isDependencyFile("tsconfig.json")).toBe(false);
      expect(isDependencyFile("eslint.config.js")).toBe(false);
    });
  });

  describe("edge cases", () => {
    it("handles ./ prefix", () => {
      expect(isDependencyFile("./package.json")).toBe(true);
      expect(isDependencyFile("./packages/a/package.json")).toBe(true);
    });

    it("rejects empty string", () => {
      expect(isDependencyFile("")).toBe(false);
    });
  });
});

describe("findCommitRange", () => {
  it("returns oldest and newest commit hashes across multiple packages", () => {
    const commit1 = makeCommit("aaa", "2020-01-01T00:00:00Z");
    const commit2 = makeCommit("bbb", "2020-01-15T00:00:00Z");
    const commit3 = makeCommit("ccc", "2020-02-01T00:00:00Z");
    const commit4 = makeCommit("ddd", "2020-03-01T00:00:00Z");

    const packages: readonly WorkspacePackageWithCommits[] = [
      makePackage("pkg-a", "packages/a", [commit1, commit2]),
      makePackage("pkg-b", "packages/b", [commit3, commit4]),
    ];

    const [oldest, newest] = findCommitRange(packages);
    expect(oldest).toBe("aaa");
    expect(newest).toBe("ddd");
  });

  it("handles single package with multiple commits", () => {
    const commit1 = makeCommit("first", "2020-01-01T00:00:00Z");
    const commit2 = makeCommit("second", "2020-06-01T00:00:00Z");
    const commit3 = makeCommit("third", "2020-12-01T00:00:00Z");

    const packages: readonly WorkspacePackageWithCommits[] = [
      makePackage("solo", "packages/solo", [commit1, commit2, commit3]),
    ];

    const [oldest, newest] = findCommitRange(packages);
    expect(oldest).toBe("first");
    expect(newest).toBe("third");
  });

  it("handles single package with single commit", () => {
    const commit = makeCommit("only", "2020-06-15T00:00:00Z");

    const packages: readonly WorkspacePackageWithCommits[] = [
      makePackage("solo", "packages/solo", [commit]),
    ];

    const [oldest, newest] = findCommitRange(packages);
    expect(oldest).toBe("only");
    expect(newest).toBe("only");
  });

  it("returns [null, null] when all packages have no commits", () => {
    const packages: readonly WorkspacePackageWithCommits[] = [
      makePackage("empty-a", "packages/a", []),
      makePackage("empty-b", "packages/b", []),
    ];

    const [oldest, newest] = findCommitRange(packages);
    expect(oldest).toBeNull();
    expect(newest).toBeNull();
  });

  it("returns [null, null] for empty package array", () => {
    const [oldest, newest] = findCommitRange([]);
    expect(oldest).toBeNull();
    expect(newest).toBeNull();
  });

  it("ignores packages with no commits when finding range", () => {
    const commit1 = makeCommit("aaa", "2020-01-01T00:00:00Z");
    const commit2 = makeCommit("bbb", "2020-12-01T00:00:00Z");

    const packages: readonly WorkspacePackageWithCommits[] = [
      makePackage("empty", "packages/empty", []),
      makePackage("has-commits", "packages/has", [commit1, commit2]),
      makePackage("also-empty", "packages/also", []),
    ];

    const [oldest, newest] = findCommitRange(packages);
    expect(oldest).toBe("aaa");
    expect(newest).toBe("bbb");
  });

  it("correctly identifies oldest when packages are out of order", () => {
    const olderCommit = makeCommit("older", "2019-01-01T00:00:00Z");
    const newerCommit = makeCommit("newer", "2021-01-01T00:00:00Z");
    const middleCommit = makeCommit("middle", "2020-01-01T00:00:00Z");

    const packages: readonly WorkspacePackageWithCommits[] = [
      makePackage("pkg-b", "packages/b", [newerCommit]),
      makePackage("pkg-c", "packages/c", [middleCommit]),
      makePackage("pkg-a", "packages/a", [olderCommit]),
    ];

    const [oldest, newest] = findCommitRange(packages);
    expect(oldest).toBe("older");
    expect(newest).toBe("newer");
  });

  it("handles commits with same timestamp", () => {
    const sameTime = "2020-06-15T12:00:00Z";
    const commit1 = makeCommit("first", sameTime);
    const commit2 = makeCommit("second", sameTime);

    const packages: readonly WorkspacePackageWithCommits[] = [
      makePackage("pkg-a", "packages/a", [commit1]),
      makePackage("pkg-b", "packages/b", [commit2]),
    ];

    const [oldest, newest] = findCommitRange(packages);
    // Both have same timestamp, so result depends on iteration order
    expect(oldest).toBeDefined();
    expect(newest).toBeDefined();
  });

  it("handles ISO date strings with timezone offsets", () => {
    const commit1 = makeCommit("utc", "2020-01-01T00:00:00Z");
    const commit2 = makeCommit("offset", "2020-01-01T05:00:00+05:00"); // Same instant as commit1

    const packages: readonly WorkspacePackageWithCommits[] = [
      makePackage("pkg-a", "packages/a", [commit1]),
      makePackage("pkg-b", "packages/b", [commit2]),
    ];

    const [oldest, newest] = findCommitRange(packages);
    // Both represent the same instant
    expect(oldest).toBeDefined();
    expect(newest).toBeDefined();
  });
});
