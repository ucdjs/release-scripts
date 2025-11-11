import farver from "farver";
import { exitWithError, logger, run, runIfNotDry } from "./utils";

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
 * Pull latest changes from remote branch
 * @param branch - The branch name to pull from
 * @param workspaceRoot - The root directory of the workspace
 * @returns Promise resolving to true if pull succeeded, false otherwise
 */
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

/**
 * Create a new git branch
 * @param branch - The new branch name
 * @param base - The base branch to create from
 * @param workspaceRoot - The root directory of the workspace
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

/**
 * Checkout a git branch
 * @param branch - The branch name to checkout
 * @param workspaceRoot - The root directory of the workspace
 * @returns Promise resolving to true if checkout succeeded, false otherwise
 */
export async function checkoutBranch(
  branch: string,
  workspaceRoot: string,
): Promise<boolean> {
  try {
    logger.info(`Switching to branch: ${farver.green(branch)}`);
    await run("git", ["checkout", branch], {
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
 * Delete a local git branch
 * @param branch - The branch name to delete
 * @param workspaceRoot - The root directory of the workspace
 * @param force - Force delete even if not merged
 */
export async function deleteLocalBranch(
  branch: string,
  workspaceRoot: string,
  force = false,
): Promise<void> {
  try {
    logger.info(`Deleting local branch: ${farver.red(branch)}`);
    await run("git", ["branch", force ? "-D" : "-d", branch], {
      nodeOptions: {
        cwd: workspaceRoot,
        stdio: "pipe",
      },
    });
  } catch {
    // Branch might not exist locally, that's ok
  }
}

/**
 * Delete a remote git branch
 * @param branch - The branch name to delete
 * @param workspaceRoot - The root directory of the workspace
 */
export async function deleteRemoteBranch(
  branch: string,
  workspaceRoot: string,
): Promise<void> {
  try {
    logger.info(`Deleting remote branch: ${farver.red(branch)}`);
    await run("git", ["push", "origin", "--delete", branch], {
      nodeOptions: {
        cwd: workspaceRoot,
        stdio: "pipe",
      },
    });
  } catch {
    // Branch might not exist remotely, that's ok
  }
}

/**
 * Get the current branch name
 * @param workspaceRoot - The root directory of the workspace
 * @returns Promise resolving to the current branch name
 */
export async function getCurrentBranch(
  workspaceRoot: string,
): Promise<string> {
  const result = await run("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    nodeOptions: {
      cwd: workspaceRoot,
      stdio: "pipe",
    },
  });

  return result.stdout.trim();
}

/**
 * Rebase current branch onto another branch
 * @param ontoBranch - The target branch to rebase onto
 * @param workspaceRoot - The root directory of the workspace
 */
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

/**
 * Check if local branch is ahead of remote (has commits to push)
 * @param branch - The branch name to check
 * @param workspaceRoot - The root directory of the workspace
 * @returns Promise resolving to true if local is ahead, false otherwise
 */
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

/**
 * Check if there are any changes to commit (staged or unstaged)
 * @param workspaceRoot - The root directory of the workspace
 * @returns Promise resolving to true if there are changes, false otherwise
 */
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

/**
 * Commit changes with a message
 * @param message - The commit message
 * @param workspaceRoot - The root directory of the workspace
 * @returns Promise resolving to true if commit was made, false if there were no changes
 */
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

/**
 * Push branch to remote
 * @param branch - The branch name to push
 * @param workspaceRoot - The root directory of the workspace
 * @param options - Push options
 * @param options.force - Force push (overwrite remote)
 * @param options.forceWithLease - Force push with safety check (won't overwrite unexpected changes)
 */
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

export async function getDefaultBranch(): Promise<string> {
  try {
    const result = await run("git", ["symbolic-ref", "refs/remotes/origin/HEAD"], {
      nodeOptions: {
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
