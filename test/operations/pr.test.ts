import { createGitHubClient } from "#core/github";
import { syncPullRequest } from "#operations/pr";
import { HttpResponse } from "msw";
import { assert, describe, expect, it } from "vitest";
import { GITHUB_API_BASE, mockFetch } from "../_msw";
import { createWorkspacePackage } from "../_shared";

const OWNER = "ucdjs";
const REPO = "test-repo";

function makeClient() {
  return createGitHubClient({ owner: OWNER, repo: REPO, githubToken: "test-token" });
}

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

describe("syncPullRequest", () => {
  it("creates a new PR when none exists and returns created: true", async () => {
    mockFetch("GET", `${GITHUB_API_BASE}/repos/${OWNER}/${REPO}/pulls`, () => HttpResponse.json([]));
    mockFetch("POST", `${GITHUB_API_BASE}/repos/${OWNER}/${REPO}/pulls`, () =>
      HttpResponse.json({
        number: 10,
        title: "chore: release",
        body: "",
        draft: true,
        html_url: `https://github.com/${OWNER}/${REPO}/pull/10`,
        head: { sha: "abc1234" },
      }, { status: 201 }));

    const result = await syncPullRequest({
      github: makeClient(),
      releaseBranch: "release/next",
      defaultBranch: "main",
      pullRequestTitle: "chore: release",
      updates: NO_UPDATES,
    });

    assert(result.ok);
    expect(result.value.created).toBe(true);
    expect(result.value.pullRequest?.number).toBe(10);
  });

  it("updates an existing PR and returns created: false", async () => {
    mockFetch("GET", `${GITHUB_API_BASE}/repos/${OWNER}/${REPO}/pulls`, () =>
      HttpResponse.json([{
        number: 5,
        title: "chore: existing release",
        body: "old body",
        draft: false,
        html_url: `https://github.com/${OWNER}/${REPO}/pull/5`,
        head: { sha: "def5678" },
      }]));
    mockFetch("PATCH", `${GITHUB_API_BASE}/repos/${OWNER}/${REPO}/pulls/5`, () =>
      HttpResponse.json({
        number: 5,
        title: "chore: existing release",
        body: "updated body",
        draft: false,
        html_url: `https://github.com/${OWNER}/${REPO}/pull/5`,
        head: { sha: "def5678" },
      }));

    const result = await syncPullRequest({
      github: makeClient(),
      releaseBranch: "release/next",
      defaultBranch: "main",
      updates: NO_UPDATES,
    });

    assert(result.ok);
    expect(result.value.created).toBe(false);
    expect(result.value.pullRequest?.number).toBe(5);
  });

  it("preserves the existing PR title instead of overriding it", async () => {
    let capturedTitle: string | undefined;

    mockFetch("GET", `${GITHUB_API_BASE}/repos/${OWNER}/${REPO}/pulls`, () =>
      HttpResponse.json([{
        number: 7,
        title: "chore: preserved title",
        body: "",
        draft: false,
        html_url: `https://github.com/${OWNER}/${REPO}/pull/7`,
        head: { sha: "aaa0001" },
      }]));
    mockFetch("PATCH", `${GITHUB_API_BASE}/repos/${OWNER}/${REPO}/pulls/7`, async ({ request }) => {
      const body = await request.json() as { title?: string };
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

    await syncPullRequest({
      github: makeClient(),
      releaseBranch: "release/next",
      defaultBranch: "main",
      pullRequestTitle: "chore: caller title",
      updates: NO_UPDATES,
    });

    expect(capturedTitle).toBe("chore: preserved title");
  });

  it("uses pullRequestTitle when there is no existing PR", async () => {
    let capturedTitle: string | undefined;

    mockFetch("GET", `${GITHUB_API_BASE}/repos/${OWNER}/${REPO}/pulls`, () => HttpResponse.json([]));
    mockFetch("POST", `${GITHUB_API_BASE}/repos/${OWNER}/${REPO}/pulls`, async ({ request }) => {
      const body = await request.json() as { title?: string };
      capturedTitle = body.title;
      return HttpResponse.json({
        number: 11,
        title: capturedTitle ?? "",
        body: "",
        draft: true,
        html_url: `https://github.com/${OWNER}/${REPO}/pull/11`,
        head: { sha: "bbb0002" },
      }, { status: 201 });
    });

    await syncPullRequest({
      github: makeClient(),
      releaseBranch: "release/next",
      defaultBranch: "main",
      pullRequestTitle: "chore: caller title",
      updates: NO_UPDATES,
    });

    expect(capturedTitle).toBe("chore: caller title");
  });

  it("falls back to default title when neither existing PR nor caller title is present", async () => {
    let capturedTitle: string | undefined;

    mockFetch("GET", `${GITHUB_API_BASE}/repos/${OWNER}/${REPO}/pulls`, () => HttpResponse.json([]));
    mockFetch("POST", `${GITHUB_API_BASE}/repos/${OWNER}/${REPO}/pulls`, async ({ request }) => {
      const body = await request.json() as { title?: string };
      capturedTitle = body.title;
      return HttpResponse.json({
        number: 12,
        title: capturedTitle ?? "",
        body: "",
        draft: true,
        html_url: `https://github.com/${OWNER}/${REPO}/pull/12`,
        head: { sha: "ccc0003" },
      }, { status: 201 });
    });

    await syncPullRequest({
      github: makeClient(),
      releaseBranch: "release/next",
      defaultBranch: "main",
      updates: NO_UPDATES,
    });

    expect(capturedTitle).toBe("chore: update package versions");
  });

  it("returns err when getExistingPullRequest fails", async () => {
    mockFetch("GET", `${GITHUB_API_BASE}/repos/${OWNER}/${REPO}/pulls`, () =>
      HttpResponse.json({ message: "Bad credentials" }, { status: 401 }));

    const result = await syncPullRequest({
      github: makeClient(),
      releaseBranch: "release/next",
      defaultBranch: "main",
      updates: NO_UPDATES,
    });

    assert(!result.ok);
    expect(result.error.type).toBe("github");
    expect(result.error.operation).toBe("getExistingPullRequest");
  });

  it("returns err when upsertPullRequest fails", async () => {
    mockFetch("GET", `${GITHUB_API_BASE}/repos/${OWNER}/${REPO}/pulls`, () => HttpResponse.json([]));
    mockFetch("POST", `${GITHUB_API_BASE}/repos/${OWNER}/${REPO}/pulls`, () =>
      HttpResponse.json({ message: "Validation failed" }, { status: 422 }));

    const result = await syncPullRequest({
      github: makeClient(),
      releaseBranch: "release/next",
      defaultBranch: "main",
      updates: NO_UPDATES,
    });

    assert(!result.ok);
    expect(result.error.type).toBe("github");
    expect(result.error.operation).toBe("upsertPullRequest");
  });
});
