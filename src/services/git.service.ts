import { Command, CommandExecutor } from "@effect/platform";
import { NodeCommandExecutor } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import { GitCommandError } from "../errors";
import { ConfigOptions } from "./config.service";

export class GitService extends Effect.Service<GitService>()("@ucdjs/release-scripts/GitService", {
  effect: Effect.gen(function* () {
    const executor = yield* CommandExecutor.CommandExecutor;
    const config = yield* ConfigOptions;

    const execGitCommand = (args: readonly string[]) =>
      executor.string(Command.make("git", ...args).pipe(
        Command.workingDirectory(config.workspaceRoot),
      )).pipe(
        Effect.mapError((err) => {
          return new GitCommandError({
            command: `git ${args.join(" ")}`,
            stderr: err.message,
          });
        }),
      );

    // This should only be used by functions that need to respect dry-run mode
    // e.g. createBranch, deleteBranch.
    // Functions that just modify git behavior (checkoutBranch, etc.) should use execGitCommand directly.
    // Since it doesn't really change external state.
    const execGitCommandIfNotDry = config.dryRun
      ? (args: readonly string[]) =>
          Effect.succeed(
            `Dry run mode: skipping git command "git ${args.join(" ")}"`,
          )
      : execGitCommand;

    const isWithinRepository = Effect.gen(function* () {
      const result = yield* execGitCommand(["rev-parse", "--is-inside-work-tree"]).pipe(
        Effect.catchAll(() => Effect.succeed("false")),
      );
      return result.trim() === "true";
    });

    const listBranches = Effect.gen(function* () {
      const output = yield* execGitCommand(["branch", "--list"]);
      return output
        .trim()
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => line.replace(/^\* /, "").trim())
        .map((line) => line.trim());
    });

    const isWorkingDirectoryClean = Effect.gen(function* () {
      const status = yield* execGitCommand(["status", "--porcelain"]);
      return status.trim().length === 0;
    });

    function doesBranchExist(branch: string) {
      return listBranches.pipe(
        Effect.map((branches) => branches.includes(branch)),
      );
    }

    function createBranch(branch: string, base: string = config.branch.default) {
      return execGitCommandIfNotDry(["branch", branch, base]);
    }

    function checkoutBranch(branch: string) {
      return Effect.gen(function* () {
        const result = yield* execGitCommand(["checkout", branch]);
        return result;
      });
    }

    function stageChanges(files: readonly string[]) {
      return Effect.gen(function* () {
        if (files.length === 0) {
          return yield* Effect.fail(new Error("No files to stage."));
        }

        return yield* execGitCommand(["add", ...files]);
      });
    }

    function writeCommit(message: string) {
      return Effect.gen(function* () {
        return yield* execGitCommandIfNotDry(["commit", "-m", message]);
      });
    }

    function pushChanges(branch: string, remote: string = "origin") {
      return Effect.gen(function* () {
        const result = yield* execGitCommandIfNotDry(["push", remote, branch]);
        return result;
      });
    }

    return {
      branches: {
        list: listBranches,
        exists: doesBranchExist,
        create: createBranch,
        checkout: checkoutBranch,
      },
      commit: {
        stage: stageChanges,
        write: writeCommit,
        push: pushChanges,
      },
      isWithinRepository,
      isWorkingDirectoryClean,
    } as const;
  }),
  dependencies: [
    NodeCommandExecutor.layer,
  ],
}) {
  static mockLayer(mockExecutor: CommandExecutor.CommandExecutor) {
    return Layer.succeed(CommandExecutor.CommandExecutor, mockExecutor);
  }
}
