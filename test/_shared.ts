import type { GitHubClient } from "#core/github";
import type { WorkspacePackage } from "#core/workspace";
import type { NormalizedReleaseScriptsOptions } from "../src/options";
import type { GitCommit } from "commit-parser";
import { DEFAULT_TYPES } from "../src/options";

export function createCommit(overrides: Partial<GitCommit> = {}): GitCommit {
  const message = overrides.message ?? overrides.description ?? "feat: add feature";
  const description = overrides.description ?? message.split("\n")[0]!;

  return {
    hash: overrides.hash ?? "abc1234567890",
    shortHash: overrides.shortHash ?? "abc1234",
    message,
    description,
    type: overrides.type ?? "feat",
    scope: overrides.scope,
    isConventional: overrides.isConventional ?? true,
    isBreaking: overrides.isBreaking ?? false,
    body: overrides.body,
    references: overrides.references ?? [],
    authors: overrides.authors ?? [
      { name: "Test Author", email: "author@example.com" },
    ],
    ...overrides,
  } as GitCommit;
}

export function createGitHubClientStub(overrides: Partial<GitHubClient> = {}): GitHubClient {
  const stub: Partial<GitHubClient> = {
    resolveAuthorInfo: async (info) => info,
    ...overrides,
  };

  return stub as GitHubClient;
}

export function createNormalizedReleaseOptions(
  overrides: Partial<NormalizedReleaseScriptsOptions> = {},
): NormalizedReleaseScriptsOptions {
  const base: NormalizedReleaseScriptsOptions = {
    packages: true,
    prompts: {
      packages: true,
      versions: true,
    },
    npm: {
      provenance: true,
      otp: undefined,
    },
    workspaceRoot: overrides.workspaceRoot ?? process.cwd(),
    githubToken: "test-token",
    owner: overrides.owner ?? "ucdjs",
    repo: overrides.repo ?? "test-repo",
    types: overrides.types ?? DEFAULT_TYPES,
    branch: {
      release: "release/next",
      default: "main",
    },
    safeguards: true,
    globalCommitMode: "dependencies",
    pullRequest: {
      title: "chore: release",
      body: "Release body",
    },
    changelog: {
      enabled: true,
      template: "",
      emojis: true,
    },
    dryRun: false,
  };

  return {
    ...base,
    ...overrides,
    branch: {
      ...base.branch,
      ...overrides.branch,
    },
    prompts: {
      ...base.prompts,
      ...overrides.prompts,
    },
    pullRequest: {
      ...base.pullRequest,
      ...overrides.pullRequest,
    },
    changelog: {
      ...base.changelog,
      ...overrides.changelog,
    },
  };
}

export function createWorkspacePackage(
  path: string,
  overrides: Partial<WorkspacePackage> = {},
): WorkspacePackage {
  const name = overrides.name ?? "@ucdjs/test";
  const version = overrides.version ?? "0.0.0";

  return {
    name,
    version,
    path,
    packageJson: overrides.packageJson ?? { name, version },
    workspaceDependencies: overrides.workspaceDependencies ?? [],
    workspaceDevDependencies: overrides.workspaceDevDependencies ?? [],
    ...overrides,
  };
}

export function createChangelogTestContext(workspaceRoot: string, overrides: {
  normalizedOptions?: Partial<NormalizedReleaseScriptsOptions>;
  workspacePackage?: Partial<WorkspacePackage>;
  githubClient?: Partial<GitHubClient>;
} = {}) {
  const normalizedOptions = createNormalizedReleaseOptions({
    workspaceRoot,
    ...overrides.normalizedOptions,
  });

  const workspacePackage = createWorkspacePackage(workspaceRoot, overrides.workspacePackage);
  const githubClient = createGitHubClientStub(overrides.githubClient);

  return {
    normalizedOptions,
    workspacePackage,
    githubClient,
  };
}
