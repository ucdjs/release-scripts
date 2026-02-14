import type { WorkspacePackage } from "#core/workspace";
import type { PackageRelease } from "#shared/types";
import type { GitCommit } from "commit-parser";
import type { GitHubPullRequest } from "#core/github";
import type { Result } from "../types/result";

export interface GitError {
  type: "git";
  operation: string;
  message: string;
  stderr?: string;
}

export interface GitOperations {
  isWorkingDirectoryClean: (workspaceRoot: string) => Promise<Result<boolean, GitError>>;
  doesBranchExist: (branch: string, workspaceRoot: string) => Promise<Result<boolean, GitError>>;
  getCurrentBranch: (workspaceRoot: string) => Promise<Result<string, GitError>>;
  checkoutBranch: (branch: string, workspaceRoot: string) => Promise<Result<boolean, GitError>>;
  createBranch: (branch: string, base: string, workspaceRoot: string) => Promise<Result<void, GitError>>;
  pullLatestChanges: (branch: string, workspaceRoot: string) => Promise<Result<boolean, GitError>>;
  rebaseBranch: (ontoBranch: string, workspaceRoot: string) => Promise<Result<void, GitError>>;
  isBranchAheadOfRemote: (branch: string, workspaceRoot: string) => Promise<Result<boolean, GitError>>;
  commitChanges: (message: string, workspaceRoot: string) => Promise<Result<boolean, GitError>>;
  pushBranch: (branch: string, workspaceRoot: string, options?: { force?: boolean; forceWithLease?: boolean }) => Promise<Result<boolean, GitError>>;
  readFileFromGit: (workspaceRoot: string, ref: string, filePath: string) => Promise<Result<string | null, GitError>>;
  getMostRecentPackageTag: (workspaceRoot: string, packageName: string) => Promise<Result<string | undefined, GitError>>;
}

export interface GitHubError {
  type: "github";
  operation: string;
  message: string;
  status?: number;
}

export interface GitHubOperations {
  getExistingPullRequest: (branch: string) => Promise<Result<GitHubPullRequest | null, GitHubError>>;
  upsertPullRequest: (options: {
    title: string;
    body: string;
    head?: string;
    base?: string;
    pullNumber?: number;
  }) => Promise<Result<GitHubPullRequest | null, GitHubError>>;
  setCommitStatus: (options: {
    sha: string;
    state: "error" | "failure" | "pending" | "success";
    targetUrl?: string;
    description?: string;
    context: string;
  }) => Promise<Result<void, GitHubError>>;
  resolveAuthorInfo: (info: { commits: string[]; login?: string; email: string; name: string }) => Promise<Result<{ commits: string[]; login?: string; email: string; name: string }, GitHubError>>;
}

export interface WorkspaceError {
  type: "workspace";
  operation: string;
  message: string;
}

export interface WorkspaceOperations {
  discoverWorkspacePackages: (workspaceRoot: string, options: unknown) => Promise<Result<WorkspacePackage[], WorkspaceError>>;
}

export interface VersioningOperations {
  getWorkspacePackageGroupedCommits: (workspaceRoot: string, packages: WorkspacePackage[]) => Promise<Result<Map<string, GitCommit[]>, GitError>>;
  getGlobalCommitsPerPackage: (workspaceRoot: string, commitsByPackage: Map<string, GitCommit[]>, packages: WorkspacePackage[], mode: "dependencies" | "all" | false) => Promise<Result<Map<string, GitCommit[]>, GitError>>;
  calculateAndPrepareVersionUpdates: (options: {
    workspacePackages: WorkspacePackage[];
    packageCommits: Map<string, GitCommit[]>;
    workspaceRoot: string;
    showPrompt: boolean;
    globalCommitsPerPackage: Map<string, GitCommit[]>;
    overrides: Record<string, { version: string }>;
  }) => Promise<Result<{
    allUpdates: PackageRelease[];
    applyUpdates: () => Promise<void>;
    overrides: Record<string, { version: string }>;
  }, GitError>>;
}
