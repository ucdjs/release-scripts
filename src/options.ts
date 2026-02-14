import process from "node:process";

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
    color?: string;
  }>;
  changelog?: {
    enabled?: boolean;
    template?: string;
    emojis?: boolean;
  };
  npm?: {
    otp?: string;
    provenance?: boolean;
  };
  prompts?: {
    versions?: boolean;
    packages?: boolean;
  };
}

export type NormalizedReleaseScriptsOptions = DeepRequired<Omit<ReleaseScriptsOptionsInput, "repo" | "npm" | "prompts">> & {
  owner: string;
  repo: string;
  npm: {
    otp?: string;
    provenance: boolean;
  };
  prompts: {
    versions: boolean;
    packages: boolean;
  };
};

const DEFAULT_PR_BODY_TEMPLATE = `## Summary\n\nThis PR contains the following changes:\n\n- Updated package versions\n- Updated changelogs\n\n## Packages\n\nThe following packages will be released:\n\n{{packages}}`;
const DEFAULT_CHANGELOG_TEMPLATE = `# Changelog\n\n{{releases}}`;
export const DEFAULT_TYPES = {
  feat: { title: "🚀 Features", color: "green" },
  fix: { title: "🐞 Bug Fixes", color: "red" },
  refactor: { title: "🔧 Code Refactoring", color: "blue" },
  perf: { title: "🏎 Performance", color: "orange" },
  docs: { title: "📚 Documentation", color: "purple" },
  style: { title: "🎨 Styles", color: "pink" },
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
    npm = {},
    prompts = {},
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

  const isCI = process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true";

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
    npm: {
      otp: npm.otp,
      provenance: npm.provenance ?? true,
    },
    prompts: {
      versions: prompts.versions ?? !isCI,
      packages: prompts.packages ?? !isCI,
    },
  };
}
