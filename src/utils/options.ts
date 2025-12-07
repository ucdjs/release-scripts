import process from "node:process";
import { Context, Effect, Layer } from "effect";

export class ConfigOptions extends Context.Tag("@ucdjs/release-scripts/ConfigOptions")<
  ConfigOptions,
  NormalizedOptions
>() {
  static layer(config: NormalizedOptions) {
    return Layer.effect(ConfigOptions, Effect.succeed(
      config,
    ));
  }
}

export interface Options {
  /**
   * Enable dry run mode (no changes will be pushed or PRs created)
   */
  dryRun?: boolean;

  /**
   * Repository identifier (e.g., "owner/repo")
   */
  repo: `${string}/${string}`;

  /**
   * Root directory of the workspace (defaults to process.cwd())
   */
  workspaceRoot?: string;

  /**
   * Specific packages to prepare for release.
   * - true: discover all packages
   * - FindWorkspacePackagesOptions: discover with filters
   * - string[]: specific package names
   */
  packages?: true | {
    exclude?: string[];
    include?: string[];
    excludePrivate?: boolean;
  } | string[];

  /**
   * GitHub token for authentication
   */
  githubToken: string;

  /**
   * Branch configuration for release process
   */
  branch?: {
    release?: string;
    default?: string;
  };

  /**
   * Enable safety checks (default: true)
   */
  safeguards?: boolean;

  /**
   * How to handle global commits (commits that affect multiple packages)
   */
  globalCommitMode?: "dependencies" | "all" | "none";

  /**
   * Pull request configuration
   */
  pullRequest?: {
    title?: string;
    body?: string;
  };

  /**
   * Changelog configuration
   */
  changelog?: {
    enabled?: boolean;
    template?: string;
  };

  /**
   * Prompt configuration
   */
  prompts?: {
    packages?: boolean;
    versions?: boolean;
  };

  /**
   * Commit groups for changelog categorization
   */
  groups?: Array<{
    name: string;
    title: string;
    types: string[];
  }>;
}

type DeepRequired<T> = Required<{
  [K in keyof T]: T[K] extends Required<T[K]> ? T[K] : DeepRequired<T[K]>
}>;

export type NormalizedOptions = DeepRequired<Omit<Options, "repo">> & {
  owner: string;
  repo: string;
};

const DEFAULT_COMMIT_GROUPS = [
  { name: "features", title: "Features", types: ["feat"] },
  { name: "fixes", title: "Bug Fixes", types: ["fix", "perf"] },
  { name: "refactor", title: "Refactoring", types: ["refactor"] },
  { name: "docs", title: "Documentation", types: ["docs"] },
];

const DEFAULT_PR_BODY_TEMPLATE = `## Summary

This PR contains the following changes:

- Updated package versions
- Updated changelogs

## Packages

The following packages will be released:

{{packages}}`;

const DEFAULT_CHANGELOG_TEMPLATE = `# Changelog

{{releases}}`;

export function normalizeOptions(options: Options): NormalizedOptions {
  const {
    workspaceRoot = process.cwd(),
    githubToken = "",
    repo: fullRepo,
    packages = true,
    branch = {},
    safeguards = true,
    globalCommitMode = "dependencies",
    pullRequest = {},
    changelog = {},
    prompts = {},
    groups = DEFAULT_COMMIT_GROUPS,
  } = options;

  if (!githubToken.trim()) {
    throw new Error("GitHub token is required. Set GITHUB_TOKEN environment variable or pass it in options.");
  }

  if (!fullRepo || !fullRepo.trim() || !fullRepo.includes("/")) {
    throw new Error("Repository (repo) is required. Specify in 'owner/repo' format (e.g., 'octocat/hello-world').");
  }

  const [owner, repo] = fullRepo.split("/");
  if (!owner || !repo) {
    throw new Error(`Invalid repo format: "${fullRepo}". Expected format: "owner/repo" (e.g., "octocat/hello-world").`);
  }

  const normalizedPackages = typeof packages === "object" && !Array.isArray(packages)
    ? {
        exclude: packages.exclude ?? [],
        include: packages.include ?? [],
        excludePrivate: packages.excludePrivate ?? false,
      }
    : packages;

  return {
    dryRun: options.dryRun ?? false,
    workspaceRoot,
    githubToken,
    owner,
    repo,
    packages: normalizedPackages,
    branch: {
      release: branch.release ?? "release/next",
      default: branch.default ?? "main",
    },
    safeguards,
    globalCommitMode,
    pullRequest: {
      title: pullRequest.title ?? "chore: release new version",
      body: pullRequest.body ?? DEFAULT_PR_BODY_TEMPLATE,
    },
    changelog: {
      enabled: changelog.enabled ?? true,
      template: changelog.template ?? DEFAULT_CHANGELOG_TEMPLATE,
    },
    prompts: {
      packages: prompts.packages ?? true,
      versions: prompts.versions ?? true,
    },
    groups,
  };
}
