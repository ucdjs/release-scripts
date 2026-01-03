import { describe, expect, it } from "vitest";
import type { GitCommit } from "../src/utils/helpers";
import { createChangelog, formatChangelogMarkdown, groupByType, parseCommits } from "../src/utils/changelog-formatters";

describe("Changelog Formatters", () => {
  describe("parseCommits", () => {
    it("should filter out non-conventional commits", () => {
      const commits: GitCommit[] = [
        {
          isConventional: true,
          isBreaking: false,
          type: "feat",
          scope: undefined,
          description: "add new feature",
          references: [],
          authors: [],
          hash: "abc123",
          shortHash: "abc",
          body: "",
          message: "feat: add new feature",
          date: "2024-01-01",
        },
        {
          isConventional: false,
          isBreaking: false,
          type: "",
          scope: undefined,
          description: "random commit",
          references: [],
          authors: [],
          hash: "def456",
          shortHash: "def",
          body: "",
          message: "random commit",
          date: "2024-01-01",
        },
      ];

      const entries = parseCommits(commits);
      expect(entries).toHaveLength(1);
      expect(entries[0].description).toBe("add new feature");
    });

    it("should mark breaking changes correctly", () => {
      const commits: GitCommit[] = [
        {
          isConventional: true,
          isBreaking: true,
          type: "feat",
          scope: undefined,
          description: "breaking change",
          references: [],
          authors: [],
          hash: "abc123",
          shortHash: "abc",
          body: "",
          message: "feat!: breaking change",
          date: "2024-01-01",
        },
      ];

      const entries = parseCommits(commits);
      expect(entries[0].breaking).toBe(true);
    });

    it("should extract references correctly", () => {
      const commits: GitCommit[] = [
        {
          isConventional: true,
          isBreaking: false,
          type: "fix",
          scope: undefined,
          description: "fix bug",
          references: [
            { type: "issue" as const, value: "123" },
            { type: "pull-request" as const, value: "456" },
          ],
          authors: [],
          hash: "abc123",
          shortHash: "abc",
          body: "",
          message: "fix: fix bug (#123, #456)",
          date: "2024-01-01",
        },
      ];

      const entries = parseCommits(commits);
      expect(entries[0].references).toHaveLength(2);
      expect(entries[0].references[0]).toEqual({ type: "issue", value: "123" });
    });
  });

  describe("groupByType", () => {
    it("should group entries by type", () => {
      const entries = [
        { type: "feat", scope: undefined, description: "feature 1", breaking: false, hash: "a", shortHash: "a", references: [] },
        { type: "fix", scope: undefined, description: "fix 1", breaking: false, hash: "b", shortHash: "b", references: [] },
        { type: "feat", scope: undefined, description: "feature 2", breaking: false, hash: "c", shortHash: "c", references: [] },
      ];

      const groups = groupByType(entries);
      expect(groups.get("feat")).toHaveLength(2);
      expect(groups.get("fix")).toHaveLength(1);
    });

    it("should put breaking changes in separate group", () => {
      const entries = [
        { type: "feat", scope: undefined, description: "breaking", breaking: true, hash: "a", shortHash: "a", references: [] },
        { type: "feat", scope: undefined, description: "normal", breaking: false, hash: "b", shortHash: "b", references: [] },
      ];

      const groups = groupByType(entries);
      expect(groups.get("breaking")).toHaveLength(1);
      expect(groups.get("feat")).toHaveLength(1);
    });
  });

  describe("createChangelog", () => {
    it("should create a changelog object with parsed entries", () => {
      const commits: GitCommit[] = [
        {
          isConventional: true,
          isBreaking: false,
          type: "feat",
          scope: "api",
          description: "add endpoint",
          references: [],
          authors: [],
          hash: "abc123",
          shortHash: "abc",
          body: "",
          message: "feat(api): add endpoint",
          date: "2024-01-01",
        },
      ];

      const changelog = createChangelog("my-package", "1.1.0", "1.0.0", commits);

      expect(changelog.packageName).toBe("my-package");
      expect(changelog.version).toBe("1.1.0");
      expect(changelog.previousVersion).toBe("1.0.0");
      expect(changelog.entries).toHaveLength(1);
      expect(changelog.entries[0].type).toBe("feat");
    });
  });

  describe("formatChangelogMarkdown", () => {
    it("should format changelog as markdown", () => {
      const changelog = {
        packageName: "test-package",
        version: "1.0.0",
        previousVersion: "0.9.0",
        entries: [
          {
            type: "feat",
            scope: "core",
            description: "add feature",
            breaking: false,
            hash: "abc123",
            shortHash: "abc",
            references: [{ type: "issue", value: "42" }],
          },
        ],
      };

      const markdown = formatChangelogMarkdown(changelog);

      expect(markdown).toContain("# test-package v1.0.0");
      expect(markdown).toContain("**Previous version**: `0.9.0`");
      expect(markdown).toContain("**New version**: `1.0.0`");
      expect(markdown).toContain("## ✨ Features");
      expect(markdown).toContain("**core**: add feature (#42) (`abc`)");
    });

    it("should handle empty changelog", () => {
      const changelog = {
        packageName: "test-package",
        version: "1.0.0",
        previousVersion: "0.9.0",
        entries: [],
      };

      const markdown = formatChangelogMarkdown(changelog);
      expect(markdown).toContain("*No conventional commits found.*");
    });
  });
});
