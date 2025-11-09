import type { WorkspacePackage } from "./workspace";

export type BumpKind = "none" | "patch" | "minor" | "major";

export interface SharedOptions {
  /**
   * Repository identifier (e.g., "owner/repo")
   */
  repo: string;

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
   * Whether to enable verbose logging
   * @default false
   */
  verbose?: boolean;

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

export interface VersionUpdate {
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
