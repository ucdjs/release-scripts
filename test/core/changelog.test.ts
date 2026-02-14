import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { generateChangelogEntry, parseChangelog, updateChangelog } from "#core/changelog";
import { DEFAULT_COMMIT_GROUPS } from "../../src/options";
import { dedent } from "@luxass/utils";
import * as tinyexec from "tinyexec";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testdir } from "vitest-testdirs";
import {
  createChangelogTestContext,
  createCommit,
  createGitHubClientStub,
} from "../_shared";

vi.mock("tinyexec");
const mockExec = vi.mocked(tinyexec.x);

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.resetAllMocks();
});

describe("generateChangelogEntry", () => {
  const baseEntryOptions = {
    packageName: "@ucdjs/test",
    owner: "ucdjs",
    repo: "test-repo",
  } as const;

  it("should generate a changelog entry with features", async () => {
    const commits = [
      createCommit({
        type: "feat",
        message: "feat: add new feature\n\nFixes #123",
        hash: "abc1234567890",
        shortHash: "abc1234",
        references: [{ type: "issue", value: "#123" }],
      }),
    ];

    const entry = await generateChangelogEntry({
      ...baseEntryOptions,
      version: "0.2.0",
      previousVersion: "0.1.0",
      date: "2025-01-16",
      commits,
      groups: DEFAULT_COMMIT_GROUPS,
      githubClient: createGitHubClientStub(),
    });

    expect(entry).toMatchInlineSnapshot(`
      "## [0.2.0](https://github.com/ucdjs/test-repo/compare/@ucdjs/test@0.1.0...@ucdjs/test@0.2.0) (2025-01-16)


      ### Features
      * feat: add new feature ([Issue #123](https://github.com/ucdjs/test-repo/issues/123)) ([abc1234](https://github.com/ucdjs/test-repo/commit/abc1234567890)) (by Test Author)"
    `);
  });

  it("should generate a changelog entry with bug fixes", async () => {
    const commits = [
      createCommit({
        type: "fix",
        message: "fix: fix critical bug",
        hash: "def5678901234",
        shortHash: "def5678",
      }),
    ];

    const entry = await generateChangelogEntry({
      ...baseEntryOptions,
      version: "0.1.1",
      previousVersion: "0.1.0",
      date: "2025-01-16",
      commits,
      groups: DEFAULT_COMMIT_GROUPS,
      githubClient: createGitHubClientStub(),
    });

    expect(entry).toMatchInlineSnapshot(`
      "## [0.1.1](https://github.com/ucdjs/test-repo/compare/@ucdjs/test@0.1.0...@ucdjs/test@0.1.1) (2025-01-16)


      ### Bug Fixes
      * fix: fix critical bug ([def5678](https://github.com/ucdjs/test-repo/commit/def5678901234)) (by Test Author)"
    `);
  });

  it("should handle multiple commit types", async () => {
    const commits = [
      createCommit({
        type: "feat",
        message: "feat: add feature A",
        hash: "aaa1111111111",
        shortHash: "aaa1111",
      }),
      createCommit({
        type: "fix",
        message: "fix: fix bug B\n\nCloses #456",
        hash: "bbb2222222222",
        shortHash: "bbb2222",
        references: [{ type: "issue", value: "#456" }],
      }),
      createCommit({
        type: "chore",
        message: "chore: update dependencies",
        hash: "ccc3333333333",
        shortHash: "ccc3333",
      }),
    ];

    const entry = await generateChangelogEntry({
      ...baseEntryOptions,
      version: "0.3.0",
      previousVersion: "0.2.0",
      date: "2025-01-16",
      commits,
      groups: DEFAULT_COMMIT_GROUPS,
      githubClient: createGitHubClientStub(),
    });

    expect(entry).toMatchInlineSnapshot(`
      "## [0.3.0](https://github.com/ucdjs/test-repo/compare/@ucdjs/test@0.2.0...@ucdjs/test@0.3.0) (2025-01-16)


      ### Features
      * feat: add feature A ([aaa1111](https://github.com/ucdjs/test-repo/commit/aaa1111111111)) (by Test Author)

      ### Bug Fixes
      * fix: fix bug B ([Issue #456](https://github.com/ucdjs/test-repo/issues/456)) ([bbb2222](https://github.com/ucdjs/test-repo/commit/bbb2222222222)) (by Test Author)"
    `);
  });

  it("should handle first release without previous version", async () => {
    const commits = [
      createCommit({
        type: "feat",
        message: "feat: initial release",
        hash: "initial123",
        shortHash: "initial",
      }),
    ];

    const entry = await generateChangelogEntry({
      ...baseEntryOptions,
      version: "0.1.0",
      date: "2025-01-16",
      commits,
      groups: DEFAULT_COMMIT_GROUPS,
      githubClient: createGitHubClientStub(),
    });

    expect(entry).toMatchInlineSnapshot(`
      "## 0.1.0 (2025-01-16)


      ### Features
      * feat: initial release ([initial](https://github.com/ucdjs/test-repo/commit/initial123)) (by Test Author)"
    `);
  });

  it("should group perf commits with bug fixes", async () => {
    const commits = [
      createCommit({
        type: "perf",
        message: "perf: improve performance",
        hash: "perf123456789",
        shortHash: "perf123",
      }),
    ];

    const entry = await generateChangelogEntry({
      ...baseEntryOptions,
      version: "0.1.1",
      previousVersion: "0.1.0",
      date: "2025-01-16",
      commits,
      groups: DEFAULT_COMMIT_GROUPS,
      githubClient: createGitHubClientStub(),
    });

    expect(entry).toMatchInlineSnapshot(`
      "## [0.1.1](https://github.com/ucdjs/test-repo/compare/@ucdjs/test@0.1.0...@ucdjs/test@0.1.1) (2025-01-16)


      ### Bug Fixes
      * perf: improve performance ([perf123](https://github.com/ucdjs/test-repo/commit/perf123456789)) (by Test Author)"
    `);
  });

  it("should handle non-conventional commits", async () => {
    const commits = [
      createCommit({
        message: "some random commit",
        hash: "random12345678",
        shortHash: "random1",
        isConventional: false,
      }),
    ];

    const entry = await generateChangelogEntry({
      ...baseEntryOptions,
      version: "0.1.1",
      previousVersion: "0.1.0",
      date: "2025-01-16",
      commits,
      groups: DEFAULT_COMMIT_GROUPS,
      githubClient: createGitHubClientStub(),
    });

    expect(entry).toMatchInlineSnapshot(`"## [0.1.1](https://github.com/ucdjs/test-repo/compare/@ucdjs/test@0.1.0...@ucdjs/test@0.1.1) (2025-01-16)"`);
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
    const { normalizedOptions, workspacePackage, githubClient } = createChangelogTestContext(testdirPath);

    mockExec.mockRejectedValue(new Error("fatal: path 'CHANGELOG.md' does not exist"));

    const commits = [
      createCommit({
        type: "feat",
        message: "feat: add new feature",
        hash: "abc123",
        shortHash: "abc123",
      }),
    ];

    await updateChangelog({
      normalizedOptions,
      workspacePackage,
      version: "0.1.0",
      commits,
      date: "2025-01-16",
      githubClient,
    });

    const content = await readFile(join(testdirPath, "CHANGELOG.md"), "utf-8");

    expect(content).toMatchInlineSnapshot(`
      "# @ucdjs/test

      ## 0.1.0 (2025-01-16)


      ### Features
      * feat: add new feature ([abc123](https://github.com/ucdjs/test-repo/commit/abc123)) (by Test Author)
      "
    `);
  });

  it("should insert new version above existing entries", async () => {
    const testdirPath = await testdir({});
    const context = createChangelogTestContext(testdirPath);

    const commits = [
      createCommit({
        type: "feat",
        message: "feat: add feature B",
        hash: "def456",
        shortHash: "def456",
      }),
    ];

    mockExec.mockRejectedValueOnce(new Error("fatal: path 'CHANGELOG.md' does not exist"));

    await updateChangelog({
      normalizedOptions: context.normalizedOptions,
      workspacePackage: context.workspacePackage,
      version: "0.1.0",
      commits: [
        createCommit({
          type: "feat",
          message: "feat: initial release",
          hash: "abc123",
          shortHash: "abc123",
        }),
      ],
      date: "2025-01-15",
      githubClient: context.githubClient,
    });

    const existingChangelog = await readFile(join(testdirPath, "CHANGELOG.md"), "utf-8");

    mockExec.mockResolvedValueOnce({ stdout: existingChangelog, stderr: "", exitCode: 0 });

    await updateChangelog({
      normalizedOptions: context.normalizedOptions,
      workspacePackage: context.workspacePackage,
      version: "0.2.0",
      previousVersion: "0.1.0",
      commits,
      date: "2025-01-16",
      githubClient: context.githubClient,
    });

    const content = await readFile(join(testdirPath, "CHANGELOG.md"), "utf-8");

    expect(content).toMatchInlineSnapshot(`
      "# @ucdjs/test

      ## [0.2.0](https://github.com/ucdjs/test-repo/compare/@ucdjs/test@0.1.0...@ucdjs/test@0.2.0) (2025-01-16)


      ### Features
      * feat: add feature B ([def456](https://github.com/ucdjs/test-repo/commit/def456)) (by Test Author)


      ## 0.1.0 (2025-01-15)


      ### Features
      * feat: initial release ([abc123](https://github.com/ucdjs/test-repo/commit/abc123)) (by Test Author)
      "
    `);
  });

  it("should replace existing version entry (PR update)", async () => {
    const testdirPath = await testdir({});
    const context = createChangelogTestContext(testdirPath);

    mockExec.mockRejectedValueOnce(new Error("fatal: path 'CHANGELOG.md' does not exist"));

    await updateChangelog({
      normalizedOptions: context.normalizedOptions,
      workspacePackage: context.workspacePackage,
      version: "0.2.0",
      commits: [
        createCommit({
          type: "feat",
          message: "feat: add feature A",
          hash: "abc123",
          shortHash: "abc123",
        }),
      ],
      date: "2025-01-16",
      githubClient: context.githubClient,
    });

    mockExec.mockRejectedValueOnce(new Error("fatal: path 'CHANGELOG.md' does not exist"));

    await updateChangelog({
      normalizedOptions: context.normalizedOptions,
      workspacePackage: context.workspacePackage,
      version: "0.2.0",
      commits: [
        createCommit({
          type: "feat",
          message: "feat: add feature A",
          hash: "abc123",
          shortHash: "abc123",
        }),
        createCommit({
          type: "feat",
          message: "feat: add feature B",
          hash: "def456",
          shortHash: "def456",
        }),
      ],
      date: "2025-01-16",
      githubClient: context.githubClient,
    });

    const content = await readFile(join(testdirPath, "CHANGELOG.md"), "utf-8");
    const parsed = parseChangelog(content);

    expect(parsed.versions).toHaveLength(1);
    expect(parsed.versions[0]!.version).toBe("0.2.0");
    expect(content).toContain("add feature A");
    expect(content).toContain("add feature B");
  });
});
