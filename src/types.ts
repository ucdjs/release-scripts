import type { WorkspacePackage } from "./workspace";

export type BumpKind = "none" | "patch" | "minor" | "major";

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
