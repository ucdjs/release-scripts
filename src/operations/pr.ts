import type { GitHubClient, GitHubError, GitHubPullRequest } from "#core/github";
import type { PackageRelease } from "#shared/types";
import type { Result } from "#types";
import { generatePullRequestBody } from "#core/github";
import { ok } from "#types";

interface SyncPullRequestOptions {
  github: GitHubClient;
  releaseBranch: string;
  defaultBranch: string;
  pullRequestTitle?: string;
  pullRequestBody?: string;
  updates: PackageRelease[];
}

export async function syncPullRequest(options: SyncPullRequestOptions): Promise<Result<{
  pullRequest: GitHubPullRequest | null;
  created: boolean;
}, GitHubError>> {
  const { github, releaseBranch, defaultBranch, pullRequestTitle, pullRequestBody, updates } = options;

  let existing: GitHubPullRequest | null = null;
  try {
    existing = await github.getExistingPullRequest(releaseBranch);
  } catch (error) {
    return {
      ok: false,
      error: {
        type: "github",
        operation: "getExistingPullRequest",
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }

  const doesExist = !!existing;
  const title = existing?.title || pullRequestTitle || "chore: update package versions";
  const body = generatePullRequestBody(updates, pullRequestBody);

  let pr: GitHubPullRequest | null = null;
  try {
    pr = await github.upsertPullRequest({
      pullNumber: existing?.number,
      title,
      body,
      head: releaseBranch,
      base: defaultBranch,
    });
  } catch (error) {
    return {
      ok: false,
      error: {
        type: "github",
        operation: "upsertPullRequest",
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }

  return ok({
    pullRequest: pr,
    created: !doesExist,
  });
}
