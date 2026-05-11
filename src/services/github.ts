import { formatUnknownError } from "../shared/errors";
import { ReleaseOptions } from "../options";
import type { AuthorInfo, PackageRelease } from "../shared/types";
import { logger } from "../shared/utils";
import { Context, Data, Effect, Layer } from "effect";
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

type CommitStatusState = "error" | "failure" | "pending" | "success";

interface CommitStatusOptions {
  state: CommitStatusState;
  targetUrl?: string;
  description?: string;
  context: string;
}

interface UpsertPullRequestOptions {
  title: string;
  body: string;
  head?: string;
  base?: string;
  pullNumber?: number;
}

interface UpsertReleaseOptions {
  tagName: string;
  name: string;
  body?: string;
  prerelease?: boolean;
}

interface GitHubRelease {
  id: number;
  tagName: string;
  name: string;
  htmlUrl?: string;
}

export class GitHubError extends Data.TaggedError("GitHubError")<{
  operation: string;
  message: string;
  status?: number;
}> {}

export interface GitHubServiceShape {
  readonly getExistingPullRequest: (branch: string) => Effect.Effect<GitHubPullRequest | null, GitHubError>;
  readonly upsertPullRequest: (
    options: UpsertPullRequestOptions,
  ) => Effect.Effect<GitHubPullRequest | null, GitHubError>;
  readonly setCommitStatus: (
    options: CommitStatusOptions & { sha: string },
  ) => Effect.Effect<void, GitHubError>;
  readonly upsertReleaseByTag: (
    options: UpsertReleaseOptions,
  ) => Effect.Effect<{ release: GitHubRelease; created: boolean }, GitHubError>;
  readonly resolveAuthorInfo: (info: AuthorInfo) => Effect.Effect<AuthorInfo, GitHubError>;
}

function toGitHubError(operation: string, error: unknown): GitHubError {
  const formatted = formatUnknownError(error);

  return new GitHubError({
    operation,
    message: formatted.message,
    status: formatted.status,
  });
}

export class GitHubService extends Context.Service<GitHubService, GitHubServiceShape>()(
  "@ucdjs/release-scripts/GitHubService",
) {}

export const makeGitHubService = Effect.fn("makeGitHubService")(function* () {
  const options = yield* ReleaseOptions;
  const githubOptions: SharedGitHubOptions = {
    owner: options.owner,
    repo: options.repo,
    githubToken: options.githubToken,
  };
  const apiBase = "https://api.github.com";

  const request = Effect.fn("githubRequest")(function* <T = unknown>(
    operation: string,
    path: string,
    init: RequestInit = {},
  ) {
    const url = path.startsWith("http") ? path : `${apiBase}${path}`;
    const method = init.method ?? "GET";

    const response = yield* Effect.tryPromise({
      try: () =>
        fetch(url, {
          ...init,
          headers: {
            ...init.headers,
            Accept: "application/vnd.github.v3+json",
            Authorization: `token ${githubOptions.githubToken}`,
            "User-Agent": "ucdjs-release-scripts (+https://github.com/ucdjs/ucdjs-release-scripts)",
          },
        }),
      catch: (error) =>
        toGitHubError(
          operation,
          Object.assign(
            new Error(`[${method} ${path}] GitHub request failed: ${formatUnknownError(error).message}`),
            { status: undefined },
          ),
        ),
    });

    if (!response.ok) {
      const errorText = yield* Effect.tryPromise({
        try: () => response.text(),
        catch: (error) => toGitHubError(operation, error),
      });

      const parsedMessage = (() => {
        try {
          const parsed = JSON.parse(errorText) as { message?: string; errors?: unknown };
          if (typeof parsed.message === "string" && parsed.message.trim()) {
            if (Array.isArray(parsed.errors) && parsed.errors.length > 0) {
              return `${parsed.message} (${JSON.stringify(parsed.errors)})`;
            }

            return parsed.message;
          }

          return errorText;
        } catch {
          return errorText;
        }
      })();

      return yield* Effect.fail(
        toGitHubError(
          operation,
          Object.assign(
            new Error(
              `[${method} ${path}] GitHub API request failed (${response.status} ${response.statusText}): ${parsedMessage || "No response body"}`,
            ),
            { status: response.status },
          ),
        ),
      );
    }

    if (response.status === 204) {
      return undefined as T;
    }

    return yield* Effect.tryPromise({
      try: () => response.json() as Promise<T>,
      catch: (error) => toGitHubError(operation, error),
    })
  });

  const getExistingPullRequest: GitHubServiceShape["getExistingPullRequest"] = Effect.fn(
    "getExistingPullRequest",
  )(function* (branch) {
    const head = branch.includes(":") ? branch : `${githubOptions.owner}:${branch}`;
    const endpoint = `/repos/${githubOptions.owner}/${githubOptions.repo}/pulls?state=open&head=${encodeURIComponent(head)}`;

    logger.verbose(
      `Requesting pull request for branch: ${branch} (url: ${apiBase}${endpoint})`,
    );
    const pulls = yield* request<unknown[]>("getExistingPullRequest", endpoint);

    if (!Array.isArray(pulls) || pulls.length === 0) {
      return null;
    }

    const firstPullRequest: unknown = pulls[0];

    if (
      typeof firstPullRequest !== "object" ||
      firstPullRequest === null ||
      !("number" in firstPullRequest) ||
      typeof firstPullRequest.number !== "number" ||
      !("title" in firstPullRequest) ||
      typeof firstPullRequest.title !== "string" ||
      !("body" in firstPullRequest) ||
      typeof firstPullRequest.body !== "string" ||
      !("draft" in firstPullRequest) ||
      typeof firstPullRequest.draft !== "boolean" ||
      !("html_url" in firstPullRequest) ||
      typeof firstPullRequest.html_url !== "string"
    ) {
      return yield* Effect.fail(
        new GitHubError({
          operation: "getExistingPullRequest",
          message: "Pull request data validation failed",
        }),
      );
    }

    const pullRequest: GitHubPullRequest = {
      number: firstPullRequest.number,
      title: firstPullRequest.title,
      body: firstPullRequest.body,
      draft: firstPullRequest.draft,
      html_url: firstPullRequest.html_url,
      head:
        "head" in firstPullRequest &&
        typeof firstPullRequest.head === "object" &&
        firstPullRequest.head !== null &&
        "sha" in firstPullRequest.head &&
        typeof firstPullRequest.head.sha === "string"
          ? { sha: firstPullRequest.head.sha }
          : undefined,
    };

    logger.info(`Found existing pull request: ${farver.yellow(`#${pullRequest.number}`)}`);
    return pullRequest;
  });

  const upsertPullRequest: GitHubServiceShape["upsertPullRequest"] = Effect.fn(
    "upsertPullRequest",
  )(function* ({ title, body, head, base, pullNumber }) {
    const isUpdate = typeof pullNumber === "number";
    const endpoint = isUpdate
      ? `/repos/${githubOptions.owner}/${githubOptions.repo}/pulls/${pullNumber}`
      : `/repos/${githubOptions.owner}/${githubOptions.repo}/pulls`;

    const requestBody = isUpdate ? { title, body } : { title, body, head, base, draft: true };

    logger.verbose(
      `${isUpdate ? "Updating" : "Creating"} pull request (url: ${apiBase}${endpoint})`,
    );

    const pr = yield* request<unknown>("upsertPullRequest", endpoint, {
      method: isUpdate ? "PATCH" : "POST",
      body: JSON.stringify(requestBody),
    });

    if (
      typeof pr !== "object" ||
      pr === null ||
      !("number" in pr) ||
      typeof pr.number !== "number" ||
      !("title" in pr) ||
      typeof pr.title !== "string" ||
      !("body" in pr) ||
      typeof pr.body !== "string" ||
      !("draft" in pr) ||
      typeof pr.draft !== "boolean" ||
      !("html_url" in pr) ||
      typeof pr.html_url !== "string"
    ) {
      return yield* Effect.fail(
        new GitHubError({
          operation: "upsertPullRequest",
          message: "Pull request data validation failed",
        }),
      );
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
  });

  const setCommitStatus: GitHubServiceShape["setCommitStatus"] = Effect.fn(
    "setCommitStatus",
  )(function* ({ sha, state, targetUrl, description, context }) {
    const endpoint = `/repos/${githubOptions.owner}/${githubOptions.repo}/statuses/${sha}`;

    logger.verbose(`Setting commit status on ${sha} to ${state} (url: ${apiBase}${endpoint})`);

    yield* request("setCommitStatus", endpoint, {
      method: "POST",
      body: JSON.stringify({
        state,
        target_url: targetUrl,
        description: description || "",
        context,
      }),
    });

    logger.info(
      `Commit status set to ${farver.cyan(state)} for ${farver.gray(sha.substring(0, 7))}`,
    );
  });

  const upsertReleaseByTag: GitHubServiceShape["upsertReleaseByTag"] = Effect.fn(
    "upsertReleaseByTag",
  )(function* ({ tagName, name, body, prerelease = false }) {
    const encodedTag = encodeURIComponent(tagName);

    const existingRelease = yield* request<{
      id: number;
      tag_name: string;
      name?: string;
      html_url?: string;
    }>("upsertReleaseByTag", `/repos/${githubOptions.owner}/${githubOptions.repo}/releases/tags/${encodedTag}`).pipe(
      Effect.catchTag("GitHubError", (error) =>
        error.status === 404 ? Effect.succeed(null) : Effect.fail(error),
      ),
    );

    if (existingRelease) {
      logger.verbose(`Updating release for tag ${farver.cyan(tagName)}`);

      const updated = yield* request<{
        id: number;
        tag_name: string;
        name?: string;
        html_url?: string;
      }>("upsertReleaseByTag", `/repos/${githubOptions.owner}/${githubOptions.repo}/releases/${existingRelease.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          name,
          body,
          prerelease,
          draft: false,
        }),
      });

      logger.info(`Updated GitHub release for ${farver.cyan(tagName)}`);
      return {
        release: {
          id: updated.id,
          tagName: updated.tag_name,
          name: updated.name ?? name,
          htmlUrl: updated.html_url,
        },
        created: false,
      };
    }

    logger.verbose(`Creating release for tag ${farver.cyan(tagName)}`);

    const created = yield* request<{
      id: number;
      tag_name: string;
      name?: string;
      html_url?: string;
    }>("upsertReleaseByTag", `/repos/${githubOptions.owner}/${githubOptions.repo}/releases`, {
      method: "POST",
      body: JSON.stringify({
        tag_name: tagName,
        name,
        body,
        prerelease,
        draft: false,
        generate_release_notes: body == null,
      }),
    });

    logger.info(`Created GitHub release for ${farver.cyan(tagName)}`);
    return {
      release: {
        id: created.id,
        tagName: created.tag_name,
        name: created.name ?? name,
        htmlUrl: created.html_url,
      },
      created: true,
    };
  });

  const resolveAuthorInfo: GitHubServiceShape["resolveAuthorInfo"] = Effect.fn(
    "resolveAuthorInfo",
  )(function* (info) {
    if (info.login) {
      return info;
    }

    const searchedInfo = yield* request<{ items?: Array<{ login: string }> }>(
      "resolveAuthorInfo",
      `/search/users?q=${encodeURIComponent(`${info.email} type:user in:email`)}`,
    ).pipe(
      Effect.map((data) => {
        if (data.items && data.items.length > 0) {
          return { ...info, login: data.items[0]!.login };
        }
        return info;
      }),
      Effect.catchTag("GitHubError", (error) => {
        logger.warn(
          `Failed to resolve author info for email ${info.email}: ${formatUnknownError(error).message}`,
        );
        return Effect.succeed(info);
      }),
    );

    if (searchedInfo.login) {
      return searchedInfo;
    }

    if (searchedInfo.commits.length > 0) {
      return yield* request<{ author: { login: string } }>(
        "resolveAuthorInfo",
        `/repos/${githubOptions.owner}/${githubOptions.repo}/commits/${searchedInfo.commits[0]}`,
      ).pipe(
        Effect.map((data) =>
          data.author?.login ? { ...searchedInfo, login: data.author.login } : searchedInfo,
        ),
        Effect.catchTag("GitHubError", (error) => {
          logger.warn(
            `Failed to resolve author info from commits for email ${searchedInfo.email}: ${formatUnknownError(error).message}`,
          );
          return Effect.succeed(searchedInfo);
        }),
      );
    }

    return searchedInfo;
  });

  return GitHubService.of({
    getExistingPullRequest,
    upsertPullRequest,
    setCommitStatus,
    upsertReleaseByTag,
    resolveAuthorInfo,
  });
});

export const GitHubServiceLive = Layer.effect(GitHubService, makeGitHubService());

export { toGitHubError };

const NON_WHITESPACE_RE = /\S/;

function dedentString(str: string): string {
  const lines = str.split("\n");
  const minIndent = lines
    .filter((line) => line.trim().length > 0)
    .reduce((min, line) => Math.min(min, line.search(NON_WHITESPACE_RE)), Infinity);

  return lines
    .map((line) => (minIndent === Infinity ? line : line.slice(minIndent)))
    .join("\n")
    .trim();
}

export function generatePullRequestBody(updates: PackageRelease[], body?: string): string {
  const eta = new Eta();

  const bodyTemplate = body ? dedentString(body) : DEFAULT_PR_BODY_TEMPLATE;

  const allPackages = updates.map((u) => ({
    name: u.package.name,
    currentVersion: u.currentVersion,
    newVersion: u.newVersion,
    bumpType: u.bumpType,
    hasDirectChanges: u.hasDirectChanges,
    changeKind: u.changeKind,
  }));

  return eta.renderString(bodyTemplate, {
    packages: allPackages,
    releases: allPackages.filter((p) => p.changeKind !== "as-is"),
    asIs: allPackages.filter((p) => p.changeKind === "as-is"),
  });
}
