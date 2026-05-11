import { generateChangelogEntry } from "../../src/services/changelog";
import { ChangelogServiceLive } from "../../src/services/changelog";
import { GitHubService } from "../../src/services/github";
import { GitServiceLive } from "../../src/services/git";
import { NodeServices } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import { describe, expect, it, vi } from "vitest";

import { DEFAULT_TYPES } from "../../src/options";
import { createCommit } from "../_shared";

describe("generateChangelogEntry author rendering", () => {
  it("includes resolved GitHub handles for commit authors", async () => {
    const commits = [
      createCommit({
        references: [{ type: "pull-request", value: "#123" }],
      }),
    ];

    const resolveAuthorInfo = vi.fn((info) => {
      if (!info.login) {
          info.login = info.email.split("@")[0]!;
        }
        return info;
      });

    const entry = await Effect.runPromise(
      generateChangelogEntry({
      packageName: "@ucdjs/test",
      version: "1.0.1",
      previousVersion: "1.0.0",
      date: "2025-11-18",
      commits,
      owner: "ucdjs",
      repo: "release-scripts",
      types: DEFAULT_TYPES,
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            NodeServices.layer,
            GitServiceLive,
            ChangelogServiceLive,
            Layer.succeed(GitHubService)(Object.assign({}, {
              getExistingPullRequest: vi.fn(),
              upsertPullRequest: vi.fn(),
              setCommitStatus: vi.fn(),
              upsertReleaseByTag: vi.fn(),
              resolveAuthorInfo: (info: any) => Effect.succeed(resolveAuthorInfo(info) as any),
            }) as any),
          ),
        ),
      ) as Effect.Effect<string, unknown, never>,
    );

    expect(entry).toContain("(by [@author](https://github.com/author))");
    expect(resolveAuthorInfo).toHaveBeenCalledTimes(1);
  });
});
