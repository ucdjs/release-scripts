import { Effect } from "effect";
import {
  generatePullRequestBody,
  GitHubError,
  type GitHubPullRequest,
  GitHubService,
  toGitHubError,
} from "../services/github";
import type { PackageRelease } from "../shared/types";

interface SyncPullRequestOptions {
  releaseBranch: string;
  defaultBranch: string;
  pullRequestTitle?: string;
  pullRequestBody?: string;
  updates: PackageRelease[];
}

export const syncPullRequest = Effect.fn("syncPullRequest")(function* (
  options: SyncPullRequestOptions,
) {
  const github = yield* GitHubService;
  const { releaseBranch, defaultBranch, pullRequestTitle, pullRequestBody, updates } = options;

  const existing = yield* Effect.catchTag(
    github.getExistingPullRequest(releaseBranch),
    "GitHubError",
    (error) =>
      Effect.fail(new GitHubError({ ...error, operation: "getExistingPullRequest" })),
    (error) => Effect.fail(toGitHubError("getExistingPullRequest", error)),
  );

  const doesExist = !!existing;
  const title = existing?.title || pullRequestTitle || "chore: update package versions";
  const body = generatePullRequestBody(updates, pullRequestBody);

  const pr = yield* Effect.catchTag(github.upsertPullRequest({
      pullNumber: existing?.number,
      title,
      body,
      head: releaseBranch,
      base: defaultBranch,
    }) as Effect.Effect<GitHubPullRequest | null, GitHubError, unknown>, "GitHubError", (error) =>
      Effect.fail(new GitHubError({ ...error, operation: "upsertPullRequest" })),
      (error) => Effect.fail(toGitHubError("upsertPullRequest", error)),
    );

  return {
    pullRequest: pr,
    created: !doesExist,
  };
});
