import process from "node:process";

import { formatUnknownError } from "../shared/errors";
import { logger, runEffect, runIfNotDryEffect } from "../shared/utils";
import { Cause, Context, Data, Effect, Exit, Layer } from "effect";
import farver from "farver";
import semver from "semver";

const DEFAULT_BRANCH_RE = /^refs\/remotes\/origin\/(.+)$/;
const CHECKOUT_BRANCH_RE = /Switched to (?:a new )?branch '(.+)'/;
const COMMIT_HASH_RE = /^[0-9a-f]{7,40}$/i;

export class GitError extends Data.TaggedError("GitError")<{
  operation: string;
  message: string;
  stderr?: string;
}> {}

export interface GitServiceShape {
  readonly isWorkingDirectoryClean: (
    workspaceRoot: string,
  ) => Effect.Effect<boolean, unknown, unknown>;
  readonly doesRemoteBranchExist: (
    branch: string,
    workspaceRoot: string,
  ) => Effect.Effect<boolean, never, unknown>;
  readonly doesBranchExist: (
    branch: string,
    workspaceRoot: string,
  ) => Effect.Effect<boolean, never, unknown>;
  readonly getDefaultBranch: (
    workspaceRoot: string,
  ) => Effect.Effect<string, never, unknown>;
  readonly getCurrentBranch: (
    workspaceRoot: string,
  ) => Effect.Effect<string, unknown, unknown>;
  readonly getAvailableBranches: (
    workspaceRoot: string,
  ) => Effect.Effect<string[], unknown, unknown>;
  readonly createBranch: (
    branch: string,
    base: string,
    workspaceRoot: string,
  ) => Effect.Effect<void, unknown, unknown>;
  readonly checkoutBranch: (
    branch: string,
    workspaceRoot: string,
  ) => Effect.Effect<boolean, unknown, unknown>;
  readonly pullLatestChanges: (
    branch: string,
    workspaceRoot: string,
  ) => Effect.Effect<boolean, unknown, unknown>;
  readonly rebaseBranch: (
    ontoBranch: string,
    workspaceRoot: string,
  ) => Effect.Effect<void, unknown, unknown>;
  readonly isBranchAheadOfRemote: (
    branch: string,
    workspaceRoot: string,
  ) => Effect.Effect<boolean, unknown, unknown>;
  readonly commitChanges: (
    message: string,
    workspaceRoot: string,
  ) => Effect.Effect<boolean, unknown, unknown>;
  readonly commitPaths: (
    paths: string[],
    message: string,
    workspaceRoot: string,
  ) => Effect.Effect<boolean, unknown, unknown>;
  readonly pushBranch: (
    branch: string,
    workspaceRoot: string,
    options?: { force?: boolean; forceWithLease?: boolean },
  ) => Effect.Effect<boolean, unknown, unknown>;
  readonly readFileFromGit: (
    workspaceRoot: string,
    ref: string,
    filePath: string,
  ) => Effect.Effect<string | null, unknown, unknown>;
  readonly getMostRecentPackageTag: (
    workspaceRoot: string,
    packageName: string,
  ) => Effect.Effect<string | undefined, unknown, unknown>;
  readonly getMostRecentPackageStableTag: (
    workspaceRoot: string,
    packageName: string,
  ) => Effect.Effect<string | undefined, unknown, unknown>;
  readonly getGroupedFilesByCommitSha: (
    workspaceRoot: string,
    from: string,
    to: string,
  ) => Effect.Effect<Map<string, string[]>, unknown, unknown>;
  readonly createAndPushPackageTag: (
    packageName: string,
    version: string,
    workspaceRoot: string,
  ) => Effect.Effect<void, unknown, unknown>;
}

function toGitError(operation: string, error: unknown): GitError {
  const formatted = formatUnknownError(error);
  return new GitError({
    operation,
    message: formatted.message,
    stderr: formatted.stderr,
  });
}

function isMissingGitIdentityError(error: unknown): boolean {
  const formatted = formatUnknownError(error);
  const combined = `${formatted.message}\n${formatted.stderr ?? ""}`;
  return (
    combined.includes("Author identity unknown") ||
    combined.includes("empty ident name") ||
    combined.includes("Please tell me who you are")
  );
}

function isMissingGitPathError(error: unknown): boolean {
  const formatted = formatUnknownError(error);
  const combined = `${formatted.message}\n${formatted.stderr ?? ""}`;
  return (
    combined.includes("exists on disk, but not in") ||
    combined.includes("does not exist in") ||
    combined.includes("Path '") ||
    (combined.includes("path '") && combined.includes("does not exist"))
  );
}

export class GitService extends Context.Service<GitService, GitServiceShape>()(
  "@ucdjs/release-scripts/GitService",
) {}

// oxlint-disable-next-line require-yield
export const makeGitService = Effect.fn("makeGitService")(function* () {
  const ensureLocalGitIdentity = Effect.fn("ensureLocalGitIdentity")(function* (
    workspaceRoot: string,
  ) {
    try {
      const actor = process.env.GITHUB_ACTOR?.trim();
      const name =
        process.env.GIT_AUTHOR_NAME?.trim() ||
        process.env.GIT_COMMITTER_NAME?.trim() ||
        actor ||
        "github-actions[bot]";

      const email =
        process.env.GIT_AUTHOR_EMAIL?.trim() ||
        process.env.GIT_COMMITTER_EMAIL?.trim() ||
        (actor
          ? `${actor}@users.noreply.github.com`
          : "github-actions[bot]@users.noreply.github.com");

      logger.warn(
        "Git author identity missing. Configuring repository-local git identity for this run.",
      );

      yield* runIfNotDryEffect("git", ["config", "user.name", name], {
        nodeOptions: { cwd: workspaceRoot, stdio: "pipe" },
      });
      yield* runIfNotDryEffect("git", ["config", "user.email", email], {
        nodeOptions: { cwd: workspaceRoot, stdio: "pipe" },
      });

      logger.info(`Configured git identity: ${farver.dim(`${name} <${email}>`)}`);
    } catch (error) {
      return yield* Effect.fail(toGitError("ensureLocalGitIdentity", error));
    }
  });

  const commitWithRetryOnMissingIdentity = Effect.fn(
    "commitWithRetryOnMissingIdentity",
  )(function* (message: string, workspaceRoot: string, operation: "commitChanges" | "commitPaths") {
    const runCommit = () =>
      runIfNotDryEffect("git", ["commit", "-m", message], {
        nodeOptions: { cwd: workspaceRoot, stdio: "pipe" },
      });

    const firstExit = yield* Effect.exit(runCommit());
    if (Exit.isSuccess(firstExit)) {
      return;
    }

    const firstError = Cause.squash(firstExit.cause);
    if (!isMissingGitIdentityError(firstError)) {
      return yield* Effect.fail(toGitError(operation, firstError));
    }

    yield* ensureLocalGitIdentity(workspaceRoot);

    const retryExit = yield* Effect.exit(runCommit());
    if (Exit.isSuccess(retryExit)) {
      return;
    }

    return yield* Effect.fail(toGitError(operation, Cause.squash(retryExit.cause)));
  });

  const isWorkingDirectoryClean: GitServiceShape["isWorkingDirectoryClean"] = Effect.fn(
    "isWorkingDirectoryClean",
  )(function* (workspaceRoot) {
    const exit = yield* Effect.exit(
      runEffect("git", ["status", "--porcelain"], {
        nodeOptions: { cwd: workspaceRoot, stdio: "pipe" },
      }),
    );
    if (Exit.isFailure(exit)) {
      return yield* Effect.fail(toGitError("isWorkingDirectoryClean", Cause.squash(exit.cause)));
    }
    return exit.value.stdout.trim() === "";
  });

  const getCurrentBranch: GitServiceShape["getCurrentBranch"] = Effect.fn(
    "getCurrentBranch",
  )(function* (workspaceRoot) {
    const exit = yield* Effect.exit(
      runEffect("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
        nodeOptions: { cwd: workspaceRoot, stdio: "pipe" },
      }),
    );
    if (Exit.isFailure(exit)) {
      return yield* Effect.fail(toGitError("getCurrentBranch", Cause.squash(exit.cause)));
    }
    return exit.value.stdout.trim();
  });

  const checkoutBranch: GitServiceShape["checkoutBranch"] = Effect.fn(
    "checkoutBranch",
  )(function* (branch, workspaceRoot) {
    logger.info(`Switching to branch: ${farver.green(branch)}`);
    const exit = yield* Effect.exit(
      runEffect("git", ["checkout", branch], {
        nodeOptions: { cwd: workspaceRoot, stdio: "pipe" },
      }),
    );

    if (Exit.isFailure(exit)) {
      const gitError = toGitError("checkoutBranch", Cause.squash(exit.cause));
      logger.error(`Git checkout failed: ${gitError.message}`);
      if (gitError.stderr) {
        logger.error(`Git stderr: ${gitError.stderr}`);
      }

      const branchesExit = yield* Effect.exit(
        runEffect("git", ["branch", "-a"], {
          nodeOptions: { cwd: workspaceRoot, stdio: "pipe" },
        }),
      );
      if (Exit.isSuccess(branchesExit)) {
        logger.verbose(`Available branches:\n${branchesExit.value.stdout}`);
      }

      return yield* Effect.fail(gitError);
    }

    const output = exit.value.stderr.trim();
    const match = output.match(CHECKOUT_BRANCH_RE);
    if (match && match[1] === branch) {
      logger.info(`Successfully switched to branch: ${farver.green(branch)}`);
      return true;
    }

    logger.warn(`Unexpected git checkout output: ${output}`);
    return false;
  });

  const commitPaths: GitServiceShape["commitPaths"] = Effect.fn("commitPaths")(function* (
    paths,
    message,
    workspaceRoot,
    ) {
    try {
      if (paths.length === 0) {
        return false;
      }

      yield* runEffect("git", ["add", "--", ...paths], {
        nodeOptions: { cwd: workspaceRoot, stdio: "pipe" },
      });

      const staged = yield* runEffect("git", ["diff", "--cached", "--name-only"], {
        nodeOptions: { cwd: workspaceRoot, stdio: "pipe" },
      });

      if (staged.stdout.trim() === "") {
        return false;
      }

      logger.info(`Committing changes: ${farver.dim(message)}`);
      yield* commitWithRetryOnMissingIdentity(message, workspaceRoot, "commitPaths");

      return true;
    } catch (error) {
      const gitError = toGitError("commitPaths", error);
      logger.error(`Git commit failed: ${gitError.message}`);
      if (gitError.stderr) {
        logger.error(`Git stderr: ${gitError.stderr}`);
      }
      return yield* Effect.fail(gitError);
    }
  });

  const pushBranch: GitServiceShape["pushBranch"] = Effect.fn("pushBranch")(function* (
    branch,
    workspaceRoot,
    options,
  ) {
    try {
      const args = ["push", "origin", branch];

      if (options?.forceWithLease) {
        const fetchExit = yield* Effect.exit(
          runEffect("git", ["fetch", "origin", branch], {
            nodeOptions: { cwd: workspaceRoot, stdio: "pipe" },
          }),
        );
        if (Exit.isFailure(fetchExit)) {
          const fetchError = toGitError("pushBranch.fetch", Cause.squash(fetchExit.cause));
          const isMissingRemoteRef =
            fetchError.stderr?.includes("couldn't find remote ref") ||
            fetchError.message.includes("couldn't find remote ref");
          if (!isMissingRemoteRef) {
            return yield* Effect.fail(fetchError);
          }
          logger.verbose(
            `Remote branch origin/${branch} does not exist yet, falling back to regular push without --force-with-lease.`,
          );
        } else {
          args.push("--force-with-lease");
          logger.info(`Pushing branch: ${farver.green(branch)} ${farver.dim("(with lease)")}`);
        }
      } else if (options?.force) {
        args.push("--force");
        logger.info(`Force pushing branch: ${farver.green(branch)}`);
      } else {
        logger.info(`Pushing branch: ${farver.green(branch)}`);
      }

      yield* runIfNotDryEffect("git", args, {
        nodeOptions: { cwd: workspaceRoot, stdio: "pipe" },
      });

      return true;
    } catch (error) {
      return yield* Effect.fail(toGitError("pushBranch", error));
    }
  });

  const getMostRecentPackageStableTag: GitServiceShape["getMostRecentPackageStableTag"] = Effect.fn(
    "getMostRecentPackageStableTag",
  )(function* (workspaceRoot, packageName) {
    try {
      const { stdout } = yield* runEffect("git", ["tag", "--list", `${packageName}@*`], {
        nodeOptions: { cwd: workspaceRoot, stdio: "pipe" },
      });

      const tags = stdout
        .split("\n")
        .map((tag) => tag.trim())
        .filter((tag) => Boolean(tag) && semver.valid(tag.slice(tag.lastIndexOf("@") + 1)))
        .toSorted((a, b) => {
          const va = a.slice(a.lastIndexOf("@") + 1);
          const vb = b.slice(b.lastIndexOf("@") + 1);
          return semver.rcompare(va, vb);
        });

      for (const tag of tags) {
        const atIndex = tag.lastIndexOf("@");
        if (atIndex === -1) {
          continue;
        }

        const version = tag.slice(atIndex + 1);
        if (semver.valid(version) && semver.prerelease(version) == null) {
          return tag;
        }
      }

      return undefined;
    } catch (error) {
      return yield* Effect.fail(toGitError("getMostRecentPackageStableTag", error));
    }
  });

  const createPackageTag = Effect.fn("createPackageTag")(function* (
    packageName: string,
    version: string,
    workspaceRoot: string,
  ) {
    const tagName = `${packageName}@${version}`;
    try {
      const existingTagResult = yield* runEffect("git", ["tag", "--list", tagName], {
        nodeOptions: { cwd: workspaceRoot, stdio: "pipe" },
      });
      if (existingTagResult.stdout.trim() === tagName) {
        const [tagCommit, headCommit] = yield* Effect.all([
          runEffect("git", ["rev-list", "-n1", tagName], {
            nodeOptions: { cwd: workspaceRoot, stdio: "pipe" },
          }),
          runEffect("git", ["rev-parse", "HEAD"], {
            nodeOptions: { cwd: workspaceRoot, stdio: "pipe" },
          }),
        ]);
        if (tagCommit.stdout.trim() === headCommit.stdout.trim()) {
          logger.verbose(`Tag ${farver.green(tagName)} already exists and points to HEAD, skipping creation`);
          return;
        }
        logger.verbose(`Tag ${farver.green(tagName)} exists but points to a different commit — proceeding`);
      }

      logger.info(`Creating tag: ${farver.green(tagName)}`);
      yield* runIfNotDryEffect("git", ["tag", tagName], {
        nodeOptions: { cwd: workspaceRoot, stdio: "pipe" },
      });
    } catch (error) {
      return yield* Effect.fail(toGitError("createPackageTag", error));
    }
  });

  const pushTag = Effect.fn("pushTag")(function* (tagName: string, workspaceRoot: string) {
    try {
      logger.info(`Pushing tag: ${farver.green(tagName)}`);
      yield* runIfNotDryEffect("git", ["push", "origin", tagName], {
        nodeOptions: { cwd: workspaceRoot, stdio: "pipe" },
      });
    } catch (error) {
      return yield* Effect.fail(toGitError("pushTag", error));
    }
  });

  const doesRemoteBranchExist: GitServiceShape["doesRemoteBranchExist"] = Effect.fn(
    "doesRemoteBranchExist",
  )(function* (branch, workspaceRoot) {
    const exit = yield* Effect.exit(
      runEffect("git", ["ls-remote", "--exit-code", "--heads", "origin", branch], {
        nodeOptions: { cwd: workspaceRoot, stdio: "pipe" },
      }),
    );
    if (Exit.isFailure(exit)) {
      logger.verbose(
        `Remote branch "origin/${branch}" does not exist: ${formatUnknownError(Cause.squash(exit.cause)).message}`,
      );
      return false;
    }
    return true;
  });

  const doesBranchExist: GitServiceShape["doesBranchExist"] = Effect.fn("doesBranchExist")(function* (
    branch,
    workspaceRoot,
  ) {
    const exit = yield* Effect.exit(
      runEffect("git", ["rev-parse", "--verify", branch], {
        nodeOptions: { cwd: workspaceRoot, stdio: "pipe" },
      }),
    );
    if (Exit.isFailure(exit)) {
      logger.verbose(
        `Failed to verify branch "${branch}": ${formatUnknownError(Cause.squash(exit.cause)).message}`,
      );
      return false;
    }
    return true;
  });

  const createBranch: GitServiceShape["createBranch"] = Effect.fn("createBranch")(function* (
    branch,
    base,
    workspaceRoot,
  ) {
    logger.info(`Creating branch: ${farver.green(branch)} from ${farver.cyan(base)}`);
    const exit = yield* Effect.exit(
      runIfNotDryEffect("git", ["branch", branch, base], {
        nodeOptions: { cwd: workspaceRoot, stdio: "pipe" },
      }),
    );
    if (Exit.isFailure(exit)) {
      return yield* Effect.fail(toGitError("createBranch", Cause.squash(exit.cause)));
    }
  });

  const pullLatestChanges: GitServiceShape["pullLatestChanges"] = Effect.fn(
    "pullLatestChanges",
  )(function* (branch, workspaceRoot) {
    try {
      yield* runEffect("git", ["pull", "origin", branch], {
        nodeOptions: { cwd: workspaceRoot, stdio: "pipe" },
      });
      return true;
    } catch (error) {
      return yield* Effect.fail(toGitError("pullLatestChanges", error));
    }
  });

  const rebaseBranch: GitServiceShape["rebaseBranch"] = Effect.fn("rebaseBranch")(function* (
    ontoBranch,
    workspaceRoot,
  ) {
    try {
      logger.info(`Rebasing onto: ${farver.cyan(ontoBranch)}`);
      yield* runIfNotDryEffect("git", ["rebase", ontoBranch], {
        nodeOptions: { cwd: workspaceRoot, stdio: "pipe" },
      });
    } catch (error) {
      const abortExit = yield* Effect.exit(
        runEffect("git", ["rebase", "--abort"], {
          nodeOptions: { cwd: workspaceRoot, stdio: "pipe" },
        }),
      );
      if (Exit.isSuccess(abortExit)) {
        logger.verbose("Aborted in-progress rebase after failure");
      }
      return yield* Effect.fail(toGitError("rebaseBranch", error));
    }
  });

  const isBranchAheadOfRemote: GitServiceShape["isBranchAheadOfRemote"] = Effect.fn(
    "isBranchAheadOfRemote",
  )(function* (branch, workspaceRoot) {
    try {
      const result = yield* runEffect("git", ["rev-list", `origin/${branch}..${branch}`, "--count"], {
        nodeOptions: { cwd: workspaceRoot, stdio: "pipe" },
      });
      return Number.parseInt(result.stdout.trim(), 10) > 0;
    } catch (error) {
      logger.verbose(
        `Failed to compare branch "${branch}" with remote: ${formatUnknownError(error).message}`,
      );
      return true;
    }
  });

  const commitChanges: GitServiceShape["commitChanges"] = Effect.fn("commitChanges")(function* (
    message,
    workspaceRoot,
  ) {
    try {
      yield* runEffect("git", ["add", "-u"], {
        nodeOptions: { cwd: workspaceRoot, stdio: "pipe" },
      });
      const staged = yield* runEffect("git", ["diff", "--cached", "--name-only"], {
        nodeOptions: { cwd: workspaceRoot, stdio: "pipe" },
      });
      if (staged.stdout.trim() === "") {
        return false;
      }

      logger.info(`Committing changes: ${farver.dim(message)}`);
      yield* commitWithRetryOnMissingIdentity(message, workspaceRoot, "commitChanges");

      return true;
    } catch (error) {
      const gitError = toGitError("commitChanges", error);
      logger.error(`Git commit failed: ${gitError.message}`);
      if (gitError.stderr) {
        logger.error(`Git stderr: ${gitError.stderr}`);
      }
      return yield* Effect.fail(gitError);
    }
  });

  const getDefaultBranch: GitServiceShape["getDefaultBranch"] = Effect.fn("getDefaultBranch")(function* (
    workspaceRoot,
  ) {
    const exit = yield* Effect.exit(
      runEffect("git", ["symbolic-ref", "refs/remotes/origin/HEAD"], {
        nodeOptions: { cwd: workspaceRoot, stdio: "pipe" },
      }),
    );
    if (Exit.isFailure(exit)) {
      logger.verbose(
        `Failed to detect default branch from origin/HEAD: ${formatUnknownError(Cause.squash(exit.cause)).message}`,
      );
      return "main";
    }

    const ref = exit.value.stdout.trim();
    const match = ref.match(DEFAULT_BRANCH_RE);
    if (match && match[1]) {
      return match[1];
    }

    return "main";
  });

  const getAvailableBranches: GitServiceShape["getAvailableBranches"] = Effect.fn(
    "getAvailableBranches",
  )(function* (workspaceRoot) {
    const exit = yield* Effect.exit(
      runEffect("git", ["branch", "--list"], {
        nodeOptions: { cwd: workspaceRoot, stdio: "pipe" },
      }),
    );
    if (Exit.isFailure(exit)) {
      return yield* Effect.fail(toGitError("getAvailableBranches", Cause.squash(exit.cause)));
    }

    const branches = exit.value.stdout
      .split("\n")
      .map((line) => line.replace("*", "").trim())
      .filter((line) => line.length > 0);
    return branches;
  });

  const readFileFromGit: GitServiceShape["readFileFromGit"] = Effect.fn("readFileFromGit")(function* (
    workspaceRoot,
    ref,
    filePath,
  ) {
    const exit = yield* Effect.exit(
      runEffect("git", ["show", `${ref}:${filePath}`], {
        nodeOptions: { cwd: workspaceRoot, stdio: "pipe" },
      }),
    );
    if (Exit.isFailure(exit)) {
      const error = Cause.squash(exit.cause);
      if (isMissingGitPathError(error)) {
        logger.verbose(
          `File ${filePath} is missing from ${ref}; treating as absent content rather than a hard failure.`,
        );
        return null;
      }
      return yield* Effect.fail(toGitError("readFileFromGit", error));
    }

    return exit.value.stdout;
  });

  const getMostRecentPackageTag: GitServiceShape["getMostRecentPackageTag"] = Effect.fn(
    "getMostRecentPackageTag",
  )(function* (workspaceRoot, packageName) {
    try {
      const { stdout } = yield* runEffect("git", ["tag", "--list", `${packageName}@*`], {
        nodeOptions: { cwd: workspaceRoot, stdio: "pipe" },
      });

      const tags = stdout.split("\n").map((tag) => tag.trim()).filter(Boolean);
      if (tags.length === 0) {
        return undefined;
      }

      const sorted = tags
        .filter((t) => semver.valid(t.slice(t.lastIndexOf("@") + 1)))
        .toSorted((a, b) => {
          const va = a.slice(a.lastIndexOf("@") + 1);
          const vb = b.slice(b.lastIndexOf("@") + 1);
          return semver.rcompare(va, vb);
        });
      return sorted[0];
    } catch (error) {
      return yield* Effect.fail(toGitError("getMostRecentPackageTag", error));
    }
  });

  const getGroupedFilesByCommitSha: GitServiceShape["getGroupedFilesByCommitSha"] = Effect.fn(
    "getGroupedFilesByCommitSha",
  )(function* (workspaceRoot, from, to) {
    const commitsMap = new Map<string, string[]>();
    try {
      const { stdout } = yield* runEffect("git", ["log", "--name-only", "--format=%h", `${from}^..${to}`], {
        nodeOptions: { cwd: workspaceRoot, stdio: "pipe" },
      });

      const lines = stdout.trim().split("\n").filter((line) => line.trim() !== "");
      let currentSha: string | null = null;

      for (const line of lines) {
        const trimmedLine = line.trim();
        if (COMMIT_HASH_RE.test(trimmedLine)) {
          currentSha = trimmedLine;
          commitsMap.set(currentSha, []);
          continue;
        }
        if (currentSha === null) {
          continue;
        }
        commitsMap.get(currentSha)!.push(trimmedLine);
      }

      return commitsMap;
    } catch (error) {
      return yield* Effect.fail(toGitError("getGroupedFilesByCommitSha", error));
    }
  });

  const createAndPushPackageTag: GitServiceShape["createAndPushPackageTag"] = Effect.fn(
    "createAndPushPackageTag",
  )(function* (packageName, version, workspaceRoot) {
    yield* createPackageTag(packageName, version, workspaceRoot);
    const tagName = `${packageName}@${version}`;
    return yield* pushTag(tagName, workspaceRoot);
  });

  return GitService.of({
    isWorkingDirectoryClean,
    doesRemoteBranchExist,
    doesBranchExist,
    getDefaultBranch,
    getAvailableBranches,
    getCurrentBranch,
    checkoutBranch,
    pullLatestChanges,
    rebaseBranch,
    isBranchAheadOfRemote,
    pushBranch,
    readFileFromGit,
    getMostRecentPackageStableTag,
    createAndPushPackageTag,
    createBranch,
    commitPaths,
    commitChanges,
    getMostRecentPackageTag,
    getGroupedFilesByCommitSha,
  });
});

export const GitServiceLive = Layer.effect(GitService, makeGitService());

export const isWorkingDirectoryClean = Effect.fn("isWorkingDirectoryClean")(function* (workspaceRoot: string) {
  const git = yield* GitService;
  return yield* git.isWorkingDirectoryClean(workspaceRoot);
});

export const getCurrentBranch = Effect.fn("getCurrentBranch")(function* (workspaceRoot: string) {
  const git = yield* GitService;
  return yield* git.getCurrentBranch(workspaceRoot);
});

export const checkoutBranch = Effect.fn("checkoutBranch")(function* (branch: string, workspaceRoot: string) {
  const git = yield* GitService;
  return yield* git.checkoutBranch(branch, workspaceRoot);
});

export const commitPaths = Effect.fn("commitPaths")(function* (
  paths: string[],
  message: string,
  workspaceRoot: string,
) {
  const git = yield* GitService;
  return yield* git.commitPaths(paths, message, workspaceRoot);
});

export const pushBranch = Effect.fn("pushBranch")(function* (
  branch: string,
  workspaceRoot: string,
  options?: { force?: boolean; forceWithLease?: boolean },
) {
  const git = yield* GitService;
  return yield* git.pushBranch(branch, workspaceRoot, options);
});

export const getMostRecentPackageStableTag = Effect.fn("getMostRecentPackageStableTag")(function* (
  workspaceRoot: string,
  packageName: string,
) {
  const git = yield* GitService;
  return yield* git.getMostRecentPackageStableTag(workspaceRoot, packageName);
});

export const doesRemoteBranchExist = Effect.fn("doesRemoteBranchExist")(function* (
  branch: string,
  workspaceRoot: string,
) {
  const git = yield* GitService;
  return yield* git.doesRemoteBranchExist(branch, workspaceRoot);
});

export const doesBranchExist = Effect.fn("doesBranchExist")(function* (
  branch: string,
  workspaceRoot: string,
) {
  const git = yield* GitService;
  return yield* git.doesBranchExist(branch, workspaceRoot);
});

export const getDefaultBranch = Effect.fn("getDefaultBranch")(function* (workspaceRoot: string) {
  const git = yield* GitService;
  return yield* git.getDefaultBranch(workspaceRoot);
});

export const getAvailableBranches = Effect.fn("getAvailableBranches")(function* (workspaceRoot: string) {
  const git = yield* GitService;
  return yield* git.getAvailableBranches(workspaceRoot);
});

export const createBranch = Effect.fn("createBranch")(function* (
  branch: string,
  base: string,
  workspaceRoot: string,
) {
  const git = yield* GitService;
  return yield* git.createBranch(branch, base, workspaceRoot);
});

export const pullLatestChanges = Effect.fn("pullLatestChanges")(function* (
  branch: string,
  workspaceRoot: string,
) {
  const git = yield* GitService;
  return yield* git.pullLatestChanges(branch, workspaceRoot);
});

export const rebaseBranch = Effect.fn("rebaseBranch")(function* (
  ontoBranch: string,
  workspaceRoot: string,
) {
  const git = yield* GitService;
  return yield* git.rebaseBranch(ontoBranch, workspaceRoot);
});

export const isBranchAheadOfRemote = Effect.fn("isBranchAheadOfRemote")(function* (
  branch: string,
  workspaceRoot: string,
) {
  const git = yield* GitService;
  return yield* git.isBranchAheadOfRemote(branch, workspaceRoot);
});

export const commitChanges = Effect.fn("commitChanges")(function* (
  message: string,
  workspaceRoot: string,
) {
  const git = yield* GitService;
  return yield* git.commitChanges(message, workspaceRoot);
});

export const readFileFromGit = Effect.fn("readFileFromGit")(function* (
  workspaceRoot: string,
  ref: string,
  filePath: string,
) {
  const git = yield* GitService;
  return yield* git.readFileFromGit(workspaceRoot, ref, filePath);
});

export const getMostRecentPackageTag = Effect.fn("getMostRecentPackageTag")(function* (
  workspaceRoot: string,
  packageName: string,
) {
  const git = yield* GitService;
  return yield* git.getMostRecentPackageTag(workspaceRoot, packageName);
});

export const getGroupedFilesByCommitSha = Effect.fn("getGroupedFilesByCommitSha")(function* (
  workspaceRoot: string,
  from: string,
  to: string,
) {
  const git = yield* GitService;
  return yield* git.getGroupedFilesByCommitSha(workspaceRoot, from, to);
});

export const createAndPushPackageTag = Effect.fn("createAndPushPackageTag")(function* (
  packageName: string,
  version: string,
  workspaceRoot: string,
) {
  const git = yield* GitService;
  return yield* git.createAndPushPackageTag(packageName, version, workspaceRoot);
});
