import { Command, CommandExecutor } from "@effect/platform";
import { NodeCommandExecutor } from "@effect/platform-node";
import * as CommitParser from "commit-parser";
import { Effect } from "effect";
import { ExternalCommitParserError, GitCommandError, TagError } from "../errors";
import { ReleaseScriptsOptions } from "../options";

export class GitService extends Effect.Service<GitService>()("@ucdjs/release-scripts/GitService", {
  effect: Effect.gen(function* () {
    const executor = yield* CommandExecutor.CommandExecutor;
    const config = yield* ReleaseScriptsOptions;

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

    const getBranch = Effect.gen(function* () {
      const output = yield* execGitCommand(["rev-parse", "--abbrev-ref", "HEAD"]);
      return output.trim();
    });

    function checkoutBranch(branch: string) {
      return execGitCommand(["checkout", branch]);
    }

    function rebaseBranch(onto: string) {
      return execGitCommandIfNotDry(["rebase", onto]);
    }

    function stageChanges(files: readonly string[]) {
      return Effect.gen(function* () {
        if (files.length === 0) {
          return yield* Effect.fail(new Error("No files to stage."));
        }

        return yield* execGitCommandIfNotDry(["add", ...files]);
      });
    }

    function writeCommit(message: string) {
      return execGitCommandIfNotDry(["commit", "-m", message]);
    }

    function pushChanges(branch: string, remote: string = "origin") {
      return execGitCommandIfNotDry(["push", remote, branch]);
    }

    function forcePushChanges(branch: string, remote: string = "origin") {
      return execGitCommandIfNotDry(["push", "--force-with-lease", remote, branch]);
    }

    function readFile(filePath: string, ref: string = "HEAD") {
      return execGitCommand(["show", `${ref}:${filePath}`]);
    }

    function getMostRecentPackageTag(packageName: string) {
      return execGitCommand(["tag", "--list", "--sort=-version:refname", `${packageName}@*`]).pipe(
        Effect.map((tags) => {
          const tagList = tags
            .trim()
            .split("\n")
            .map((tag) => tag.trim())
            .filter((tag) => tag.length > 0);

          return tagList[0] || null;
        }),
        Effect.flatMap((tag) => {
          if (tag === null) {
            return Effect.succeed(null);
          }
          return execGitCommand(["rev-parse", tag]).pipe(
            Effect.map((sha) => ({
              name: tag,
              sha: sha.trim(),
            })),
          );
        }),
      );
    }

    function createTag(name: string, message?: string) {
      const args = message
        ? ["tag", "-a", name, "-m", message]
        : ["tag", name];

      return execGitCommandIfNotDry(args).pipe(
        Effect.mapError((err) => new TagError({
          message: `Failed to create tag "${name}"`,
          tagName: name,
          operation: "create",
          cause: err,
        })),
      );
    }

    function pushTag(name: string, remote: string = "origin") {
      return execGitCommandIfNotDry(["push", remote, name]).pipe(
        Effect.mapError((err) => new TagError({
          message: `Failed to push tag "${name}" to ${remote}`,
          tagName: name,
          operation: "push",
          cause: err,
        })),
      );
    }

    function getCommits(options?: {
      from?: string;
      to?: string;
      folder?: string;
    }) {
      return Effect.tryPromise({
        try: async () => CommitParser.getCommits({
          from: options?.from,
          to: options?.to,
          folder: options?.folder,
          cwd: config.workspaceRoot,
        }),
        catch: (e) => new ExternalCommitParserError({
          message: `commit-parser getCommits`,
          cause: e instanceof Error ? e.message : String(e),
        }),
      });
    }

    function filesChangesBetweenRefs(from: string, to: string) {
      const commitsMap = new Map<string, string[]>();

      return execGitCommand(["log", "--name-only", "--format=%H", `${from}^..${to}`]).pipe(
        Effect.map((output) => {
          const lines = output.trim().split("\n").filter((line) => line.trim() !== "");

          let currentSha: string | null = null;
          const HASH_REGEX = /^[0-9a-f]{40}$/i;

          for (const line of lines) {
            const trimmedLine = line.trim();

            // Found a new commit hash
            if (HASH_REGEX.test(trimmedLine)) {
              currentSha = trimmedLine;
              commitsMap.set(currentSha, []);

              continue;
            }

            if (currentSha === null) {
              // Malformed output: file path found before any commit hash
              continue;
            }

            // Found a file path, and we have a current hash to assign it to
            // Note: In case of merge commits, an empty line might appear which is already filtered.
            // If the line is NOT a hash, it must be a file path.

            // The file path is added to the array associated with the most recent hash.
            commitsMap.get(currentSha)!.push(trimmedLine);
          }

          return commitsMap;
        }),
      );
    }

    const assertWorkspaceReady = Effect.gen(function* () {
      const withinRepo = yield* isWithinRepository;
      if (!withinRepo) {
        return yield* Effect.fail(new Error("Not within a Git repository."));
      }

      const clean = yield* isWorkingDirectoryClean;
      if (!clean) {
        return yield* Effect.fail(new Error("Working directory is not clean."));
      }

      return true;
    });

    return {
      branches: {
        list: listBranches,
        exists: doesBranchExist,
        create: createBranch,
        checkout: checkoutBranch,
        rebase: rebaseBranch,
        get: getBranch,
      },
      commits: {
        stage: stageChanges,
        write: writeCommit,
        push: pushChanges,
        forcePush: forcePushChanges,
        get: getCommits,
        filesChangesBetweenRefs,
      },
      tags: {
        mostRecentForPackage: getMostRecentPackageTag,
        create: createTag,
        push: pushTag,
      },
      workspace: {
        readFile,
        isWithinRepository,
        isWorkingDirectoryClean,
        assertWorkspaceReady,
      },
    } as const;
  }),
  dependencies: [
    NodeCommandExecutor.layer,
  ],
}) {}
