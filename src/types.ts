export type BumpKind = "none" | "patch" | "minor" | "major";

export interface PackageJson {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  [key: string]: unknown;
}

export interface WorkspacePackage {
  name: string;
  version: string;
  path: string;
  packageJson: PackageJson;
  workspaceDependencies: string[];
  workspaceDevDependencies: string[];
}

export interface DependencyGraph {
  packages: Map<string, WorkspacePackage>;
  dependents: Map<string, Set<string>>;
}

export interface PackageUpdateOrder {
  package: WorkspacePackage;
  level: number;
}

export interface ReleaseContext {
  /**
   * Root directory of the workspace
   */
  workspaceRoot: string;

  /**
   * Package names to exclude from release operations
   */
  excludePackages?: string[];

  /**
   * Only include these packages (if specified, all others are excluded)
   */
  includePackages?: string[];

  /**
   * Filter function to determine if a package should be included
   * @param pkg - The workspace package to check
   * @returns true if the package should be included, false otherwise
   */
  packageFilter?: (pkg: WorkspacePackage) => boolean;

  /**
   * Whether to exclude private packages (default: true)
   */
  excludePrivate?: boolean;
}

export interface FindWorkspacePackagesOptions {
  /**
   * Package names to exclude
   */
  excluded?: string[];

  /**
   * Only include these packages (if specified, all others are excluded)
   */
  included?: string[];

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

export interface ReleaseOptions {
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
   * Branch name for the release PR (defaults to "release/next")
   */
  releaseBranch?: string;

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
   * Whether to perform a dry run (no changes pushed or PR created)
   * @default false
   */
  dryRun?: boolean;

  /**
   * Whether to enable safety safeguards (e.g., checking for clean working directory)
   * @default true
   */
  safeguards?: boolean;

  /**
   * GitHub token for authentication
   */
  githubToken: string;

  pullRequest?: {
    title: string;

    body: string;
  };
}

export interface ReleaseResult {
  /**
   * Packages that will be updated
   */
  updates: VersionUpdate[];

  /**
   * URL of the created or updated PR
   */
  prUrl?: string;

  /**
   * Whether a new PR was created (vs updating existing)
   */
  created: boolean;
}
