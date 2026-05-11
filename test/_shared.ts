import type { GitHubServiceShape } from "../src/services/github";
import { Effect } from "effect";
import type { WorkspacePackage } from "../src/services/workspace";
import type { GitCommit } from "commit-parser";

import type { NormalizedReleaseScriptsOptions } from "../src/options";
import { DEFAULT_TYPES } from "../src/options";

export function createCommit(overrides: Partial<GitCommit> = {}): GitCommit {
  const message = overrides.message ?? overrides.description ?? "feat: add feature";
  const description = overrides.description ?? message.split("\n")[0];

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
    authors: overrides.authors ?? [{ name: "Test Author", email: "author@example.com" }],
    ...overrides,
  } as GitCommit;
}

export function createGitHubServiceStub(
  overrides: Partial<GitHubServiceShape> = {},
): GitHubServiceShape {
  const stub: GitHubServiceShape = {
    getExistingPullRequest: () => Effect.succeed(null),
    upsertPullRequest: () => Effect.succeed(null),
    setCommitStatus: () => Effect.void,
    upsertReleaseByTag: () =>
      Effect.succeed({ release: { id: 1, tagName: "tag", name: "tag" }, created: true }),
    resolveAuthorInfo: (info: any) => Effect.succeed(info),
    ...overrides,
  };

  return stub;
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
      access: "public",
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
      combinePrereleaseIntoFirstStable: false,
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

export function createChangelogTestContext(
  workspaceRoot: string,
  overrides: {
    normalizedOptions?: Partial<NormalizedReleaseScriptsOptions>;
    workspacePackage?: Partial<WorkspacePackage>;
    githubService?: Partial<GitHubServiceShape>;
  } = {},
) {
  const normalizedOptions = createNormalizedReleaseOptions({
    workspaceRoot,
    ...overrides.normalizedOptions,
  });

  const workspacePackage = createWorkspacePackage(workspaceRoot, overrides.workspacePackage);
  const githubService = createGitHubServiceStub(overrides.githubService);

  return {
    normalizedOptions,
    workspacePackage,
    githubService,
  };
}
