import type { AuthorInfo, PackageRelease } from "#shared/types";
import { logger } from "#shared/utils";
import { Eta } from "eta";
import farver from "farver";
import { DEFAULT_PR_BODY_TEMPLATE } from "../options";

interface SharedGitHubOptions {
  owner: string;
  repo: string;
  githubToken: string;
}

export interface GitHubPullRequest {
  number: number;
  title: string;
  body: string;
  draft: boolean;
  html_url?: string;
  head?: {
    sha: string;
  };
}

export type CommitStatusState = "error" | "failure" | "pending" | "success";

export interface CommitStatusOptions {
  state: CommitStatusState;
  targetUrl?: string;
  description?: string;
  context: string;
}

export interface UpsertPullRequestOptions {
  title: string;
  body: string;
  head?: string;
  base?: string;
  pullNumber?: number;
}

export class GitHubClient {
  private readonly owner: string;
  private readonly repo: string;
  private readonly githubToken: string;
  private readonly apiBase = "https://api.github.com";

  constructor({ owner, repo, githubToken }: SharedGitHubOptions) {
    this.owner = owner;
    this.repo = repo;
    this.githubToken = githubToken;
  }

  private async request<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
    const url = path.startsWith("http") ? path : `${this.apiBase}${path}`;

    const res = await fetch(url, {
      ...init,
      headers: {
        ...init.headers,
        "Accept": "application/vnd.github.v3+json",
        "Authorization": `token ${this.githubToken}`,
        "User-Agent": "ucdjs-release-scripts (+https://github.com/ucdjs/ucdjs-release-scripts)",
      },
    });

    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(`GitHub API request failed with status ${res.status}: ${errorText || "No response body"}`);
    }

    if (res.status === 204) {
      return undefined as T;
    }

    return res.json() as Promise<T>;
  }

  async getExistingPullRequest(branch: string): Promise<GitHubPullRequest | null> {
    const head = branch.includes(":") ? branch : `${this.owner}:${branch}`;
    const endpoint = `/repos/${this.owner}/${this.repo}/pulls?state=open&head=${encodeURIComponent(head)}`;

    logger.verbose(`Requesting pull request for branch: ${branch} (url: ${this.apiBase}${endpoint})`);
    const pulls = await this.request<unknown[]>(endpoint);

    if (!Array.isArray(pulls) || pulls.length === 0) {
      return null;
    }

    const firstPullRequest: unknown = pulls[0];

    if (
      typeof firstPullRequest !== "object"
      || firstPullRequest === null
      || !("number" in firstPullRequest)
      || typeof firstPullRequest.number !== "number"
      || !("title" in firstPullRequest)
      || typeof firstPullRequest.title !== "string"
      || !("body" in firstPullRequest)
      || typeof firstPullRequest.body !== "string"
      || !("draft" in firstPullRequest)
      || typeof firstPullRequest.draft !== "boolean"
      || !("html_url" in firstPullRequest)
      || typeof firstPullRequest.html_url !== "string"
    ) {
      throw new TypeError("Pull request data validation failed");
    }

    const pullRequest: GitHubPullRequest = {
      number: firstPullRequest.number,
      title: firstPullRequest.title,
      body: firstPullRequest.body,
      draft: firstPullRequest.draft,
      html_url: firstPullRequest.html_url,
      head: "head" in firstPullRequest
        && typeof firstPullRequest.head === "object"
        && firstPullRequest.head !== null
        && "sha" in firstPullRequest.head
        && typeof firstPullRequest.head.sha === "string"
        ? { sha: firstPullRequest.head.sha }
        : undefined,
    };

    logger.info(`Found existing pull request: ${farver.yellow(`#${pullRequest.number}`)}`);
    return pullRequest;
  }

  async upsertPullRequest({
    title,
    body,
    head,
    base,
    pullNumber,
  }: UpsertPullRequestOptions): Promise<GitHubPullRequest | null> {
    const isUpdate = typeof pullNumber === "number";
    const endpoint = isUpdate
      ? `/repos/${this.owner}/${this.repo}/pulls/${pullNumber}`
      : `/repos/${this.owner}/${this.repo}/pulls`;

    const requestBody = isUpdate
      ? { title, body }
      : { title, body, head, base, draft: true };

    logger.verbose(`${isUpdate ? "Updating" : "Creating"} pull request (url: ${this.apiBase}${endpoint})`);

    const pr = await this.request<unknown>(endpoint, {
      method: isUpdate ? "PATCH" : "POST",
      body: JSON.stringify(requestBody),
    });

    if (
      typeof pr !== "object"
      || pr === null
      || !("number" in pr)
      || typeof pr.number !== "number"
      || !("title" in pr)
      || typeof pr.title !== "string"
      || !("body" in pr)
      || typeof pr.body !== "string"
      || !("draft" in pr)
      || typeof pr.draft !== "boolean"
      || !("html_url" in pr)
      || typeof pr.html_url !== "string"
    ) {
      throw new TypeError("Pull request data validation failed");
    }

    const action = isUpdate ? "Updated" : "Created";
    logger.info(`${action} pull request: ${farver.yellow(`#${pr.number}`)}`);

    return {
      number: pr.number,
      title: pr.title,
      body: pr.body,
      draft: pr.draft,
      html_url: pr.html_url,
    };
  }

  async setCommitStatus({
    sha,
    state,
    targetUrl,
    description,
    context,
  }: CommitStatusOptions & { sha: string }): Promise<void> {
    const endpoint = `/repos/${this.owner}/${this.repo}/statuses/${sha}`;

    logger.verbose(`Setting commit status on ${sha} to ${state} (url: ${this.apiBase}${endpoint})`);

    await this.request(endpoint, {
      method: "POST",
      body: JSON.stringify({
        state,
        target_url: targetUrl,
        description: description || "",
        context,
      }),
    });

    logger.info(`Commit status set to ${farver.cyan(state)} for ${farver.gray(sha.substring(0, 7))}`);
  }

  async resolveAuthorInfo(info: AuthorInfo): Promise<AuthorInfo> {
    if (info.login) {
      return info;
    }

    try {
      // https://docs.github.com/en/search-github/searching-on-github/searching-users#search-only-users-or-organizations
      const q = encodeURIComponent(`${info.email} type:user in:email`);
      const data = await this.request<{
        items?: Array<{ login: string }>;
      }>(`/search/users?q=${q}`);

      if (!data.items || data.items.length === 0) {
        return info;
      }

      info.login = data.items[0]!.login;
    } catch (err) {
      logger.warn(`Failed to resolve author info for email ${info.email}: ${(err as Error).message}`);
    }

    if (info.login) {
      return info;
    }

    if (info.commits.length > 0) {
      try {
        const data = await this.request<{
          author: {
            login: string;
          };
        }>(
          `/repos/${this.owner}/${this.repo}/commits/${info.commits[0]}`,
        );

        if (data.author && data.author.login) {
          info.login = data.author.login;
        }
      } catch (err) {
        logger.warn(`Failed to resolve author info from commits for email ${info.email}: ${(err as Error).message}`);
      }
    }

    return info;
  }
}

export function createGitHubClient(options: SharedGitHubOptions): GitHubClient {
  return new GitHubClient(options);
}

function dedentString(str: string): string {
  const lines = str.split("\n");
  const minIndent = lines
    .filter((line) => line.trim().length > 0)
    .reduce((min, line) => Math.min(min, line.search(/\S/)), Infinity);

  return lines
    .map((line) => (minIndent === Infinity ? line : line.slice(minIndent)))
    .join("\n")
    .trim();
}

export function generatePullRequestBody(updates: PackageRelease[], body?: string): string {
  const eta = new Eta();

  const bodyTemplate = body ? dedentString(body) : DEFAULT_PR_BODY_TEMPLATE;

  return eta.renderString(bodyTemplate, {
    packages: updates.map((u) => ({
      name: u.package.name,
      currentVersion: u.currentVersion,
      newVersion: u.newVersion,
      bumpType: u.bumpType,
      hasDirectChanges: u.hasDirectChanges,
    })),
  });
}
