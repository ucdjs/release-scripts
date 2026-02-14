import type { GitHubError, GitHubOperations } from "#core/types";
import type { PackageRelease } from "#shared/types";
import type { Result } from "#types/result";
import { generatePullRequestBody } from "#core/github";
import { ok } from "#types/result";

interface SyncPullRequestOptions {
  github: GitHubOperations;
  releaseBranch: string;
  defaultBranch: string;
  pullRequestTitle?: string;
  pullRequestBody?: string;
  updates: PackageRelease[];
}

export async function syncPullRequest(options: SyncPullRequestOptions): Promise<Result<{
  pullRequest: import("#core/github").GitHubPullRequest | null;
  created: boolean;
}, GitHubError>> {
  const { github, releaseBranch, defaultBranch, pullRequestTitle, pullRequestBody, updates } = options;

  const existing = await github.getExistingPullRequest(releaseBranch);
  if (!existing.ok) return existing;

  const doesExist = !!existing.value;
  const title = existing.value?.title || pullRequestTitle || "chore: update package versions";
  const body = generatePullRequestBody(updates, pullRequestBody);

  const pr = await github.upsertPullRequest({
    pullNumber: existing.value?.number,
    title,
    body,
    head: releaseBranch,
    base: defaultBranch,
  });

  if (!pr.ok) return pr;

  return ok({
    pullRequest: pr.value,
    created: !doesExist,
  });
}
