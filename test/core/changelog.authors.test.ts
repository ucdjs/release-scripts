import { ChangelogService, ChangelogServiceLive } from "../../src/services/changelog";
import { GitHubService } from "../../src/services/github";
import { GitServiceLive } from "../../src/services/git";
import { NodeServices } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import { expect, it, layer } from "@effect/vitest";
import { describe, vi } from "vitest";

import { DEFAULT_TYPES } from "../../src/options";
import { createCommit } from "../_shared";

const asTest = (effect: Effect.Effect<void, unknown, unknown>): any => effect;

layer(Layer.mergeAll(NodeServices.layer, GitServiceLive, ChangelogServiceLive))("generateChangelogEntry author rendering", (it) => {
  it.effect("includes resolved GitHub handles for commit authors", () =>
    asTest(Effect.gen(function* () {
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

    const entry = yield* Effect.gen(function* () {
      const changelog = yield* ChangelogService;
      return yield* changelog.generateChangelogEntry({
        packageName: "@ucdjs/test",
        version: "1.0.1",
        previousVersion: "1.0.0",
        date: "2025-11-18",
        commits,
        owner: "ucdjs",
        repo: "release-scripts",
        types: DEFAULT_TYPES,
      });
    }).pipe(
      Effect.provideService(GitHubService, Object.assign({}, {
        getExistingPullRequest: vi.fn(),
        upsertPullRequest: vi.fn(),
        setCommitStatus: vi.fn(),
        upsertReleaseByTag: vi.fn(),
        resolveAuthorInfo: (info: any) => Effect.succeed(resolveAuthorInfo(info) as any),
      }) as any),
    );

    expect(entry).toContain("(by [@author](https://github.com/author))");
    expect(resolveAuthorInfo).toHaveBeenCalledTimes(1);
  })));
});
