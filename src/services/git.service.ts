import { Command, CommandExecutor } from "@effect/platform";
import { NodeCommandExecutor } from "@effect/platform-node";
import { Effect } from "effect";
import { GitCommandError, GitError } from "../errors";

export class GitService extends Effect.Service<GitService>()("@ucdjs/release-scripts/GitService", {
  effect: Effect.gen(function* () {
    const executor = yield* CommandExecutor.CommandExecutor;

    const execGitCommand = (args: readonly string[]): Effect.Effect<string, GitCommandError> =>
      executor.string(Command.make("git", ...args)).pipe(
        Effect.mapError((error: any) =>
          new GitCommandError({
            command: `git ${args.join(" ")}`,
            exitCode: error.exitCode || 1,
            stderr: error.stderr || error.message || "Unknown error",
          }),
        ),
      );

    const getCurrentBranch: Effect.Effect<string, GitError | GitCommandError> = Effect.gen(function* () {
      const output = yield* execGitCommand(["rev-parse", "--abbrev-ref", "HEAD"]);
      const branch = output.trim();

      if (branch === "HEAD") {
        return yield* Effect.fail(
          new GitError({ message: "Repository is in detached HEAD state" }),
        );
      }

      return branch;
    });

    const listBranches: Effect.Effect<readonly string[], GitCommandError> = Effect.gen(function* () {
      const output = yield* execGitCommand(["branch", "--format=%(refname:short)"]);
      return output
        .trim()
        .split("\n")
        .filter((branch: string) => branch.length > 0)
        .map((branch: string) => branch.trim());
    });

    const isRepository: Effect.Effect<boolean, never> = execGitCommand(["rev-parse", "--git-dir"]).pipe(
      Effect.map(() => true),
      Effect.catchAll(() => Effect.succeed(false)),
    );

    const getRemoteUrl: Effect.Effect<string | undefined, never> = execGitCommand(["config", "--get", "remote.origin.url"]).pipe(
      Effect.map((output) => {
        const url = output.trim();
        return url.length > 0 ? url : undefined;
      }),
      Effect.catchAll(() => Effect.succeed(undefined)),
    );

    const hasChanges: Effect.Effect<boolean, GitCommandError> = Effect.gen(function* () {
      const output = yield* execGitCommand(["status", "--porcelain"]);
      return output.trim().length > 0;
    });

    const hasStagedChanges: Effect.Effect<boolean, GitCommandError> = Effect.gen(function* () {
      const output = yield* execGitCommand(["diff", "--cached", "--name-only"]);
      return output.trim().length > 0;
    });

    const getLastCommitHash: Effect.Effect<string, GitCommandError> = Effect.gen(function* () {
      const output = yield* execGitCommand(["rev-parse", "HEAD"]);
      return output.trim();
    });

    const branchExists = (branchName: string): Effect.Effect<boolean, never> =>
      execGitCommand(["rev-parse", "--verify", `refs/heads/${branchName}`]).pipe(
        Effect.map(() => true),
        Effect.catchAll(() => Effect.succeed(false)),
      );

    const addFiles = (files: readonly string[]): Effect.Effect<void, GitCommandError> =>
      execGitCommand(["add", ...files]).pipe(Effect.asVoid);

    const commit = (message: string): Effect.Effect<void, GitCommandError> =>
      execGitCommand(["commit", "-m", message]).pipe(Effect.asVoid);

    const createTag = (tagName: string, message?: string): Effect.Effect<void, GitCommandError> => {
      const args = message
        ? ["tag", "-a", tagName, "-m", message]
        : ["tag", tagName];
      return execGitCommand(args).pipe(Effect.asVoid);
    };

    const push = (remote = "origin", branch?: string): Effect.Effect<void, GitCommandError> => {
      const args = branch ? ["push", remote, branch] : ["push", remote];
      return execGitCommand(args).pipe(Effect.asVoid);
    };

    const pushTags = (remote = "origin"): Effect.Effect<void, GitCommandError> =>
      execGitCommand(["push", remote, "--tags"]).pipe(Effect.asVoid);

    return {
      getCurrentBranch,
      listBranches,
      isRepository,
      getRemoteUrl,
      hasChanges,
      hasStagedChanges,
      getLastCommitHash,
      branchExists,
      addFiles,
      commit,
      createTag,
      push,
      pushTags,
    } as const;
  }),
  dependencies: [
    NodeCommandExecutor.layer,
  ],
}) {}
