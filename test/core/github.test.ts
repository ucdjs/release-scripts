import { createGitHubClient, generatePullRequestBody } from "#core/github";
import { HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { GITHUB_API_BASE, mockFetch } from "../_msw";

describe("gitHubClient.getExistingPullRequest", () => {
  it("returns null when no open PRs exist", async () => {
    mockFetch("GET", `${GITHUB_API_BASE}/repos/ucdjs/test-repo/pulls`, () => {
      return HttpResponse.json([]);
    });

    const result = await createGitHubClient({
      owner: "ucdjs",
      repo: "test-repo",
      githubToken: "test-token",
    }).getExistingPullRequest("release/next");
    expect(result).toBeNull();
  });

  it("returns the first open PR for the branch", async () => {
    mockFetch("GET", `${GITHUB_API_BASE}/repos/ucdjs/test-repo/pulls`, () => {
      return HttpResponse.json([
        {
          number: 42,
          title: "chore: release v1.0.0",
          body: "Release body",
          draft: true,
          html_url: "https://github.com/ucdjs/test-repo/pull/42",
          head: { sha: "abc1234" },
        },
      ]);
    });

    const result = await createGitHubClient({
      owner: "ucdjs",
      repo: "test-repo",
      githubToken: "test-token",
    }).getExistingPullRequest("release/next");
    expect(result?.number).toBe(42);
    expect(result?.title).toBe("chore: release v1.0.0");
    expect(result?.draft).toBe(true);
    expect(result?.head?.sha).toBe("abc1234");
  });

  it("throws when PR shape from API is invalid", async () => {
    mockFetch("GET", `${GITHUB_API_BASE}/repos/ucdjs/test-repo/pulls`, () => {
      return HttpResponse.json([{ number: "not-a-number" }]);
    });

    await expect(
      createGitHubClient({ owner: "ucdjs", repo: "test-repo", githubToken: "test-token" }).getExistingPullRequest(
        "release/next",
      ),
    ).rejects.toThrow("Pull request data validation failed");
  });

  it("throws on non-2xx response", async () => {
    mockFetch("GET", `${GITHUB_API_BASE}/repos/ucdjs/test-repo/pulls`, () => {
      return HttpResponse.json({ message: "Bad credentials" }, { status: 401 });
    });

    await expect(
      createGitHubClient({ owner: "ucdjs", repo: "test-repo", githubToken: "test-token" }).getExistingPullRequest(
        "release/next",
      ),
    ).rejects.toThrow("401");
  });
});

describe("gitHubClient.upsertPullRequest", () => {
  it("creates a new draft PR when no pullNumber is provided", async () => {
    mockFetch("POST", `${GITHUB_API_BASE}/repos/ucdjs/test-repo/pulls`, () => {
      return HttpResponse.json(
        {
          number: 10,
          title: "chore: new release",
          body: "Release body",
          draft: true,
          html_url: "https://github.com/ucdjs/test-repo/pull/10",
        },
        { status: 201 },
      );
    });

    const result = await createGitHubClient({
      owner: "ucdjs",
      repo: "test-repo",
      githubToken: "test-token",
    }).upsertPullRequest({
      title: "chore: new release",
      body: "Release body",
      head: "release/next",
      base: "main",
    });
    expect(result?.number).toBe(10);
    expect(result?.draft).toBe(true);
  });

  it("updates an existing PR when pullNumber is provided", async () => {
    mockFetch("PATCH", `${GITHUB_API_BASE}/repos/ucdjs/test-repo/pulls/5`, () => {
      return HttpResponse.json({
        number: 5,
        title: "chore: updated release",
        body: "Updated body",
        draft: false,
        html_url: "https://github.com/ucdjs/test-repo/pull/5",
      });
    });

    const result = await createGitHubClient({
      owner: "ucdjs",
      repo: "test-repo",
      githubToken: "test-token",
    }).upsertPullRequest({
      title: "chore: updated release",
      body: "Updated body",
      pullNumber: 5,
    });
    expect(result?.number).toBe(5);
    expect(result?.title).toBe("chore: updated release");
  });

  it("throws when PR response shape is invalid", async () => {
    mockFetch("POST", `${GITHUB_API_BASE}/repos/ucdjs/test-repo/pulls`, () => {
      return HttpResponse.json({ id: 1 }, { status: 201 });
    });

    await expect(
      createGitHubClient({ owner: "ucdjs", repo: "test-repo", githubToken: "test-token" }).upsertPullRequest({
        title: "x",
        body: "y",
        head: "h",
        base: "b",
      }),
    ).rejects.toThrow("Pull request data validation failed");
  });
});

describe("gitHubClient.setCommitStatus", () => {
  it("sends the correct payload to the statuses endpoint", async () => {
    let captured: unknown;
    mockFetch("POST", `${GITHUB_API_BASE}/repos/ucdjs/test-repo/statuses/abc1234`, async ({ request }) => {
      captured = await request.json();
      return HttpResponse.json({}, { status: 201 });
    });

    await createGitHubClient({ owner: "ucdjs", repo: "test-repo", githubToken: "test-token" }).setCommitStatus({
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
  });
});

describe("gitHubClient.upsertReleaseByTag", () => {
  it("creates a new release when none exists for the tag", async () => {
    mockFetch([
      [
        "GET",
        `${GITHUB_API_BASE}/repos/ucdjs/test-repo/releases/tags/:tag`,
        () => {
          return HttpResponse.json({ message: "Not Found" }, { status: 404 });
        },
      ],
      [
        "POST",
        `${GITHUB_API_BASE}/repos/ucdjs/test-repo/releases`,
        () => {
          return HttpResponse.json(
            {
              id: 99,
              tag_name: "pkg@1.0.0",
              name: "pkg@1.0.0",
              html_url: "https://github.com/ucdjs/test-repo/releases/tag/pkg%401.0.0",
            },
            { status: 201 },
          );
        },
      ],
    ]);

    const { release, created } = await createGitHubClient({
      owner: "ucdjs",
      repo: "test-repo",
      githubToken: "test-token",
    }).upsertReleaseByTag({
      tagName: "pkg@1.0.0",
      name: "pkg@1.0.0",
      body: "Release notes",
    });
    expect(created).toBe(true);
    expect(release.id).toBe(99);
  });

  it("updates an existing release when one already exists for the tag", async () => {
    mockFetch([
      [
        "GET",
        `${GITHUB_API_BASE}/repos/ucdjs/test-repo/releases/tags/:tag`,
        () => {
          return HttpResponse.json({ id: 7, tag_name: "pkg@1.0.0", name: "pkg@1.0.0" });
        },
      ],
      [
        "PATCH",
        `${GITHUB_API_BASE}/repos/ucdjs/test-repo/releases/7`,
        () => {
          return HttpResponse.json({ id: 7, tag_name: "pkg@1.0.0", name: "Updated" });
        },
      ],
    ]);

    const { release, created } = await createGitHubClient({
      owner: "ucdjs",
      repo: "test-repo",
      githubToken: "test-token",
    }).upsertReleaseByTag({
      tagName: "pkg@1.0.0",
      name: "Updated",
      body: "Updated notes",
    });
    expect(created).toBe(false);
    expect(release.id).toBe(7);
  });

  it("rethrows non-404 errors when fetching the existing release", async () => {
    mockFetch("GET", `${GITHUB_API_BASE}/repos/ucdjs/test-repo/releases/tags/:tag`, () => {
      return HttpResponse.json({ message: "Server Error" }, { status: 500 });
    });

    await expect(
      createGitHubClient({ owner: "ucdjs", repo: "test-repo", githubToken: "test-token" }).upsertReleaseByTag({
        tagName: "pkg@1.0.0",
        name: "pkg@1.0.0",
        body: "notes",
      }),
    ).rejects.toThrow("500");
  });
});

describe("gitHubClient.resolveAuthorInfo", () => {
  it("returns info unchanged when login is already set", async () => {
    const result = await createGitHubClient({
      owner: "ucdjs",
      repo: "test-repo",
      githubToken: "test-token",
    }).resolveAuthorInfo({ name: "Test", email: "t@test.com", login: "testuser", commits: [] });
    expect(result.login).toBe("testuser");
  });

  it("resolves login via user search by email", async () => {
    mockFetch("GET", `${GITHUB_API_BASE}/search/users`, () => {
      return HttpResponse.json({ items: [{ login: "resolved-user" }] });
    });

    const result = await createGitHubClient({
      owner: "ucdjs",
      repo: "test-repo",
      githubToken: "test-token",
    }).resolveAuthorInfo({ name: "Test", email: "t@test.com", login: undefined, commits: [] });
    expect(result.login).toBe("resolved-user");
  });

  it("falls back to commit author when user search returns no results", async () => {
    mockFetch([
      [
        "GET",
        `${GITHUB_API_BASE}/search/users`,
        () => {
          return HttpResponse.json({ items: [] });
        },
      ],
      [
        "GET",
        `${GITHUB_API_BASE}/repos/ucdjs/test-repo/commits/:sha`,
        () => {
          return HttpResponse.json({ author: { login: "commit-author" } });
        },
      ],
    ]);

    const result = await createGitHubClient({
      owner: "ucdjs",
      repo: "test-repo",
      githubToken: "test-token",
    }).resolveAuthorInfo({ name: "Test", email: "t@test.com", login: undefined, commits: ["abc123"] });
    expect(result.login).toBe("commit-author");
  });

  it("returns info without login when both lookups fail", async () => {
    mockFetch("GET", `${GITHUB_API_BASE}/search/users`, () => {
      return HttpResponse.json({ message: "Forbidden" }, { status: 403 });
    });

    const result = await createGitHubClient({
      owner: "ucdjs",
      repo: "test-repo",
      githubToken: "test-token",
    }).resolveAuthorInfo({ name: "Test", email: "t@test.com", login: undefined, commits: [] });
    expect(result.login).toBeUndefined();
  });
});

describe("generatePullRequestBody", () => {
  it("renders a body containing the package name and new version", () => {
    const body = generatePullRequestBody([
      {
        package: {
          name: "@scope/pkg",
          version: "1.0.0",
          path: "/workspace",
          packageJson: { name: "@scope/pkg", version: "1.0.0" },
          workspaceDependencies: [],
          workspaceDevDependencies: [],
        },
        currentVersion: "1.0.0",
        newVersion: "1.1.0",
        bumpType: "minor",
        hasDirectChanges: true,
        changeKind: "auto",
      },
    ]);
    expect(body).toContain("@scope/pkg");
    expect(body).toContain("1.1.0");
  });

  it("renders all packages when multiple updates are provided", () => {
    const body = generatePullRequestBody([
      {
        package: {
          name: "@scope/a",
          version: "1.0.0",
          path: "/workspace/a",
          packageJson: { name: "@scope/a", version: "1.0.0" },
          workspaceDependencies: [],
          workspaceDevDependencies: [],
        },
        currentVersion: "1.0.0",
        newVersion: "2.0.0",
        bumpType: "major",
        hasDirectChanges: true,
        changeKind: "auto",
      },
      {
        package: {
          name: "@scope/b",
          version: "3.0.0",
          path: "/workspace/b",
          packageJson: { name: "@scope/b", version: "3.0.0" },
          workspaceDependencies: [],
          workspaceDevDependencies: [],
        },
        currentVersion: "3.0.0",
        newVersion: "3.1.0",
        bumpType: "minor",
        hasDirectChanges: false,
        changeKind: "dependent",
      },
    ]);
    expect(body).toContain("@scope/a");
    expect(body).toContain("@scope/b");
  });

  it("uses a custom template when provided", () => {
    const body = generatePullRequestBody(
      [
        {
          package: {
            name: "@scope/pkg",
            version: "1.0.0",
            path: "/workspace",
            packageJson: { name: "@scope/pkg", version: "1.0.0" },
            workspaceDependencies: [],
            workspaceDevDependencies: [],
          },
          currentVersion: "1.0.0",
          newVersion: "1.1.0",
          bumpType: "minor",
          hasDirectChanges: true,
          changeKind: "auto",
        },
      ],
      "<% it.packages.forEach(p => { %><%= p.name %> → <%= p.newVersion %><% }); %>",
    );
    expect(body).toContain("@scope/pkg → 1.1.0");
  });

  it("separates as-is packages from real releases in the default template", () => {
    const body = generatePullRequestBody([
      {
        package: {
          name: "@scope/released",
          version: "1.0.0",
          path: "/workspace/a",
          packageJson: { name: "@scope/released", version: "1.0.0" },
          workspaceDependencies: [],
          workspaceDevDependencies: [],
        },
        currentVersion: "1.0.0",
        newVersion: "2.0.0",
        bumpType: "major",
        hasDirectChanges: true,
        changeKind: "auto",
      },
      {
        package: {
          name: "@scope/kept",
          version: "3.0.0",
          path: "/workspace/b",
          packageJson: { name: "@scope/kept", version: "3.0.0" },
          workspaceDependencies: [],
          workspaceDevDependencies: [],
        },
        currentVersion: "3.0.0",
        newVersion: "3.0.0",
        bumpType: "none",
        hasDirectChanges: true,
        changeKind: "as-is",
      },
    ]);
    expect(body).toContain("@scope/released");
    expect(body).toContain("1.0.0 → 2.0.0 (major)");
    expect(body).toContain("@scope/kept");
    expect(body).toContain("3.0.0 (as-is)");
    expect(body).toContain("keeping their current version");
  });

  it("shows 'no packages to release' when all updates are as-is", () => {
    const body = generatePullRequestBody([
      {
        package: {
          name: "@scope/kept",
          version: "1.0.0",
          path: "/workspace",
          packageJson: { name: "@scope/kept", version: "1.0.0" },
          workspaceDependencies: [],
          workspaceDevDependencies: [],
        },
        currentVersion: "1.0.0",
        newVersion: "1.0.0",
        bumpType: "none",
        hasDirectChanges: true,
        changeKind: "as-is",
      },
    ]);
    expect(body).toContain("no packages to release");
    expect(body).toContain("@scope/kept");
    expect(body).toContain("keeping their current version");
  });
});
