import {
  exitWithError,
  logger,
  run,
  runIfNotDry,
} from "#shared/utils";
import farver from "farver";
import type { GitError, GitOperations } from "#core/types";
import { err, ok } from "#types/result";

/**
 * Check if the working directory is clean (no uncommitted changes)
 * @param {string} workspaceRoot - The root directory of the workspace
 * @returns {Promise<boolean>} A Promise resolving to true if clean, false otherwise
 */
export async function isWorkingDirectoryClean(
  workspaceRoot: string,
): Promise<boolean> {
  try {
    const result = await run("git", ["status", "--porcelain"], {
      nodeOptions: {
        cwd: workspaceRoot,
        stdio: "pipe",
      },
    });

    if (result.stdout.trim() !== "") {
      return false;
    }

    return true;
  } catch (err: any) {
    logger.error("Error checking git status:", err);
    return false;
  }
}

type GitOperationOverrides = Partial<Record<keyof GitOperations, (...args: unknown[]) => Promise<unknown>>>;

function toGitError(operation: string, error: unknown): GitError {
  const message = error instanceof Error ? error.message : String(error);
  const stderr = typeof error === "object" && error && "stderr" in error
    ? String((error as { stderr?: unknown }).stderr ?? "")
    : undefined;
  return {
    type: "git",
    operation,
    message,
    stderr: stderr?.trim() || undefined,
  };
}

async function wrapGit<T>(operation: string, fn: () => Promise<T>): Promise<ReturnType<typeof ok<T>> | ReturnType<typeof err<GitError>>> {
  try {
    return ok(await fn());
  } catch (error) {
    return err(toGitError(operation, error));
  }
}

export function createGitOperations(overrides: GitOperationOverrides = {}): GitOperations {
  return {
    isWorkingDirectoryClean: (workspaceRoot) => wrapGit("isWorkingDirectoryClean", async () => {
      if (overrides.isWorkingDirectoryClean) {
        return overrides.isWorkingDirectoryClean(workspaceRoot) as Promise<boolean>;
      }
      return isWorkingDirectoryClean(workspaceRoot);
    }),
    doesBranchExist: (branch, workspaceRoot) => wrapGit("doesBranchExist", async () => {
      if (overrides.doesBranchExist) {
        return overrides.doesBranchExist(branch, workspaceRoot) as Promise<boolean>;
      }
      return doesBranchExist(branch, workspaceRoot);
    }),
    getCurrentBranch: (workspaceRoot) => wrapGit("getCurrentBranch", async () => {
      if (overrides.getCurrentBranch) {
        return overrides.getCurrentBranch(workspaceRoot) as Promise<string>;
      }
      return getCurrentBranch(workspaceRoot);
    }),
    checkoutBranch: (branch, workspaceRoot) => wrapGit("checkoutBranch", async () => {
      if (overrides.checkoutBranch) {
        return overrides.checkoutBranch(branch, workspaceRoot) as Promise<boolean>;
      }
      return checkoutBranch(branch, workspaceRoot);
    }),
    createBranch: (branch, base, workspaceRoot) => wrapGit("createBranch", async () => {
      if (overrides.createBranch) {
        await overrides.createBranch(branch, base, workspaceRoot);
        return;
      }
      await createBranch(branch, base, workspaceRoot);
    }),
    pullLatestChanges: (branch, workspaceRoot) => wrapGit("pullLatestChanges", async () => {
      if (overrides.pullLatestChanges) {
        return overrides.pullLatestChanges(branch, workspaceRoot) as Promise<boolean>;
      }
      return pullLatestChanges(branch, workspaceRoot);
    }),
    rebaseBranch: (ontoBranch, workspaceRoot) => wrapGit("rebaseBranch", async () => {
      if (overrides.rebaseBranch) {
        await overrides.rebaseBranch(ontoBranch, workspaceRoot);
        return;
      }
      await rebaseBranch(ontoBranch, workspaceRoot);
    }),
    isBranchAheadOfRemote: (branch, workspaceRoot) => wrapGit("isBranchAheadOfRemote", async () => {
      if (overrides.isBranchAheadOfRemote) {
        return overrides.isBranchAheadOfRemote(branch, workspaceRoot) as Promise<boolean>;
      }
      return isBranchAheadOfRemote(branch, workspaceRoot);
    }),
    commitChanges: (message, workspaceRoot) => wrapGit("commitChanges", async () => {
      if (overrides.commitChanges) {
        return overrides.commitChanges(message, workspaceRoot) as Promise<boolean>;
      }
      return commitChanges(message, workspaceRoot);
    }),
    pushBranch: (branch, workspaceRoot, options) => wrapGit("pushBranch", async () => {
      if (overrides.pushBranch) {
        return overrides.pushBranch(branch, workspaceRoot, options) as Promise<boolean>;
      }
      return pushBranch(branch, workspaceRoot, options);
    }),
    readFileFromGit: (workspaceRoot, ref, filePath) => wrapGit("readFileFromGit", async () => {
      if (overrides.readFileFromGit) {
        return overrides.readFileFromGit(workspaceRoot, ref, filePath) as Promise<string | null>;
      }
      return readFileFromGit(workspaceRoot, ref, filePath);
    }),
    getMostRecentPackageTag: (workspaceRoot, packageName) => wrapGit("getMostRecentPackageTag", async () => {
      if (overrides.getMostRecentPackageTag) {
        return overrides.getMostRecentPackageTag(workspaceRoot, packageName) as Promise<string | undefined>;
      }
      return getMostRecentPackageTag(workspaceRoot, packageName);
    }),
  };
}

/**
 * Check if a git branch exists locally
 * @param {string} branch - The branch name to check
 * @param {string} workspaceRoot - The root directory of the workspace
 * @returns {Promise<boolean>} Promise resolving to true if branch exists, false otherwise
 */
export async function doesBranchExist(
  branch: string,
  workspaceRoot: string,
): Promise<boolean> {
  try {
    await run("git", ["rev-parse", "--verify", branch], {
      nodeOptions: {
        cwd: workspaceRoot,
        stdio: "pipe",
      },
    });

    return true;
  } catch {
    return false;
  }
}

/**
 * Retrieves the default branch name from the remote repository.
 * Falls back to "main" if the default branch cannot be determined.
 * @returns {Promise<string>} A Promise resolving to the default branch name as a string.
 */
export async function getDefaultBranch(workspaceRoot: string): Promise<string> {
  try {
    const result = await run("git", ["symbolic-ref", "refs/remotes/origin/HEAD"], {
      nodeOptions: {
        cwd: workspaceRoot,
        stdio: "pipe",
      },
    });

    const ref = result.stdout.trim();
    const match = ref.match(/^refs\/remotes\/origin\/(.+)$/);
    if (match && match[1]) {
      return match[1];
    }

    return "main"; // Fallback
  } catch {
    return "main"; // Fallback
  }
}

/**
 * Retrieves the name of the current branch in the repository.
 * @param {string} workspaceRoot - The root directory of the workspace
 * @returns {Promise<string>} A Promise resolving to the current branch name as a string
 */
export async function getCurrentBranch(
  workspaceRoot: string,
): Promise<string> {
  try {
    const result = await run("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      nodeOptions: {
        cwd: workspaceRoot,
        stdio: "pipe",
      },
    });

    return result.stdout.trim();
  } catch (err) {
    logger.error("Error getting current branch:", err);
    throw err;
  }
}

/**
 * Retrieves the list of available branches in the repository.
 * @param {string} workspaceRoot - The root directory of the workspace
 * @returns {Promise<string[]>} A Promise resolving to an array of branch names
 */
export async function getAvailableBranches(
  workspaceRoot: string,
): Promise<string[]> {
  try {
    const result = await run("git", ["branch", "--list"], {
      nodeOptions: {
        cwd: workspaceRoot,
        stdio: "pipe",
      },
    });

    return result.stdout
      .split("\n")
      .map((line) => line.replace("*", "").trim())
      .filter((line) => line.length > 0);
  } catch (err) {
    logger.error("Error getting available branches:", err);
    throw err;
  }
}

/**
 * Creates a new branch from the specified base branch.
 * @param {string} branch - The name of the new branch to create
 * @param {string} base - The base branch to create the new branch from
 * @param {string} workspaceRoot - The root directory of the workspace
 * @returns {Promise<void>} A Promise that resolves when the branch is created
 */
export async function createBranch(
  branch: string,
  base: string,
  workspaceRoot: string,
): Promise<void> {
  try {
    logger.info(`Creating branch: ${farver.green(branch)} from ${farver.cyan(base)}`);
    await runIfNotDry("git", ["branch", branch, base], {
      nodeOptions: {
        cwd: workspaceRoot,
        stdio: "pipe",
      },
    });
  } catch {
    exitWithError(
      `Failed to create branch: ${branch}`,
      `Make sure the branch doesn't already exist and you have a clean working directory`,
    );
  }
}

export async function checkoutBranch(
  branch: string,
  workspaceRoot: string,
): Promise<boolean> {
  try {
    logger.info(`Switching to branch: ${farver.green(branch)}`);
    const result = await run("git", ["checkout", branch], {
      nodeOptions: {
        cwd: workspaceRoot,
        stdio: "pipe",
      },
    });

    const output = result.stderr.trim();
    const match = output.match(/Switched to branch '(.+)'/);
    if (match && match[1] === branch) {
      logger.info(`Successfully switched to branch: ${farver.green(branch)}`);
      return true;
    }

    return false;
  } catch {
    return false;
  }
}

export async function pullLatestChanges(
  branch: string,
  workspaceRoot: string,
): Promise<boolean> {
  try {
    await run("git", ["pull", "origin", branch], {
      nodeOptions: {
        cwd: workspaceRoot,
        stdio: "pipe",
      },
    });
    return true;
  } catch {
    return false;
  }
}

export async function rebaseBranch(
  ontoBranch: string,
  workspaceRoot: string,
): Promise<boolean> {
  try {
    logger.info(`Rebasing onto: ${farver.cyan(ontoBranch)}`);
    await runIfNotDry("git", ["rebase", ontoBranch], {
      nodeOptions: {
        cwd: workspaceRoot,
        stdio: "pipe",
      },
    });

    return true;
  } catch {
    exitWithError(
      `Failed to rebase onto: ${ontoBranch}`,
      `You may have merge conflicts. Run 'git rebase --abort' to undo the rebase`,
    );
  }
}

export async function isBranchAheadOfRemote(
  branch: string,
  workspaceRoot: string,
): Promise<boolean> {
  try {
    const result = await run("git", ["rev-list", `origin/${branch}..${branch}`, "--count"], {
      nodeOptions: {
        cwd: workspaceRoot,
        stdio: "pipe",
      },
    });

    const commitCount = Number.parseInt(result.stdout.trim(), 10);
    return commitCount > 0;
  } catch {
    // If remote branch doesn't exist, consider it as ahead
    return true;
  }
}

export async function commitChanges(
  message: string,
  workspaceRoot: string,
): Promise<boolean> {
  try {
    // Stage all changes
    await run("git", ["add", "."], {
      nodeOptions: {
        cwd: workspaceRoot,
        stdio: "pipe",
      },
    });

    // Check if there are changes to commit
    const isClean = await isWorkingDirectoryClean(workspaceRoot);
    if (isClean) {
      return false;
    }

    // Commit
    logger.info(`Committing changes: ${farver.dim(message)}`);
    await runIfNotDry("git", ["commit", "-m", message], {
      nodeOptions: {
        cwd: workspaceRoot,
        stdio: "pipe",
      },
    });

    return true;
  } catch {
    exitWithError(
      `Failed to commit changes`,
      `Make sure you have git configured properly with user.name and user.email`,
    );
  }
}

export async function pushBranch(
  branch: string,
  workspaceRoot: string,
  options?: { force?: boolean; forceWithLease?: boolean },
): Promise<boolean> {
  try {
    const args = ["push", "origin", branch];

    if (options?.forceWithLease) {
      args.push("--force-with-lease");
      logger.info(`Pushing branch: ${farver.green(branch)} ${farver.dim("(with lease)")}`);
    } else if (options?.force) {
      args.push("--force");
      logger.info(`Force pushing branch: ${farver.green(branch)}`);
    } else {
      logger.info(`Pushing branch: ${farver.green(branch)}`);
    }

    await runIfNotDry("git", args, {
      nodeOptions: {
        cwd: workspaceRoot,
        stdio: "pipe",
      },
    });

    return true;
  } catch {
    exitWithError(
      `Failed to push branch: ${branch}`,
      `Make sure you have permission to push to the remote repository`,
    );
  }
}

export async function readFileFromGit(
  workspaceRoot: string,
  ref: string,
  filePath: string,
): Promise<string | null> {
  try {
    const result = await run("git", ["show", `${ref}:${filePath}`], {
      nodeOptions: {
        cwd: workspaceRoot,
        stdio: "pipe",
      },
    });

    return result.stdout;
  } catch {
    return null;
  }
}

export async function getMostRecentPackageTag(
  workspaceRoot: string,
  packageName: string,
): Promise<string | undefined> {
  try {
    // Tags for each package follow the format: packageName@version
    const { stdout } = await run("git", ["tag", "--list", `${packageName}@*`], {
      nodeOptions: {
        cwd: workspaceRoot,
        stdio: "pipe",
      },
    });

    const tags = stdout.split("\n").map((tag) => tag.trim()).filter(Boolean);
    if (tags.length === 0) {
      return undefined;
    }

    // Find the last tag for the specified package
    return tags.reverse()[0];
  } catch (err) {
    logger.warn(
      `Failed to get tags for package ${packageName}: ${(err as Error).message}`,
    );
    return undefined;
  }
}

/**
 * Builds a mapping of commit SHAs to the list of files changed in each commit
 * within a given inclusive range.
 *
 * Internally runs:
 *   git log --name-only --format=%H <from>^..<to>
 *
 * Notes
 * - This includes the commit identified by `from` (via `from^..to`).
 * - Order of commits in the resulting Map follows `git log` output
 *   (reverse chronological, newest first).
 * - On failure (e.g., invalid refs), the function returns null.
 *
 * @param {string} workspaceRoot Absolute path to the git repository root used as cwd.
 * @param {string} from          Starting commit/ref (inclusive).
 * @param {string} to            Ending commit/ref (inclusive).
 * @returns {Promise<Map<string, string[]> | null>} Promise resolving to a Map where keys are commit SHAs and values are
 *          arrays of file paths changed by that commit, or null on error.
 */
export async function getGroupedFilesByCommitSha(
  workspaceRoot: string,
  from: string,
  to: string,
): Promise<Map<string, string[]> | null> {
  //                    commit hash    file paths
  const commitsMap = new Map<string, string[]>();

  try {
    const { stdout } = await run("git", ["log", "--name-only", "--format=%H", `${from}^..${to}`], {
      nodeOptions: {
        cwd: workspaceRoot,
        stdio: "pipe",
      },
    });

    const lines = stdout.trim().split("\n").filter((line) => line.trim() !== "");

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
  } catch {
    return null;
  }
}
