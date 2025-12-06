import { Effect, Schema } from "effect";
import { GitHubError } from "../errors.js";
import { ConfigOptions } from "./config.service.js";
import { GitService } from "./git.service.js";

// Schema definitions for GitHub API types
export const PullRequestSchema = Schema.Struct({
  number: Schema.Number,
  title: Schema.String,
  body: Schema.String,
  head: Schema.Struct({
    ref: Schema.String,
    sha: Schema.String,
  }),
  base: Schema.Struct({
    ref: Schema.String,
    sha: Schema.String,
  }),
  state: Schema.Literal("open", "closed", "merged"),
  draft: Schema.Boolean,
  mergeable: Schema.NullOr(Schema.Boolean),
  url: Schema.String,
  html_url: Schema.String,
});

export const CreatePullRequestOptionsSchema = Schema.Struct({
  title: Schema.String,
  body: Schema.String,
  head: Schema.String,
  base: Schema.String,
  draft: Schema.optional(Schema.Boolean),
});

export const UpdatePullRequestOptionsSchema = Schema.Struct({
  title: Schema.optional(Schema.String),
  body: Schema.optional(Schema.String),
  state: Schema.optional(Schema.Literal("open", "closed")),
});

export const CommitStatusSchema = Schema.Struct({
  state: Schema.Literal("pending", "success", "error", "failure"),
  target_url: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  context: Schema.String,
});

export const RepositoryInfoSchema = Schema.Struct({
  owner: Schema.String,
  repo: Schema.String,
});

export type PullRequest = Schema.Schema.Type<typeof PullRequestSchema>;
export type CreatePullRequestOptions = Schema.Schema.Type<typeof CreatePullRequestOptionsSchema>;
export type UpdatePullRequestOptions = Schema.Schema.Type<typeof UpdatePullRequestOptionsSchema>;
export type CommitStatus = Schema.Schema.Type<typeof CommitStatusSchema>;
export type RepositoryInfo = Schema.Schema.Type<typeof RepositoryInfoSchema>;

export class GitHubService extends Effect.Service<GitHubService>()("@ucdjs/release-scripts/GitHubService", {
  effect: Effect.gen(function* () {
    const config = yield* ConfigOptions;

    function makeRequest<A, I>(endpoint: string, schema: Schema.Schema<A, I>, options: RequestInit = {}) {
      const url = `https://api.github.com/repos/${config.owner}/${config.repo}/${endpoint}`;
      return Effect.tryPromise({
        try: async () => {
          const res = await fetch(url, {
            ...options,
            headers: {
              "Authorization": `token ${config.githubToken}`,
              "Accept": "application/vnd.github.v3+json",
              "Content-Type": "application/json",
              "User-Agent": "ucdjs-release-scripts (https://github.com/ucdjs/release-scripts)",
              ...options.headers,
            },
          });

          if (!res.ok) {
            const text = await res.text();
            throw new Error(`GitHub API request failed with status ${res.status}: ${text}`);
          }

          if (res.status === 204) {
            return undefined;
          }

          return res.json();
        },
        catch: (e) => new GitHubError({ message: String(e), operation: "request", cause: e }),
      }).pipe(
        Effect.flatMap((json) =>
          json === undefined
            ? Effect.succeed(undefined as A)
            : Schema.decodeUnknown(schema)(json).pipe(
                Effect.mapError(
                  (e) =>
                    new GitHubError({
                      message: "Failed to decode GitHub response",
                      operation: "request",
                      cause: e,
                    }),
                ),
              ),
        ),
      );
    }

    function getPullRequestByBranch(branch: string) {
      const head = branch.includes(":") ? branch : `${config.owner}:${branch}`;
      const url = `/repos/${config.owner}/${config.repo}/pulls?state=open&head=${encodeURIComponent(head)}`;
      return makeRequest(url, Schema.Array(PullRequestSchema)).pipe(
        Effect.map((pulls) => (pulls.length > 0 ? pulls[0] : null)),
        Effect.mapError((e) => new GitHubError({
          message: e.message,
          operation: "getPullRequestByBranch",
          cause: e.cause,
        })),
      );
    }

    return {
      getPullRequestByBranch,
    } as const;
  }),
  dependencies: [
    GitService.Default,
  ],
}) { }
