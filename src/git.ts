import type { VersionUpdate } from "./types";
import { run } from "./utils";

export async function hasCleanWorkingDirectory(
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
    throw new Error(`Failed to check git status: ${err.message}`);
  }
}

export interface CreatePROptions {
  repo: string;
  branch: string;
  base: string;
  title: string;
  body: string;
  draft?: boolean;
  githubToken?: string;
}

export interface PRResult {
  url?: string;
  created: boolean;
  number?: number;
}

/**
 * Check if a git branch exists locally
 */
export async function branchExists(
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
 * Check if a git branch exists on remote
 */
export async function remoteBranchExists(
  branch: string,
  workspaceRoot: string,
): Promise<boolean> {
  try {
    await run("git", ["ls-remote", "--heads", "origin", branch], {
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
 */
export async function createBranch(
  branch: string,
  base: string,
  workspaceRoot: string,
): Promise<void> {
  await run("git", ["checkout", "-b", branch, base], {
    nodeOptions: {
      cwd: workspaceRoot,
    },
  });
}

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
 * Returns true if commit was made, false if there were no changes
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

/**
 * Create a GitHub PR using gh CLI
 */
export async function createPR(
  options: CreatePROptions,
  workspaceRoot: string,
): Promise<PRResult> {
  const args = [
    "pr",
    "create",
    "--title",
    options.title,
    "--body",
    options.body,
    "--base",
    options.base,
    "--head",
    options.branch,
  ];

  if (options.draft) {
    args.push("--draft");
  }

  try {
    const result = await run("gh", args, {
      nodeOptions: {
        cwd: workspaceRoot,
        stdio: "pipe",
      },
    });

    // gh CLI returns the PR URL in stdout
    const url = result.stdout.trim();

    return {
      url,
      created: true,
    };
  } catch (error) {
    throw new Error(`Failed to create PR: ${error}`);
  }
}

/**
 * Update an existing GitHub PR
 */
export async function updatePR(
  prNumber: number,
  body: string,
  workspaceRoot: string,
): Promise<void> {
  await run("gh", ["pr", "edit", String(prNumber), "--body", body], {
    nodeOptions: {
      cwd: workspaceRoot,
    },
  });
}

/**
 * Find existing release PR
 */
export async function findReleasePR(
  branch: string,
  workspaceRoot: string,
): Promise<number | undefined> {
  try {
    const result = await run(
      "gh",
      [
        "pr",
        "list",
        "--head",
        branch,
        "--json",
        "number",
        "--jq",
        ".[0].number",
      ],
      {
        nodeOptions: {
          cwd: workspaceRoot,
          stdio: "pipe",
        },
      },
    );

    const number = result.stdout.trim();
    return number ? Number.parseInt(number, 10) : undefined;
  } catch {
    return undefined;
  }
}
