import {
  exitWithError,
  logger,
  run,
  runIfNotDry,
} from "#shared/utils";
import farver from "farver";

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
    await runIfNotDry("git", ["checkout", "-b", branch, base], {
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
): Promise<void> {
  try {
    logger.info(`Rebasing onto: ${farver.cyan(ontoBranch)}`);
    await run("git", ["rebase", ontoBranch], {
      nodeOptions: {
        cwd: workspaceRoot,
        stdio: "pipe",
      },
    });
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

export async function hasChangesToCommit(
  workspaceRoot: string,
): Promise<boolean> {
  const result = await run("git", ["status", "--porcelain"], {
    nodeOptions: {
      cwd: workspaceRoot,
      stdio: "pipe",
    },
  });

  return result.stdout.trim() !== "";
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
    const hasChanges = await hasChangesToCommit(workspaceRoot);
    if (!hasChanges) {
      return false;
    }

    // Commit
    logger.info(`Committing changes: ${farver.dim(message)}`);
    await run("git", ["commit", "-m", message], {
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
): Promise<void> {
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

    await run("git", args, {
      nodeOptions: {
        cwd: workspaceRoot,
        stdio: "pipe",
      },
    });
  } catch {
    exitWithError(
      `Failed to push branch: ${branch}`,
      `Make sure you have permission to push to the remote repository`,
    );
  }
}
