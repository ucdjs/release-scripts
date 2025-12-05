/* eslint-disable no-console */
import { Effect, Schema } from "effect";
import { ConfigService } from "./config.service.js";
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

// Type inference from schemas
export type PullRequest = Schema.Schema.Type<typeof PullRequestSchema>;
export type CreatePullRequestOptions = Schema.Schema.Type<typeof CreatePullRequestOptionsSchema>;
export type UpdatePullRequestOptions = Schema.Schema.Type<typeof UpdatePullRequestOptionsSchema>;
export type CommitStatus = Schema.Schema.Type<typeof CommitStatusSchema>;
export type RepositoryInfo = Schema.Schema.Type<typeof RepositoryInfoSchema>;

export class GitHubService extends Effect.Service<GitHubService>()("@ucdjs/release-scripts/GitHubService", {
  effect: Effect.gen(function* () {
    const git = yield* GitService;
    const config = yield* ConfigService;

    const getRepositoryInfo = (): Effect.Effect<RepositoryInfo, Error> =>
      Effect.gen(function* () {
        const remoteUrl = yield* git.getRemoteUrl;
        if (!remoteUrl) {
          return yield* Effect.fail(new Error("No git remote found"));
        }

        const repoMatch = remoteUrl.match(/github\.com[/:]([\w-]+)\/([\w-]+)(?:\.git)?$/);
        if (!repoMatch) {
          return yield* Effect.fail(new Error("Could not parse GitHub repository from remote URL"));
        }

        const [, owner, repo] = repoMatch;
        return yield* Schema.decodeUnknown(RepositoryInfoSchema)({ owner, repo });
      });

    const makeRequest = <A, I>(
      endpoint: string,
      schema: Schema.Schema<A, I>,
      options: RequestInit = {},
    ): Effect.Effect<A, Error> => Effect.gen(function* () {
      const url = `https://api.github.com/repos/${config.owner}/${config.repo}/${endpoint}`;

      const response = yield* Effect.tryPromise(() =>
        fetch(url, {
          ...options,
          headers: {
            "Authorization": `token ${config.githubToken}`,
            "Accept": "application/vnd.github.v3+json",
            "Content-Type": "application/json",
            ...options.headers,
          },
        }),
      ).pipe(
        Effect.mapError((error) => new Error(`Failed to fetch: ${error}`)),
      );

      if (!response.ok) {
        const errorText = yield* Effect.tryPromise(() => response.text()).pipe(
          Effect.mapError(() => new Error("Could not read error response")),
        );
        return yield* Effect.fail(
          new Error(`GitHub API error: ${response.status} ${response.statusText}\n${errorText}`),
        );
      }

      const data = yield* Effect.tryPromise(() => response.json()).pipe(
        Effect.mapError((error) => new Error(`Failed to parse JSON: ${error}`)),
      );

      // Parse and validate the response using the schema
      return yield* Schema.decodeUnknown(schema)(data).pipe(
        Effect.mapError((error) => new Error(`Schema validation failed: ${error}`)),
      );
    });

    const getPullRequest = (prNumber: number): Effect.Effect<PullRequest, Error> =>
      makeRequest(`pulls/${prNumber}`, PullRequestSchema);

    const createPullRequest = (options: CreatePullRequestOptions): Effect.Effect<PullRequest, Error> =>
      Effect.gen(function* () {
        // Validate input
        const validatedOptions = yield* Schema.decodeUnknown(CreatePullRequestOptionsSchema)(options);

        return yield* makeRequest("pulls", PullRequestSchema, {
          method: "POST",
          body: JSON.stringify(validatedOptions),
        });
      });

    const updatePullRequest = (
      prNumber: number,
      options: UpdatePullRequestOptions,
    ): Effect.Effect<PullRequest, Error> =>
      Effect.gen(function* () {
        // Validate input
        const validatedOptions = yield* Schema.decodeUnknown(UpdatePullRequestOptionsSchema)(options);

        return yield* makeRequest(`pulls/${prNumber}`, PullRequestSchema, {
          method: "PATCH",
          body: JSON.stringify(validatedOptions),
        });
      });

    const createCommitStatus = (
      sha: string,
      status: CommitStatus,
    ): Effect.Effect<void, Error> =>
      Effect.gen(function* () {
        // Validate input
        const validatedStatus = yield* Schema.decodeUnknown(CommitStatusSchema)(status);

        const token = config.githubToken;
        if (!token) {
          return yield* Effect.fail(new Error("GITHUB_TOKEN environment variable is required"));
        }

        const repoInfo = yield* getRepositoryInfo();
        const url = `https://api.github.com/repos/${repoInfo.owner}/${repoInfo.repo}/statuses/${sha}`;

        const response = yield* Effect.promise(() =>
          fetch(url, {
            method: "POST",
            headers: {
              "Authorization": `token ${token}`,
              "Accept": "application/vnd.github.v3+json",
              "Content-Type": "application/json",
            },
            body: JSON.stringify(validatedStatus),
          }),
        );

        if (!response.ok) {
          const errorText = yield* Effect.promise(() => response.text());
          return yield* Effect.fail(
            new Error(`GitHub API error: ${response.status} ${response.statusText}\n${errorText}`),
          );
        }
      });

    const getCurrentPullRequest = (): Effect.Effect<PullRequest | null, Error> =>
      Effect.gen(function* () {
        const currentBranch = yield* git.getCurrentBranch;
        const repoInfo = yield* getRepositoryInfo();

        const pulls = yield* makeRequest(
          `pulls?head=${repoInfo.owner}:${currentBranch}&state=open`,
          Schema.Array(PullRequestSchema),
        ).pipe(
          Effect.catchAll(() => Effect.succeed([])),
        );

        return pulls.length > 0 ? pulls[0]! : null;
      });

    const createPullRequestFromCurrentBranch = (
      options: Omit<CreatePullRequestOptions, "head">,
    ): Effect.Effect<PullRequest, Error> =>
      Effect.gen(function* () {
        const currentBranch = yield* git.getCurrentBranch;

        return yield* createPullRequest({
          ...options,
          head: currentBranch,
        });
      });

    const pushCurrentBranch = (remote = "origin"): Effect.Effect<void, Error> =>
      Effect.gen(function* () {
        const currentBranch = yield* git.getCurrentBranch;
        yield* git.push(remote, currentBranch);
      });

    const createPullRequestWorkflow = (
      options: Omit<CreatePullRequestOptions, "head"> & { pushFirst?: boolean },
    ): Effect.Effect<PullRequest, Error> =>
      Effect.gen(function* () {
        const { pushFirst = true, ...prOptions } = options;

        // Push current branch if requested
        if (pushFirst) {
          console.log("📤 Pushing current branch to remote...");
          yield* pushCurrentBranch();
        }

        // Check if PR already exists
        const existingPr = yield* getCurrentPullRequest();
        if (existingPr) {
          console.log(`✓ Pull request already exists: #${existingPr.number}`);
          return existingPr;
        }

        // Create new PR
        console.log("📝 Creating pull request...");
        const pr = yield* createPullRequestFromCurrentBranch(prOptions);
        console.log(`✅ Created pull request #${pr.number}: ${pr.html_url}`);

        return pr;
      });

    const setCommitStatusForCurrentBranch = (status: CommitStatus): Effect.Effect<void, Error> =>
      Effect.gen(function* () {
        const commitHash = yield* git.getLastCommitHash;
        yield* createCommitStatus(commitHash, status);
      });

    return {
      getPullRequest,
      createPullRequest,
      updatePullRequest,
      createCommitStatus,
      getCurrentPullRequest,
      createPullRequestFromCurrentBranch,
      pushCurrentBranch,
      createPullRequestWorkflow,
      setCommitStatusForCurrentBranch,
      getRepositoryInfo,
    } as const;
  }),
  dependencies: [GitService.Default],
}) {}
