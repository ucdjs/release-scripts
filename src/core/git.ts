import type { Result } from "#types";
import {
  logger,
  run,
  runIfNotDry,
} from "#shared/utils";
import { err, ok } from "#types";
import farver from "farver";

/**
 * Check if the working directory is clean (no uncommitted changes)
 * @param {string} workspaceRoot - The root directory of the workspace
 * @returns {Promise<boolean>} A Promise resolving to true if clean, false otherwise
 */
export interface GitError {
  type: "git";
  operation: string;
  message: string;
  stderr?: string;
}

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

export async function isWorkingDirectoryClean(
  workspaceRoot: string,
): Promise<Result<boolean, GitError>> {
  try {
    const result = await run("git", ["status", "--porcelain"], {
      nodeOptions: {
        cwd: workspaceRoot,
        stdio: "pipe",
      },
    });
    return ok(result.stdout.trim() === "");
  } catch (error) {
    return err(toGitError("isWorkingDirectoryClean", error));
  }
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
): Promise<Result<boolean, GitError>> {
  try {
    await run("git", ["rev-parse", "--verify", branch], {
      nodeOptions: {
        cwd: workspaceRoot,
        stdio: "pipe",
      },
    });

    return ok(true);
  } catch {
    return ok(false);
  }
}

/**
 * Retrieves the default branch name from the remote repository.
 * Falls back to "main" if the default branch cannot be determined.
 * @returns {Promise<string>} A Promise resolving to the default branch name as a string.
 */
export async function getDefaultBranch(workspaceRoot: string): Promise<Result<string, GitError>> {
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
      return ok(match[1]);
    }

    return ok("main"); // Fallback
  } catch {
    return ok("main"); // Fallback
  }
}

/**
 * Retrieves the name of the current branch in the repository.
 * @param {string} workspaceRoot - The root directory of the workspace
 * @returns {Promise<string>} A Promise resolving to the current branch name as a string
 */
export async function getCurrentBranch(
  workspaceRoot: string,
): Promise<Result<string, GitError>> {
  try {
    const result = await run("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      nodeOptions: {
        cwd: workspaceRoot,
        stdio: "pipe",
      },
    });

    return ok(result.stdout.trim());
  } catch (error) {
    return err(toGitError("getCurrentBranch", error));
  }
}

/**
 * Retrieves the list of available branches in the repository.
 * @param {string} workspaceRoot - The root directory of the workspace
 * @returns {Promise<string[]>} A Promise resolving to an array of branch names
 */
export async function getAvailableBranches(
  workspaceRoot: string,
): Promise<Result<string[], GitError>> {
  try {
    const result = await run("git", ["branch", "--list"], {
      nodeOptions: {
        cwd: workspaceRoot,
        stdio: "pipe",
      },
    });

    const branches = result.stdout
      .split("\n")
      .map((line) => line.replace("*", "").trim())
      .filter((line) => line.length > 0);

    return ok(branches);
  } catch (error) {
    return err(toGitError("getAvailableBranches", error));
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
): Promise<Result<void, GitError>> {
  try {
    logger.info(`Creating branch: ${farver.green(branch)} from ${farver.cyan(base)}`);
    await runIfNotDry("git", ["branch", branch, base], {
      nodeOptions: {
        cwd: workspaceRoot,
        stdio: "pipe",
      },
    });
    return ok(undefined);
  } catch (error) {
    return err(toGitError("createBranch", error));
  }
}

export async function checkoutBranch(
  branch: string,
  workspaceRoot: string,
): Promise<Result<boolean, GitError>> {
  try {
    logger.info(`Switching to branch: ${farver.green(branch)}`);
    const result = await run("git", ["checkout", branch], {
      nodeOptions: {
        cwd: workspaceRoot,
        stdio: "pipe",
      },
    });

    const output = result.stderr.trim();

    // Switching Branches "Switched to branch '[name]'"
    // New Branch "Switched to a new branch '[name]'"
    const match = output.match(/Switched to (?:a new )?branch '(.+)'/);
    if (match && match[1] === branch) {
      logger.info(`Successfully switched to branch: ${farver.green(branch)}`);
      return ok(true);
    }

    console.warn(`Unexpected git checkout output: ${output}`);
    return ok(false);
  } catch (error) {
    const gitError = toGitError("checkoutBranch", error);
    logger.error(`Git checkout failed: ${gitError.message}`);
    if (gitError.stderr) {
      logger.error(`Git stderr: ${gitError.stderr}`);
    }

    // Show available branches for debugging
    try {
      const branchResult = await run("git", ["branch", "-a"], {
        nodeOptions: {
          cwd: workspaceRoot,
          stdio: "pipe",
        },
      });
      logger.verbose(`Available branches:\n${branchResult.stdout}`);
    } catch {
      logger.verbose("Could not list available branches");
    }

    return err(gitError);
  }
}

export async function pullLatestChanges(
  branch: string,
  workspaceRoot: string,
): Promise<Result<boolean, GitError>> {
  try {
    await run("git", ["pull", "origin", branch], {
      nodeOptions: {
        cwd: workspaceRoot,
        stdio: "pipe",
      },
    });
    return ok(true);
  } catch (error) {
    return err(toGitError("pullLatestChanges", error));
  }
}

export async function rebaseBranch(
  ontoBranch: string,
  workspaceRoot: string,
): Promise<Result<void, GitError>> {
  try {
    logger.info(`Rebasing onto: ${farver.cyan(ontoBranch)}`);
    await runIfNotDry("git", ["rebase", ontoBranch], {
      nodeOptions: {
        cwd: workspaceRoot,
        stdio: "pipe",
      },
    });

    return ok(undefined);
  } catch (error) {
    return err(toGitError("rebaseBranch", error));
  }
}

export async function isBranchAheadOfRemote(
  branch: string,
  workspaceRoot: string,
): Promise<Result<boolean, GitError>> {
  try {
    const result = await run("git", ["rev-list", `origin/${branch}..${branch}`, "--count"], {
      nodeOptions: {
        cwd: workspaceRoot,
        stdio: "pipe",
      },
    });

    const commitCount = Number.parseInt(result.stdout.trim(), 10);
    return ok(commitCount > 0);
  } catch {
    return ok(true);
  }
}

export async function commitChanges(
  message: string,
  workspaceRoot: string,
): Promise<Result<boolean, GitError>> {
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
    if (!isClean.ok || isClean.value) {
      return ok(false);
    }

    // Commit
    logger.info(`Committing changes: ${farver.dim(message)}`);
    await runIfNotDry("git", ["commit", "-m", message], {
      nodeOptions: {
        cwd: workspaceRoot,
        stdio: "pipe",
      },
    });

    return ok(true);
  } catch (error) {
    const gitError = toGitError("commitChanges", error);
    logger.error(`Git commit failed: ${gitError.message}`);
    if (gitError.stderr) {
      logger.error(`Git stderr: ${gitError.stderr}`);
    }
    return err(gitError);
  }
}

export async function pushBranch(
  branch: string,
  workspaceRoot: string,
  options?: { force?: boolean; forceWithLease?: boolean },
): Promise<Result<boolean, GitError>> {
  try {
    const args = ["push", "origin", branch];

    if (options?.forceWithLease) {
      await run("git", ["fetch", "origin", branch], {
        nodeOptions: {
          cwd: workspaceRoot,
          stdio: "pipe",
        },
      });
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

    return ok(true);
  } catch (error) {
    return err(toGitError("pushBranch", error));
  }
}

export async function readFileFromGit(
  workspaceRoot: string,
  ref: string,
  filePath: string,
): Promise<Result<string | null, GitError>> {
  try {
    const result = await run("git", ["show", `${ref}:${filePath}`], {
      nodeOptions: {
        cwd: workspaceRoot,
        stdio: "pipe",
      },
    });

    return ok(result.stdout);
  } catch {
    return ok(null);
  }
}

export async function getMostRecentPackageTag(
  workspaceRoot: string,
  packageName: string,
): Promise<Result<string | undefined, GitError>> {
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
      return ok(undefined);
    }

    // Find the last tag for the specified package
    return ok(tags.reverse()[0]);
  } catch (error) {
    return err(toGitError("getMostRecentPackageTag", error));
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
): Promise<Result<Map<string, string[]>, GitError>> {
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
      // Note: In case of merge commits, an empty line might appear which is already filtered.
      commitsMap.get(currentSha)!.push(trimmedLine);
    }

    return ok(commitsMap);
  } catch (error) {
    return err(toGitError("getGroupedFilesByCommitSha", error));
  }
}

/**
 * Create a git tag for a package release
 * @param packageName - The package name (e.g., "@scope/name")
 * @param version - The version to tag (e.g., "1.2.3")
 * @param workspaceRoot - The root directory of the workspace
 * @returns Result indicating success or failure
 */
export async function createPackageTag(
  packageName: string,
  version: string,
  workspaceRoot: string,
): Promise<Result<void, GitError>> {
  const tagName = `${packageName}@${version}`;

  try {
    logger.info(`Creating tag: ${farver.green(tagName)}`);
    await runIfNotDry("git", ["tag", tagName], {
      nodeOptions: {
        cwd: workspaceRoot,
        stdio: "pipe",
      },
    });
    return ok(undefined);
  } catch (error) {
    return err(toGitError("createPackageTag", error));
  }
}

/**
 * Push a specific tag to the remote repository
 * @param tagName - The tag name to push
 * @param workspaceRoot - The root directory of the workspace
 * @returns Result indicating success or failure
 */
export async function pushTag(
  tagName: string,
  workspaceRoot: string,
): Promise<Result<void, GitError>> {
  try {
    logger.info(`Pushing tag: ${farver.green(tagName)}`);
    await runIfNotDry("git", ["push", "origin", tagName], {
      nodeOptions: {
        cwd: workspaceRoot,
        stdio: "pipe",
      },
    });
    return ok(undefined);
  } catch (error) {
    return err(toGitError("pushTag", error));
  }
}

/**
 * Create and push a package tag in one operation
 * @param packageName - The package name
 * @param version - The version to tag
 * @param workspaceRoot - The root directory of the workspace
 * @returns Result indicating success or failure
 */
export async function createAndPushPackageTag(
  packageName: string,
  version: string,
  workspaceRoot: string,
): Promise<Result<void, GitError>> {
  const createResult = await createPackageTag(packageName, version, workspaceRoot);
  if (!createResult.ok) {
    return createResult;
  }

  const tagName = `${packageName}@${version}`;
  return pushTag(tagName, workspaceRoot);
}
