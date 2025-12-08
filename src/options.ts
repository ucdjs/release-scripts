import process from "node:process";
import { Context } from "effect";

type DeepRequired<T> = Required<{
  [K in keyof T]: T[K] extends Required<T[K]> ? T[K] : DeepRequired<T[K]>
}>;

export interface FindWorkspacePackagesOptions {
  exclude?: string[];
  include?: string[];
  excludePrivate?: boolean;
}

export interface ReleaseScriptsOptionsInput {
  dryRun?: boolean;
  repo: `${string}/${string}`;
  workspaceRoot?: string;
  packages?: true | FindWorkspacePackagesOptions | string[];
  githubToken: string;
  branch?: {
    release?: string;
    default?: string;
  };
  globalCommitMode?: "dependencies" | "all" | "none";
  pullRequest?: {
    title?: string;
    body?: string;
  };
  types?: Record<string, {
    title: string;
  }>;
  changelog?: {
    enabled?: boolean;
    template?: string;
    emojis?: boolean;
  };
}

export type NormalizedReleaseScriptsOptions = DeepRequired<Omit<ReleaseScriptsOptionsInput, "repo">> & {
  owner: string;
  repo: string;
};

const DEFAULT_PR_BODY_TEMPLATE = `## Summary\n\nThis PR contains the following changes:\n\n- Updated package versions\n- Updated changelogs\n\n## Packages\n\nThe following packages will be released:\n\n{{packages}}`;
const DEFAULT_CHANGELOG_TEMPLATE = `# Changelog\n\n{{releases}}`;
const DEFAULT_TYPES = {
  feat: { title: "🚀 Features" },
  fix: { title: "🐞 Bug Fixes" },
  refactor: { title: "🔧 Code Refactoring" },
  perf: { title: "🏎 Performance" },
  docs: { title: "📚 Documentation" },
  style: { title: "🎨 Styles" },
};

export function normalizeReleaseScriptsOptions(options: ReleaseScriptsOptionsInput): NormalizedReleaseScriptsOptions {
  const {
    workspaceRoot = process.cwd(),
    githubToken = "",
    repo: fullRepo,
    packages = true,
    branch = {},
    globalCommitMode = "dependencies",
    pullRequest = {},
    changelog = {},
    types = {},
    dryRun = false,
  } = options;

  const token = githubToken.trim();
  if (!token) {
    throw new Error("GitHub token is required. Pass it in via options.");
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
    dryRun,
    workspaceRoot,
    githubToken: token,
    owner,
    repo,
    packages: normalizedPackages,
    branch: {
      release: branch.release ?? "release/next",
      default: branch.default ?? "main",
    },
    globalCommitMode,
    pullRequest: {
      title: pullRequest.title ?? "chore: release new version",
      body: pullRequest.body ?? DEFAULT_PR_BODY_TEMPLATE,
    },
    changelog: {
      enabled: changelog.enabled ?? true,
      template: changelog.template ?? DEFAULT_CHANGELOG_TEMPLATE,
      emojis: changelog.emojis ?? true,
    },
    types: options.types ? { ...DEFAULT_TYPES, ...types } : DEFAULT_TYPES,
  };
}

export class ReleaseScriptsOptions extends Context.Tag("@ucdjs/release-scripts/ReleaseScriptsOptions")<
  ReleaseScriptsOptions,
  NormalizedReleaseScriptsOptions
>() { }
