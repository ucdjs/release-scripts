import type { WorkspacePackage } from "#core/workspace";

export type BumpKind = "none" | "patch" | "minor" | "major";
export type GlobalCommitMode = false | "dependencies" | "all";

export interface CommitGroup {
  /**
   * Unique identifier for the group
   */
  name: string;

  /**
   * Display title (e.g., "Features", "Bug Fixes")
   */
  title: string;

  /**
   * Conventional commit types to include in this group
   */
  types: string[];
}

export interface SharedOptions {
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
  packages?: true | FindWorkspacePackagesOptions | string[];

  /**
   * GitHub token for authentication
   */
  githubToken: string;

  /**
   * Interactive prompt configuration
   */
  prompts?: {
    /**
     * Enable package selection prompt (defaults to true when not in CI)
     */
    packages?: boolean;

    /**
     * Enable version override prompt (defaults to true when not in CI)
     */
    versions?: boolean;
  };

  /**
   * Commit grouping configuration
   * Used for changelog generation and commit display
   * @default DEFAULT_COMMIT_GROUPS
   */
  groups?: CommitGroup[];
}

export interface PackageJson {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;

  private?: boolean;

  [key: string]: unknown;
}

export interface PackageUpdateOrder {
  package: WorkspacePackage;
  level: number;
}

export interface FindWorkspacePackagesOptions {
  /**
   * Package names to exclude
   */
  exclude?: string[];

  /**
   * Only include these packages (if specified, all others are excluded)
   */
  include?: string[];

  /**
   * Whether to exclude private packages (default: false)
   */
  excludePrivate?: boolean;
}

export interface PackageRelease {
  /**
   * The package being updated
   */
  package: WorkspacePackage;

  /**
   * Current version
   */
  currentVersion: string;

  /**
   * New version to release
   */
  newVersion: string;

  /**
   * Type of version bump
   */
  bumpType: BumpKind;

  /**
   * Whether this package has direct changes (vs being updated due to dependency changes)
   */
  hasDirectChanges: boolean;
}

export interface AuthorInfo {
  commits: string[];
  login?: string;
  email: string;
  name: string;
}
