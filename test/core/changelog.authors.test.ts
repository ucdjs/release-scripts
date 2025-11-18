import type { GitHubClient } from "#core/github";
import type { GitCommit } from "commit-parser";

import { generateChangelogEntry } from "#core/changelog";
import { DEFAULT_COMMIT_GROUPS } from "#shared/options";
import { describe, expect, it, vi } from "vitest";

function createCommit(overrides: Partial<GitCommit>): GitCommit {
  return {
    hash: "abc1234567890",
    shortHash: "abc1234",
    message: "feat: add feature",
    description: "feat: add feature",
    type: "feat",
    scope: undefined,
    isConventional: true,
    isBreaking: false,
    references: [],
    authors: [
      { name: "Test Author", email: "author@example.com" },
    ],
    ...overrides,
  } as GitCommit;
}

describe("generateChangelogEntry author rendering", () => {
  it("includes resolved GitHub handles for commit authors", async () => {
    const commits = [
      createCommit({
        references: [
          { type: "pull-request", value: "#123" },
        ],
      }),
    ];

    const githubClient = {
      resolveAuthorInfo: vi.fn(async (info) => {
        if (!info.login) {
          info.login = info.email.split("@")[0]!;
        }
        return info;
      }),
    } as unknown as GitHubClient;

    const entry = await generateChangelogEntry({
      packageName: "@ucdjs/test",
      version: "1.0.1",
      previousVersion: "1.0.0",
      date: "2025-11-18",
      commits,
      owner: "ucdjs",
      repo: "release-scripts",
      groups: DEFAULT_COMMIT_GROUPS,
      githubClient,
    });

    expect(entry).toContain("(by [@author](https://github.com/author))");
    expect(githubClient.resolveAuthorInfo).toHaveBeenCalledTimes(1);
  });
});
