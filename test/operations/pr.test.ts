import { GitHubServiceLive } from "../../src/services/github";
import { NodeServices } from "@effect/platform-node";
import { ReleaseOptions } from "../../src/options";
import { syncPullRequest } from "../../src/release/pr";
import { expect, it, layer } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { HttpResponse } from "msw";
import { describe } from "vitest";

import { GITHUB_API_BASE, mockFetch } from "../_msw";
import { createNormalizedReleaseOptions, createWorkspacePackage } from "../_shared";

const OWNER = "ucdjs";
const REPO = "test-repo";

const NO_UPDATES = [
  {
    package: createWorkspacePackage("/repo/packages/a", { name: "@ucdjs/a", version: "1.0.0" }),
    currentVersion: "1.0.0",
    newVersion: "1.1.0",
    bumpType: "minor" as const,
    hasDirectChanges: true,
    changeKind: "auto" as const,
  },
];

layer(
  Layer.mergeAll(
    NodeServices.layer,
    Layer.provide(
      GitHubServiceLive,
      Layer.succeed(ReleaseOptions, createNormalizedReleaseOptions({ owner: OWNER, repo: REPO })),
    ),
  ),
)("syncPullRequest", (it) => {
  it.effect("creates a new PR when none exists and returns created: true", () =>
    Effect.gen(function* () {
    mockFetch("GET", `${GITHUB_API_BASE}/repos/${OWNER}/${REPO}/pulls`, () =>
      HttpResponse.json([]),
    );
    mockFetch("POST", `${GITHUB_API_BASE}/repos/${OWNER}/${REPO}/pulls`, () =>
      HttpResponse.json(
        {
          number: 10,
          title: "chore: release",
          body: "",
          draft: true,
          html_url: `https://github.com/${OWNER}/${REPO}/pull/10`,
          head: { sha: "abc1234" },
        },
        { status: 201 },
      ),
    );

    const result = yield* syncPullRequest({
      releaseBranch: "release/next",
      defaultBranch: "main",
      pullRequestTitle: "chore: release",
      updates: NO_UPDATES,
    });

    expect(result.created).toBe(true);
    expect(result.pullRequest?.number).toBe(10);
  }));

  it.effect("updates an existing PR and returns created: false", () =>
    Effect.gen(function* () {
    mockFetch("GET", `${GITHUB_API_BASE}/repos/${OWNER}/${REPO}/pulls`, () =>
      HttpResponse.json([
        {
          number: 5,
          title: "chore: existing release",
          body: "old body",
          draft: false,
          html_url: `https://github.com/${OWNER}/${REPO}/pull/5`,
          head: { sha: "def5678" },
        },
      ]),
    );
    mockFetch("PATCH", `${GITHUB_API_BASE}/repos/${OWNER}/${REPO}/pulls/5`, () =>
      HttpResponse.json({
        number: 5,
        title: "chore: existing release",
        body: "updated body",
        draft: false,
        html_url: `https://github.com/${OWNER}/${REPO}/pull/5`,
        head: { sha: "def5678" },
      }),
    );

    const result = yield* syncPullRequest({
      releaseBranch: "release/next",
      defaultBranch: "main",
      updates: NO_UPDATES,
    });

    expect(result.created).toBe(false);
    expect(result.pullRequest?.number).toBe(5);
  }));

  it.effect("preserves the existing PR title instead of overriding it", () =>
    Effect.gen(function* () {
    let capturedTitle: string | undefined;

    mockFetch("GET", `${GITHUB_API_BASE}/repos/${OWNER}/${REPO}/pulls`, () =>
      HttpResponse.json([
        {
          number: 7,
          title: "chore: preserved title",
          body: "",
          draft: false,
          html_url: `https://github.com/${OWNER}/${REPO}/pull/7`,
          head: { sha: "aaa0001" },
        },
      ]),
    );
    mockFetch("PATCH", `${GITHUB_API_BASE}/repos/${OWNER}/${REPO}/pulls/7`, async ({ request }) => {
      const body = (await request.json()) as { title?: string };
      capturedTitle = body.title;
      return HttpResponse.json({
        number: 7,
        title: capturedTitle,
        body: "",
        draft: false,
        html_url: `https://github.com/${OWNER}/${REPO}/pull/7`,
        head: { sha: "aaa0001" },
      });
    });

    yield* syncPullRequest({
      releaseBranch: "release/next",
      defaultBranch: "main",
      pullRequestTitle: "chore: caller title",
      updates: NO_UPDATES,
    });

    expect(capturedTitle).toBe("chore: preserved title");
  }));

  it.effect("uses pullRequestTitle when there is no existing PR", () =>
    Effect.gen(function* () {
    let capturedTitle: string | undefined;

    mockFetch("GET", `${GITHUB_API_BASE}/repos/${OWNER}/${REPO}/pulls`, () =>
      HttpResponse.json([]),
    );
    mockFetch("POST", `${GITHUB_API_BASE}/repos/${OWNER}/${REPO}/pulls`, async ({ request }) => {
      const body = (await request.json()) as { title?: string };
      capturedTitle = body.title;
      return HttpResponse.json(
        {
          number: 11,
          title: capturedTitle ?? "",
          body: "",
          draft: true,
          html_url: `https://github.com/${OWNER}/${REPO}/pull/11`,
          head: { sha: "bbb0002" },
        },
        { status: 201 },
      );
    });

    yield* syncPullRequest({
      releaseBranch: "release/next",
      defaultBranch: "main",
      pullRequestTitle: "chore: caller title",
      updates: NO_UPDATES,
    });

    expect(capturedTitle).toBe("chore: caller title");
  }));

  it.effect("falls back to default title when neither existing PR nor caller title is present", () =>
    Effect.gen(function* () {
    let capturedTitle: string | undefined;

    mockFetch("GET", `${GITHUB_API_BASE}/repos/${OWNER}/${REPO}/pulls`, () =>
      HttpResponse.json([]),
    );
    mockFetch("POST", `${GITHUB_API_BASE}/repos/${OWNER}/${REPO}/pulls`, async ({ request }) => {
      const body = (await request.json()) as { title?: string };
      capturedTitle = body.title;
      return HttpResponse.json(
        {
          number: 12,
          title: capturedTitle ?? "",
          body: "",
          draft: true,
          html_url: `https://github.com/${OWNER}/${REPO}/pull/12`,
          head: { sha: "ccc0003" },
        },
        { status: 201 },
      );
    });

    yield* syncPullRequest({
      releaseBranch: "release/next",
      defaultBranch: "main",
      updates: NO_UPDATES,
    });

    expect(capturedTitle).toBe("chore: update package versions");
  }));

  it.effect("returns err when getExistingPullRequest fails", () =>
    Effect.gen(function* () {
    mockFetch("GET", `${GITHUB_API_BASE}/repos/${OWNER}/${REPO}/pulls`, () =>
      HttpResponse.json({ message: "Bad credentials" }, { status: 401 }),
    );

    const exit = yield* Effect.exit(syncPullRequest({
      releaseBranch: "release/next",
      defaultBranch: "main",
      updates: NO_UPDATES,
    }));
    expect(exit._tag).toBe("Failure");
  }));

  it.effect("returns err when upsertPullRequest fails", () =>
    Effect.gen(function* () {
    mockFetch("GET", `${GITHUB_API_BASE}/repos/${OWNER}/${REPO}/pulls`, () =>
      HttpResponse.json([]),
    );
    mockFetch("POST", `${GITHUB_API_BASE}/repos/${OWNER}/${REPO}/pulls`, () =>
      HttpResponse.json({ message: "Validation failed" }, { status: 422 }),
    );

    const exit = yield* Effect.exit(syncPullRequest({
      releaseBranch: "release/next",
      defaultBranch: "main",
      updates: NO_UPDATES,
    }));
    expect(exit._tag).toBe("Failure");
  }));
});
