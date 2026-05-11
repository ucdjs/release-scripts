import { NodeServices } from "@effect/platform-node";
import { GitHubServiceLive } from "../src/services/github";
import { GitService } from "../src/services/git";
import { ReleaseOptions } from "../src/options";
import { prepareReleaseBranch, syncPullRequest } from "../src/prepare";
import { expect, it, layer } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { HttpResponse } from "msw";
import { afterEach, beforeEach, describe, vi } from "vitest";

import { GITHUB_API_BASE, mockFetch } from "./_msw";
import { createNormalizedReleaseOptions, createWorkspacePackage } from "./_shared";

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

const mockedGit = {
  isWorkingDirectoryClean: vi.fn(),
  doesRemoteBranchExist: vi.fn(),
  doesBranchExist: vi.fn(),
  getDefaultBranch: vi.fn(),
  getCurrentBranch: vi.fn(),
  checkoutBranch: vi.fn(),
  pullLatestChanges: vi.fn(),
  rebaseBranch: vi.fn(),
  isBranchAheadOfRemote: vi.fn(),
  pushBranch: vi.fn(),
  readFileFromGit: vi.fn(),
  getMostRecentPackageStableTag: vi.fn(),
  createAndPushPackageTag: vi.fn(),
  createBranch: vi.fn(),
  commitPaths: vi.fn(),
  commitChanges: vi.fn(),
  getMostRecentPackageTag: vi.fn(),
  getGroupedFilesByCommitSha: vi.fn(),
};

const withNode = <A, E, R>(effect: Effect.Effect<A, E, R>): any =>
  effect.pipe(
    Effect.provide(NodeServices.layer as any),
    Effect.provideService(GitService, {
      isWorkingDirectoryClean: mockedGit.isWorkingDirectoryClean,
      doesRemoteBranchExist: mockedGit.doesRemoteBranchExist,
      doesBranchExist: mockedGit.doesBranchExist,
      getDefaultBranch: mockedGit.getDefaultBranch,
      getCurrentBranch: mockedGit.getCurrentBranch,
      checkoutBranch: mockedGit.checkoutBranch,
      pullLatestChanges: mockedGit.pullLatestChanges,
      rebaseBranch: mockedGit.rebaseBranch,
      isBranchAheadOfRemote: mockedGit.isBranchAheadOfRemote,
      pushBranch: mockedGit.pushBranch,
      readFileFromGit: mockedGit.readFileFromGit,
      getMostRecentPackageStableTag: mockedGit.getMostRecentPackageStableTag,
      createAndPushPackageTag: mockedGit.createAndPushPackageTag,
      createBranch: mockedGit.createBranch,
      commitPaths: mockedGit.commitPaths,
      commitChanges: mockedGit.commitChanges,
      getMostRecentPackageTag: mockedGit.getMostRecentPackageTag,
      getGroupedFilesByCommitSha: mockedGit.getGroupedFilesByCommitSha,
    } as any),
  );

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.resetAllMocks();
});

describe("prepareReleaseBranch", () => {
  const baseOptions = {
    workspaceRoot: "/workspace",
    releaseBranch: "release/next",
    defaultBranch: "main",
  };

  it.effect("skips pull when remote branch does not exist", () =>
    withNode(Effect.gen(function* () {
      mockedGit.getCurrentBranch.mockReturnValue(Effect.succeed("main") as any);
      mockedGit.doesBranchExist.mockReturnValue(Effect.succeed(true) as any);
      mockedGit.doesRemoteBranchExist.mockReturnValue(Effect.succeed(false) as any);
      mockedGit.checkoutBranch.mockReturnValue(Effect.succeed(true) as any);
      mockedGit.rebaseBranch.mockReturnValue(Effect.succeed(undefined) as any);

      yield* prepareReleaseBranch(baseOptions);

      expect(mockedGit.doesRemoteBranchExist).toHaveBeenCalledWith("release/next", "/workspace");
      expect(mockedGit.pullLatestChanges).not.toHaveBeenCalled();
    })));

  it.effect("pulls when remote branch exists", () =>
    withNode(Effect.gen(function* () {
      mockedGit.getCurrentBranch.mockReturnValue(Effect.succeed("main") as any);
      mockedGit.doesBranchExist.mockReturnValue(Effect.succeed(true) as any);
      mockedGit.doesRemoteBranchExist.mockReturnValue(Effect.succeed(true) as any);
      mockedGit.checkoutBranch.mockReturnValue(Effect.succeed(true) as any);
      mockedGit.pullLatestChanges.mockReturnValue(Effect.succeed(true) as any);
      mockedGit.rebaseBranch.mockReturnValue(Effect.succeed(undefined) as any);

      yield* prepareReleaseBranch(baseOptions);

      expect(mockedGit.pullLatestChanges).toHaveBeenCalledWith("release/next", "/workspace");
    })));

  it.effect("creates branch when it does not exist locally", () =>
    withNode(Effect.gen(function* () {
      mockedGit.getCurrentBranch.mockReturnValue(Effect.succeed("main") as any);
      mockedGit.doesBranchExist.mockReturnValue(Effect.succeed(false) as any);
      mockedGit.createBranch.mockReturnValue(Effect.succeed(undefined) as any);
      mockedGit.checkoutBranch.mockReturnValue(Effect.succeed(true) as any);
      mockedGit.rebaseBranch.mockReturnValue(Effect.succeed(undefined) as any);

      yield* prepareReleaseBranch(baseOptions);

      expect(mockedGit.createBranch).toHaveBeenCalledWith("release/next", "main", "/workspace");
      expect(mockedGit.doesRemoteBranchExist).not.toHaveBeenCalled();
      expect(mockedGit.pullLatestChanges).not.toHaveBeenCalled();
    })));
});

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
      mockFetch("GET", `${GITHUB_API_BASE}/repos/${OWNER}/${REPO}/pulls`, () => HttpResponse.json([]));
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

      mockFetch("GET", `${GITHUB_API_BASE}/repos/${OWNER}/${REPO}/pulls`, () => HttpResponse.json([]));
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

      mockFetch("GET", `${GITHUB_API_BASE}/repos/${OWNER}/${REPO}/pulls`, () => HttpResponse.json([]));
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
      mockFetch("GET", `${GITHUB_API_BASE}/repos/${OWNER}/${REPO}/pulls`, () => HttpResponse.json([]));
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
