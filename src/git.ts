import type { VersionUpdate } from "./types";
import { run, runIfNotDry } from "./utils";

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
    console.error("Error checking git status:", err);
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
  await runIfNotDry("git", ["checkout", "-b", branch, base], {
    nodeOptions: {
      cwd: workspaceRoot,
    },
  });
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
    await run("git", ["checkout", branch], {
      nodeOptions: {
        cwd: workspaceRoot,
      },
    });
    return true;
  } catch {
    return false;
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
  await run("git", ["rebase", ontoBranch], {
    nodeOptions: {
      cwd: workspaceRoot,
    },
  });
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
  // Stage all changes
  await run("git", ["add", "."], {
    nodeOptions: {
      cwd: workspaceRoot,
    },
  });

  // Check if there are changes to commit
  const hasChanges = await hasChangesToCommit(workspaceRoot);
  if (!hasChanges) {
    return false;
  }

  // Commit
  await run("git", ["commit", "-m", message], {
    nodeOptions: {
      cwd: workspaceRoot,
    },
  });

  return true;
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
  const args = ["push", "origin", branch];

  if (options?.forceWithLease) {
    args.push("--force-with-lease");
  } else if (options?.force) {
    args.push("--force");
  }

  await run("git", args, {
    nodeOptions: {
      cwd: workspaceRoot,
    },
  });
}

/**
 * Generate PR body from version updates
 * @param updates - Array of version updates to include in the PR body
 * @returns Formatted PR body as a string
 */
export function generatePRBody(updates: VersionUpdate[]): string {
  const lines: string[] = [];

  lines.push("## Packages");
  lines.push("");

  // Group by direct changes vs dependency updates
  const directChanges = updates.filter((u) => u.hasDirectChanges);
  const dependencyUpdates = updates.filter((u) => !u.hasDirectChanges);

  if (directChanges.length > 0) {
    lines.push("### Direct Changes");
    lines.push("");
    for (const update of directChanges) {
      lines.push(
        `- **${update.package.name}**: ${update.currentVersion} → ${update.newVersion} (${update.bumpType})`,
      );
    }
    lines.push("");
  }

  if (dependencyUpdates.length > 0) {
    lines.push("### Dependency Updates");
    lines.push("");
    for (const update of dependencyUpdates) {
      lines.push(
        `- **${update.package.name}**: ${update.currentVersion} → ${update.newVersion} (dependencies changed)`,
      );
    }
    lines.push("");
  }

  lines.push("---");
  lines.push("");
  lines.push("This release PR was automatically generated.");

  return lines.join("\n");
}
