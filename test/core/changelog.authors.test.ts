import type { GitHubClient } from "#core/github";
import { generateChangelogEntry } from "#core/changelog";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_TYPES } from "../../src/options";
import { createCommit } from "../_shared";

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
      types: DEFAULT_TYPES,
      githubClient,
    });

    expect(entry).toContain("(by [@author](https://github.com/author))");
    expect(githubClient.resolveAuthorInfo).toHaveBeenCalledTimes(1);
  });
});
