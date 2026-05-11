import {
  GitHubService,
  GitHubServiceLive,
} from "../../src/services/github";
import { NodeServices } from "@effect/platform-node";
import { ReleaseOptions } from "../../src/options";
import { expect, it, layer } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { HttpResponse } from "msw";
import { describe } from "vitest";

import { GITHUB_API_BASE, mockFetch } from "../_msw";
import { createNormalizedReleaseOptions } from "../_shared";

layer(
  Layer.mergeAll(
    NodeServices.layer,
    Layer.provide(
      GitHubServiceLive,
      Layer.succeed(
        ReleaseOptions,
        createNormalizedReleaseOptions({ owner: "ucdjs", repo: "test-repo" }),
      ),
    ),
  ),
)("GitHubService", (it) => {
  it.effect("returns null when no open PRs exist", () =>
    Effect.gen(function* () {
    mockFetch("GET", `${GITHUB_API_BASE}/repos/ucdjs/test-repo/pulls`, () => HttpResponse.json([]));
    const github = yield* GitHubService;
    const result = yield* github.getExistingPullRequest("release/next");
    expect(result).toBeNull();
  }));

  it.effect("returns the first open PR for the branch", () =>
    Effect.gen(function* () {
    mockFetch("GET", `${GITHUB_API_BASE}/repos/ucdjs/test-repo/pulls`, () =>
      HttpResponse.json([
        {
          number: 42,
          title: "chore: release v1.0.0",
          body: "Release body",
          draft: true,
          html_url: "https://github.com/ucdjs/test-repo/pull/42",
          head: { sha: "abc1234" },
        },
      ]),
    );

    const github = yield* GitHubService;
    const result = yield* github.getExistingPullRequest("release/next");
    expect(result?.number).toBe(42);
    expect(result?.head?.sha).toBe("abc1234");
  }));

  it.effect("fails when PR shape from API is invalid", () =>
    Effect.gen(function* () {
    mockFetch("GET", `${GITHUB_API_BASE}/repos/ucdjs/test-repo/pulls`, () =>
      HttpResponse.json([{ number: "not-a-number" }]),
    );

    const github = yield* GitHubService;
    const exit = yield* Effect.exit(github.getExistingPullRequest("release/next"));
    expect(exit._tag).toBe("Failure");
  }));

  it.effect("creates a new draft PR when no pullNumber is provided", () =>
    Effect.gen(function* () {
    mockFetch("POST", `${GITHUB_API_BASE}/repos/ucdjs/test-repo/pulls`, () =>
      HttpResponse.json(
        {
          number: 10,
          title: "chore: new release",
          body: "Release body",
          draft: true,
          html_url: "https://github.com/ucdjs/test-repo/pull/10",
        },
        { status: 201 },
      ),
    );

    const github = yield* GitHubService;
    const result = yield* github.upsertPullRequest({
      title: "chore: new release",
      body: "Release body",
      head: "release/next",
      base: "main",
    });
    expect(result?.number).toBe(10);
    expect(result?.draft).toBe(true);
  }));

  it.effect("sends the correct payload to the statuses endpoint", () =>
    Effect.gen(function* () {
    let captured: unknown;
    mockFetch(
      "POST",
      `${GITHUB_API_BASE}/repos/ucdjs/test-repo/statuses/abc1234`,
      async ({ request }) => {
        captured = await request.json();
        return HttpResponse.json({}, { status: 201 });
      },
    );

    const github = yield* GitHubService;
    yield* github.setCommitStatus({
      sha: "abc1234",
      state: "success",
      context: "release/verify",
      description: "All checks passed",
    });

    expect(captured).toMatchObject({
      state: "success",
      context: "release/verify",
      description: "All checks passed",
    });
  }));

  it.effect("creates a release when none exists for the tag", () =>
    Effect.gen(function* () {
    mockFetch([
      [
        "GET",
        `${GITHUB_API_BASE}/repos/ucdjs/test-repo/releases/tags/:tag`,
        () => HttpResponse.json({ message: "Not Found" }, { status: 404 }),
      ],
      [
        "POST",
        `${GITHUB_API_BASE}/repos/ucdjs/test-repo/releases`,
        () =>
          HttpResponse.json(
            {
              id: 99,
              tag_name: "pkg@1.0.0",
              name: "pkg@1.0.0",
              html_url: "https://github.com/ucdjs/test-repo/releases/tag/pkg%401.0.0",
            },
            { status: 201 },
          ),
      ],
    ]);

    const github = yield* GitHubService;
    const { release, created } = yield* github.upsertReleaseByTag({ tagName: "pkg@1.0.0", name: "pkg@1.0.0", body: "Release notes" });
    expect(created).toBe(true);
    expect(release.id).toBe(99);
  }));

  it.effect("resolves login via user search by email", () =>
    Effect.gen(function* () {
    mockFetch("GET", `${GITHUB_API_BASE}/search/users`, () =>
      HttpResponse.json({ items: [{ login: "resolved-user" }] }),
    );

    const github = yield* GitHubService;
    const result = yield* github.resolveAuthorInfo({ name: "Test", email: "t@test.com", login: undefined, commits: [] });
    expect(result.login).toBe("resolved-user");
  }));
});
