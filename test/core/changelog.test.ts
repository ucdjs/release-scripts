import type { GitCommit } from "commit-parser";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { generateChangelogEntry, parseChangelog, updateChangelog } from "#core/changelog";
import { dedent } from "@luxass/utils";
import * as tinyexec from "tinyexec";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testdir } from "vitest-testdirs";

vi.mock("tinyexec");
const mockExec = vi.mocked(tinyexec.x);

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.resetAllMocks();
});

function createTestCommit(overrides: Partial<GitCommit>): GitCommit {
  return {
    hash: overrides.hash || "abc1234567890",
    shortHash: overrides.shortHash || "abc1234",
    message: overrides.message || "test commit",
    type: overrides.type,
    scope: overrides.scope,
    isConventional: overrides.isConventional ?? (!!overrides.type),
    isBreaking: overrides.isBreaking ?? false,
    body: overrides.body,
    ...overrides,
  } as GitCommit;
}

describe("generateChangelogEntry", () => {
  it("should generate a changelog entry with features", () => {
    const commits = [
      createTestCommit({
        type: "feat",
        message: "feat: add new feature\n\nFixes #123",
        hash: "abc1234567890",
        shortHash: "abc1234",
      }),
    ];

    const entry = generateChangelogEntry({
      packageName: "@ucdjs/test",
      version: "0.2.0",
      previousVersion: "0.1.0",
      date: "2025-01-16",
      commits,
      owner: "ucdjs",
      repo: "test-repo",
    });

    expect(entry).toMatchInlineSnapshot(`
      "## [0.2.0](https://github.com/ucdjs/test-repo/compare/@ucdjs/test@0.1.0...@ucdjs/test@0.2.0) (2025-01-16)

      ### Features

      * feat: add new feature ([#123](https://github.com/ucdjs/test-repo/issues/123)) ([abc1234](https://github.com/ucdjs/test-repo/commit/abc1234567890))"
    `);
  });

  it("should generate a changelog entry with bug fixes", () => {
    const commits = [
      createTestCommit({
        type: "fix",
        message: "fix: fix critical bug",
        hash: "def5678901234",
        shortHash: "def5678",
      }),
    ];

    const entry = generateChangelogEntry({
      packageName: "@ucdjs/test",
      version: "0.1.1",
      previousVersion: "0.1.0",
      date: "2025-01-16",
      commits,
      owner: "ucdjs",
      repo: "test-repo",
    });

    expect(entry).toMatchInlineSnapshot(`
      "## [0.1.1](https://github.com/ucdjs/test-repo/compare/@ucdjs/test@0.1.0...@ucdjs/test@0.1.1) (2025-01-16)

      ### Bug Fixes

      * fix: fix critical bug ([def5678](https://github.com/ucdjs/test-repo/commit/def5678901234))"
    `);
  });

  it("should handle multiple commit types", () => {
    const commits = [
      createTestCommit({
        type: "feat",
        message: "feat: add feature A",
        hash: "aaa1111111111",
        shortHash: "aaa1111",
      }),
      createTestCommit({
        type: "fix",
        message: "fix: fix bug B\n\nCloses #456",
        hash: "bbb2222222222",
        shortHash: "bbb2222",
      }),
      createTestCommit({
        type: "chore",
        message: "chore: update dependencies",
        hash: "ccc3333333333",
        shortHash: "ccc3333",
      }),
    ];

    const entry = generateChangelogEntry({
      packageName: "@ucdjs/test",
      version: "0.3.0",
      previousVersion: "0.2.0",
      date: "2025-01-16",
      commits,
      owner: "ucdjs",
      repo: "test-repo",
    });

    expect(entry).toMatchInlineSnapshot(`
      "## [0.3.0](https://github.com/ucdjs/test-repo/compare/@ucdjs/test@0.2.0...@ucdjs/test@0.3.0) (2025-01-16)

      ### Features

      * feat: add feature A ([aaa1111](https://github.com/ucdjs/test-repo/commit/aaa1111111111))

      ### Bug Fixes

      * fix: fix bug B ([#456](https://github.com/ucdjs/test-repo/issues/456)) ([bbb2222](https://github.com/ucdjs/test-repo/commit/bbb2222222222))

      ### Miscellaneous

      * chore: update dependencies ([ccc3333](https://github.com/ucdjs/test-repo/commit/ccc3333333333))"
    `);
  });

  it("should handle first release without previous version", () => {
    const commits = [
      createTestCommit({
        type: "feat",
        message: "feat: initial release",
        hash: "initial123",
        shortHash: "initial",
      }),
    ];

    const entry = generateChangelogEntry({
      packageName: "@ucdjs/test",
      version: "0.1.0",
      date: "2025-01-16",
      commits,
      owner: "ucdjs",
      repo: "test-repo",
    });

    expect(entry).toMatchInlineSnapshot(`
      "## 0.1.0 (2025-01-16)

      ### Features

      * feat: initial release ([initial](https://github.com/ucdjs/test-repo/commit/initial123))"
    `);
  });

  it("should group perf commits with bug fixes", () => {
    const commits = [
      createTestCommit({
        type: "perf",
        message: "perf: improve performance",
        hash: "perf123456789",
        shortHash: "perf123",
      }),
    ];

    const entry = generateChangelogEntry({
      packageName: "@ucdjs/test",
      version: "0.1.1",
      previousVersion: "0.1.0",
      date: "2025-01-16",
      commits,
      owner: "ucdjs",
      repo: "test-repo",
    });

    expect(entry).toMatchInlineSnapshot(`
      "## [0.1.1](https://github.com/ucdjs/test-repo/compare/@ucdjs/test@0.1.0...@ucdjs/test@0.1.1) (2025-01-16)

      ### Bug Fixes

      * perf: improve performance ([perf123](https://github.com/ucdjs/test-repo/commit/perf123456789))"
    `);
  });

  it("should handle non-conventional commits", () => {
    const commits = [
      createTestCommit({
        message: "some random commit",
        hash: "random12345678",
        shortHash: "random1",
        isConventional: false,
      }),
    ];

    const entry = generateChangelogEntry({
      packageName: "@ucdjs/test",
      version: "0.1.1",
      previousVersion: "0.1.0",
      date: "2025-01-16",
      commits,
      owner: "ucdjs",
      repo: "test-repo",
    });

    expect(entry).toMatchInlineSnapshot(`
      "## [0.1.1](https://github.com/ucdjs/test-repo/compare/@ucdjs/test@0.1.0...@ucdjs/test@0.1.1) (2025-01-16)

      ### Miscellaneous

      * some random commit ([random1](https://github.com/ucdjs/test-repo/commit/random12345678))"
    `);
  });
});

describe("parseChangelog", () => {
  it("should parse changelog with package name", () => {
    const content = dedent`
      # @ucdjs/test

      ## 0.1.0 (2025-01-16)

      ### Features

      * initial release
    `;

    const parsed = parseChangelog(content);

    expect(parsed.packageName).toBe("@ucdjs/test");
    expect(parsed.headerLineEnd).toBe(0);
    expect(parsed.versions).toHaveLength(1);
    expect(parsed.versions[0]!.version).toBe("0.1.0");
  });

  it("should parse Vite-style changelog entries", () => {
    const content = dedent`
      # @ucdjs/test

      ## [0.2.0](https://github.com/ucdjs/test/compare/@ucdjs/test@0.1.0...@ucdjs/test@0.2.0) (2025-01-16)

      ### Features

      * new feature

      ## [0.1.0](https://github.com/ucdjs/test/compare/@ucdjs/test@0.0.1...@ucdjs/test@0.1.0) (2025-01-15)

      ### Bug Fixes

      * fix bug
    `;

    const parsed = parseChangelog(content);

    expect(parsed.versions).toHaveLength(2);
    expect(parsed.versions[0]!.version).toBe("0.2.0");
    expect(parsed.versions[1]!.version).toBe("0.1.0");
  });

  it("should parse Changesets-style changelog entries", () => {
    const content = dedent`
      # @ucdjs/test

      ## 0.1.0

      ### Minor Changes

      - [#172](https://github.com/ucdjs/test/pull/172) feat: add initial package
    `;

    const parsed = parseChangelog(content);

    expect(parsed.versions).toHaveLength(1);
    expect(parsed.versions[0]!.version).toBe("0.1.0");
    expect(parsed.versions[0]!.content).toContain("Minor Changes");
  });

  it("should parse mixed Vite and Changesets entries", () => {
    const content = dedent`
      # @ucdjs/test

      ## [0.2.0](https://github.com/ucdjs/test/compare/@ucdjs/test@0.1.0...@ucdjs/test@0.2.0) (2025-01-16)

      ### Features

      * new feature

      ## 0.1.0

      ### Minor Changes

      - [#172](https://github.com/ucdjs/test/pull/172) feat: initial release
    `;

    const parsed = parseChangelog(content);

    expect(parsed.versions).toHaveLength(2);
    expect(parsed.versions[0]!.version).toBe("0.2.0");
    expect(parsed.versions[1]!.version).toBe("0.1.0");
  });

  it("should handle changelog without package name", () => {
    const content = dedent`
      ## 0.1.0 (2025-01-16)

      ### Features

      * initial release
    `;

    const parsed = parseChangelog(content);

    expect(parsed.packageName).toBeNull();
    expect(parsed.versions).toHaveLength(1);
  });

  it("should handle empty changelog", () => {
    const content = "# @ucdjs/test\n";

    const parsed = parseChangelog(content);

    expect(parsed.packageName).toBe("@ucdjs/test");
    expect(parsed.versions).toHaveLength(0);
  });

  it("should handle changelog with <small> tags", () => {
    const content = dedent`
      # @ucdjs/test

      ## <small>[0.1.0](https://github.com/ucdjs/test/compare/v0.0.1...v0.1.0) (2025-01-16)</small>

      ### Bug Fixes

      * fix something
    `;

    const parsed = parseChangelog(content);

    expect(parsed.versions).toHaveLength(1);
    expect(parsed.versions[0]!.version).toBe("0.1.0");
  });
});

describe("updateChangelog", () => {
  it("should create a new changelog file", async () => {
    const testdirPath = await testdir({});

    // Mock git show to return empty (file doesn't exist on default branch)
    mockExec.mockRejectedValue(new Error("fatal: path 'CHANGELOG.md' does not exist"));

    const commits = [
      createTestCommit({
        type: "feat",
        message: "feat: add new feature",
        hash: "abc123",
        shortHash: "abc123",
      }),
    ];

    await updateChangelog({
      packageName: "@ucdjs/test",
      packagePath: testdirPath,
      version: "0.1.0",
      commits,
      owner: "ucdjs",
      repo: "test-repo",
      date: "2025-01-16",
      defaultBranch: "main",
      workspaceRoot: testdirPath,
    });

    const content = await readFile(join(testdirPath, "CHANGELOG.md"), "utf-8");

    expect(content).toMatchInlineSnapshot(`
      "# @ucdjs/test

      ## 0.1.0 (2025-01-16)

      ### Features

      * feat: add new feature ([abc123](https://github.com/ucdjs/test-repo/commit/abc123))
      "
    `);
  });

  it("should insert new version above existing entries", async () => {
    const testdirPath = await testdir({});

    const commits = [
      createTestCommit({
        type: "feat",
        message: "feat: add feature B",
        hash: "def456",
        shortHash: "def456",
      }),
    ];

    // First call: git show returns empty (no changelog on default branch yet)
    mockExec.mockRejectedValueOnce(new Error("fatal: path 'CHANGELOG.md' does not exist"));

    // Create initial changelog
    await updateChangelog({
      packageName: "@ucdjs/test",
      packagePath: testdirPath,
      version: "0.1.0",
      commits: [
        createTestCommit({
          type: "feat",
          message: "feat: initial release",
          hash: "abc123",
          shortHash: "abc123",
        }),
      ],
      owner: "ucdjs",
      repo: "test-repo",
      date: "2025-01-15",
      defaultBranch: "main",
      workspaceRoot: testdirPath,
    });

    // Read the created changelog to simulate what's on the default branch
    const existingChangelog = await readFile(join(testdirPath, "CHANGELOG.md"), "utf-8");

    // Second call: git show returns the existing changelog from "main"
    mockExec.mockResolvedValueOnce({ stdout: existingChangelog, stderr: "" });

    // Add new version
    await updateChangelog({
      packageName: "@ucdjs/test",
      packagePath: testdirPath,
      version: "0.2.0",
      previousVersion: "0.1.0",
      commits,
      owner: "ucdjs",
      repo: "test-repo",
      date: "2025-01-16",
      defaultBranch: "main",
      workspaceRoot: testdirPath,
    });

    const content = await readFile(join(testdirPath, "CHANGELOG.md"), "utf-8");

    expect(content).toMatchInlineSnapshot(`
      "# @ucdjs/test

      ## [0.2.0](https://github.com/ucdjs/test-repo/compare/@ucdjs/test@0.1.0...@ucdjs/test@0.2.0) (2025-01-16)

      ### Features

      * feat: add feature B ([def456](https://github.com/ucdjs/test-repo/commit/def456))


      ## 0.1.0 (2025-01-15)

      ### Features

      * feat: initial release ([abc123](https://github.com/ucdjs/test-repo/commit/abc123))
      "
    `);
  });

  it("should replace existing version entry (PR update)", async () => {
    const testdirPath = await testdir({});

    // First call: git show returns empty (no changelog on default branch - this is a release PR)
    mockExec.mockRejectedValueOnce(new Error("fatal: path 'CHANGELOG.md' does not exist"));

    // Create initial version
    await updateChangelog({
      packageName: "@ucdjs/test",
      packagePath: testdirPath,
      version: "0.2.0",
      commits: [
        createTestCommit({
          type: "feat",
          message: "feat: add feature A",
          hash: "abc123",
          shortHash: "abc123",
        }),
      ],
      owner: "ucdjs",
      repo: "test-repo",
      date: "2025-01-16",
      defaultBranch: "main",
      workspaceRoot: testdirPath,
    });

    // Second call: git show still returns empty (main branch doesn't have 0.2.0 yet)
    // This simulates a PR update where we add more commits to the same release
    mockExec.mockRejectedValueOnce(new Error("fatal: path 'CHANGELOG.md' does not exist"));

    // Update same version with more commits
    await updateChangelog({
      packageName: "@ucdjs/test",
      packagePath: testdirPath,
      version: "0.2.0",
      commits: [
        createTestCommit({
          type: "feat",
          message: "feat: add feature A",
          hash: "abc123",
          shortHash: "abc123",
        }),
        createTestCommit({
          type: "feat",
          message: "feat: add feature B",
          hash: "def456",
          shortHash: "def456",
        }),
      ],
      owner: "ucdjs",
      repo: "test-repo",
      date: "2025-01-16",
      defaultBranch: "main",
      workspaceRoot: testdirPath,
    });

    const content = await readFile(join(testdirPath, "CHANGELOG.md"), "utf-8");
    const parsed = parseChangelog(content);

    // Should still have only one version entry
    expect(parsed.versions).toHaveLength(1);
    expect(parsed.versions[0]!.version).toBe("0.2.0");

    // Should contain both features
    expect(content).toContain("add feature A");
    expect(content).toContain("add feature B");
  });
});
