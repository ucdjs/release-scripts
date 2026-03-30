import type { AuthorInfo, CommitTypeRule } from "#shared/types";
import type { GitCommit } from "commit-parser";
import { buildTemplateGroups } from "#operations/changelog-format";
import { describe, expect, it } from "vitest";
import { createCommit } from "../_shared";

const TYPES: Record<string, CommitTypeRule> = {
  feat: { title: "🚀 Features" },
  fix: { title: "🐞 Bug Fixes" },
};

const OWNER = "ucdjs";
const REPO = "test-repo";

describe("buildTemplateGroups", () => {
  it("returns one group per type even when there are no commits", () => {
    const groups = buildTemplateGroups({
      commits: [],
      owner: OWNER,
      repo: REPO,
      types: TYPES,
      commitAuthors: new Map(),
    });

    expect(groups).toHaveLength(2);
    expect(groups[0]).toEqual({ name: "feat", title: "🚀 Features", commits: [] });
    expect(groups[1]).toEqual({ name: "fix", title: "🐞 Bug Fixes", commits: [] });
  });

  it("places feat commits into the feat group", () => {
    const commit = createCommit({ type: "feat", description: "add new feature", hash: "abc123full", shortHash: "abc123f" });
    const groups = buildTemplateGroups({
      commits: [commit],
      owner: OWNER,
      repo: REPO,
      types: TYPES,
      commitAuthors: new Map(),
    });

    const featGroup = groups.find((g) => g.name === "feat")!;
    expect(featGroup.commits).toHaveLength(1);
    expect(featGroup.commits[0]!.line).toContain("add new feature");

    const fixGroup = groups.find((g) => g.name === "fix")!;
    expect(fixGroup.commits).toHaveLength(0);
  });

  it("excludes non-conventional commits", () => {
    const commit = createCommit({ isConventional: false, type: "", description: "random commit" });
    const groups = buildTemplateGroups({
      commits: [commit],
      owner: OWNER,
      repo: REPO,
      types: TYPES,
      commitAuthors: new Map(),
    });

    for (const group of groups) {
      expect(group.commits).toHaveLength(0);
    }
  });

  it("excludes commits whose type is not in the types map", () => {
    const commit = createCommit({ type: "chore", description: "update deps" });
    const groups = buildTemplateGroups({
      commits: [commit],
      owner: OWNER,
      repo: REPO,
      types: TYPES,
      commitAuthors: new Map(),
    });

    for (const group of groups) {
      expect(group.commits).toHaveLength(0);
    }
  });

  it("appends commit short hash link to every line", () => {
    const commit = createCommit({ type: "fix", hash: "abc1234567890", shortHash: "abc1234", description: "fix crash" });
    const groups = buildTemplateGroups({
      commits: [commit],
      owner: OWNER,
      repo: REPO,
      types: { fix: { title: "🐞 Bug Fixes" } },
      commitAuthors: new Map(),
    });

    const line = groups[0]!.commits[0]!.line;
    expect(line).toContain("([abc1234](https://github.com/ucdjs/test-repo/commit/abc1234567890))");
  });

  it("appends issue reference when ref type is 'issue'", () => {
    const commit = createCommit({
      type: "fix",
      description: "fix the crash",
      hash: "def5678900000",
      shortHash: "def5678",
      references: [{ type: "issue", value: "#99" }] as GitCommit["references"],
    });
    const groups = buildTemplateGroups({
      commits: [commit],
      owner: OWNER,
      repo: REPO,
      types: { fix: { title: "🐞 Bug Fixes" } },
      commitAuthors: new Map(),
    });

    const line = groups[0]!.commits[0]!.line;
    expect(line).toContain("([Issue #99](https://github.com/ucdjs/test-repo/issues/99))");
  });

  it("appends pull request reference when ref type is not 'issue'", () => {
    const commit = createCommit({
      type: "feat",
      description: "add login",
      hash: "fed9876543210",
      shortHash: "fed9876",
      references: [{ type: "pull-request", value: "#42" }] as GitCommit["references"],
    });
    const groups = buildTemplateGroups({
      commits: [commit],
      owner: OWNER,
      repo: REPO,
      types: { feat: { title: "🚀 Features" } },
      commitAuthors: new Map(),
    });

    const line = groups[0]!.commits[0]!.line;
    expect(line).toContain("([PR #42](https://github.com/ucdjs/test-repo/pull/42))");
  });

  it("skips references with no numeric value", () => {
    const commit = createCommit({
      type: "feat",
      description: "add something",
      hash: "aaa0000000000",
      shortHash: "aaa0000",
      references: [{ type: "issue", value: "" }] as GitCommit["references"],
    });
    const groups = buildTemplateGroups({
      commits: [commit],
      owner: OWNER,
      repo: REPO,
      types: { feat: { title: "🚀 Features" } },
      commitAuthors: new Map(),
    });

    const line = groups[0]!.commits[0]!.line;
    expect(line).not.toContain("Issue");
    expect(line).not.toContain("PR");
  });

  it("appends author login as a GitHub link when login is present", () => {
    const commit = createCommit({ type: "feat", hash: "bbb1111111111", shortHash: "bbb1111" });
    const authors: AuthorInfo[] = [{ name: "luxass", login: "luxass", commits: [] }];
    const groups = buildTemplateGroups({
      commits: [commit],
      owner: OWNER,
      repo: REPO,
      types: { feat: { title: "🚀 Features" } },
      commitAuthors: new Map([["bbb1111111111", authors]]),
    });

    const line = groups[0]!.commits[0]!.line;
    expect(line).toContain("(by [@luxass](https://github.com/luxass))");
  });

  it("uses author name when login is absent", () => {
    const commit = createCommit({ type: "feat", hash: "ccc2222222222", shortHash: "ccc2222" });
    const authors: AuthorInfo[] = [{ name: "Some Contributor", commits: [] }];
    const groups = buildTemplateGroups({
      commits: [commit],
      owner: OWNER,
      repo: REPO,
      types: { feat: { title: "🚀 Features" } },
      commitAuthors: new Map([["ccc2222222222", authors]]),
    });

    const line = groups[0]!.commits[0]!.line;
    expect(line).toContain("(by Some Contributor)");
  });

  it("joins multiple authors with a comma", () => {
    const commit = createCommit({ type: "feat", hash: "ddd3333333333", shortHash: "ddd3333" });
    const authors: AuthorInfo[] = [
      { name: "Alice", login: "alice", commits: [] },
      { name: "Bob", commits: [] },
    ];
    const groups = buildTemplateGroups({
      commits: [commit],
      owner: OWNER,
      repo: REPO,
      types: { feat: { title: "🚀 Features" } },
      commitAuthors: new Map([["ddd3333333333", authors]]),
    });

    const line = groups[0]!.commits[0]!.line;
    expect(line).toContain("(by [@alice](https://github.com/alice), Bob)");
  });

  it("omits the author suffix when commitAuthors has no entry for the commit", () => {
    const commit = createCommit({ type: "feat", hash: "eee4444444444", shortHash: "eee4444" });
    const groups = buildTemplateGroups({
      commits: [commit],
      owner: OWNER,
      repo: REPO,
      types: { feat: { title: "🚀 Features" } },
      commitAuthors: new Map(),
    });

    const line = groups[0]!.commits[0]!.line;
    expect(line).not.toContain("(by ");
  });

  it("merges aliased types into the canonical group via the types map", () => {
    const featCommit = createCommit({ type: "feat", description: "regular feat", hash: "fff1000000000", shortHash: "fff1000" });
    const featureCommit = createCommit({ type: "feature", description: "alias feature", hash: "fff2000000000", shortHash: "fff2000" });

    const groups = buildTemplateGroups({
      commits: [featCommit, featureCommit],
      owner: OWNER,
      repo: REPO,
      types: { feat: { title: "🚀 Features", types: ["feat", "feature"] } },
      commitAuthors: new Map(),
    });

    expect(groups[0]!.commits).toHaveLength(2);
    expect(groups[0]!.commits.map((c) => c.line)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("regular feat"),
        expect.stringContaining("alias feature"),
      ]),
    );
  });
});
