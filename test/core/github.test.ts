import {
  GitHubService,
  GitHubServiceLive,
} from "../../src/services/github";
import { NodeServices } from "@effect/platform-node";
import { ReleaseOptions } from "../../src/options";
import { expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { HttpResponse } from "msw";
import { describe } from "vitest";

import { GITHUB_API_BASE, mockFetch } from "../_msw";
import { createNormalizedReleaseOptions } from "../_shared";

const runGitHub = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(
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
      ),
    ) as Effect.Effect<A, E, never>,
  );

describe("GitHubService", () => {
  it("returns null when no open PRs exist", async () => {
    mockFetch("GET", `${GITHUB_API_BASE}/repos/ucdjs/test-repo/pulls`, () => HttpResponse.json([]));
    await expect(runGitHub(Effect.gen(function* () {
      const github = yield* GitHubService;
      return yield* github.getExistingPullRequest("release/next");
    }))).resolves.toBeNull();
  });

  it("returns the first open PR for the branch", async () => {
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

    const result = await runGitHub(Effect.gen(function* () {
      const github = yield* GitHubService;
      return yield* github.getExistingPullRequest("release/next");
    }));
    expect(result?.number).toBe(42);
    expect(result?.head?.sha).toBe("abc1234");
  });

  it("fails when PR shape from API is invalid", async () => {
    mockFetch("GET", `${GITHUB_API_BASE}/repos/ucdjs/test-repo/pulls`, () =>
      HttpResponse.json([{ number: "not-a-number" }]),
    );

    await expect(runGitHub(Effect.gen(function* () {
      const github = yield* GitHubService;
      return yield* github.getExistingPullRequest("release/next");
    }))).rejects.toMatchObject({
      _tag: "GitHubError",
      operation: "getExistingPullRequest",
      message: "Pull request data validation failed",
    });
  });

  it("creates a new draft PR when no pullNumber is provided", async () => {
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

    const result = await runGitHub(Effect.gen(function* () {
      const github = yield* GitHubService;
      return yield* github.upsertPullRequest({
        title: "chore: new release",
        body: "Release body",
        head: "release/next",
        base: "main",
      });
    }));
    expect(result?.number).toBe(10);
    expect(result?.draft).toBe(true);
  });

  it("sends the correct payload to the statuses endpoint", async () => {
    let captured: unknown;
    mockFetch(
      "POST",
      `${GITHUB_API_BASE}/repos/ucdjs/test-repo/statuses/abc1234`,
      async ({ request }) => {
        captured = await request.json();
        return HttpResponse.json({}, { status: 201 });
      },
    );

    await runGitHub(Effect.gen(function* () {
      const github = yield* GitHubService;
      return yield* github.setCommitStatus({
        sha: "abc1234",
        state: "success",
        context: "release/verify",
        description: "All checks passed",
      });
    }));

    expect(captured).toMatchObject({
      state: "success",
      context: "release/verify",
      description: "All checks passed",
    });
  });

  it("creates a release when none exists for the tag", async () => {
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

    const { release, created } = await runGitHub(Effect.gen(function* () {
      const github = yield* GitHubService;
      return yield* github.upsertReleaseByTag({ tagName: "pkg@1.0.0", name: "pkg@1.0.0", body: "Release notes" });
    }));
    expect(created).toBe(true);
    expect(release.id).toBe(99);
  });

  it("resolves login via user search by email", async () => {
    mockFetch("GET", `${GITHUB_API_BASE}/search/users`, () =>
      HttpResponse.json({ items: [{ login: "resolved-user" }] }),
    );

    const result = await runGitHub(Effect.gen(function* () {
      const github = yield* GitHubService;
      return yield* github.resolveAuthorInfo({ name: "Test", email: "t@test.com", login: undefined, commits: [] });
    }));
    expect(result.login).toBe("resolved-user");
  });
});
