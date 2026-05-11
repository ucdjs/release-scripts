import type { WorkspacePackage } from "./services/workspace";

export type BumpKind = "none" | "patch" | "minor" | "major";

export interface CommitTypeRule {
  title: string;
  types?: string[];
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
  exclude?: string[];
  include?: string[];
  excludePrivate?: boolean;
}

export interface PackageRelease {
  package: WorkspacePackage;
  currentVersion: string;
  newVersion: string;
  bumpType: BumpKind;
  hasDirectChanges: boolean;
  changeKind: "auto" | "manual" | "as-is" | "dependent";
}

export interface AuthorInfo {
  commits: string[];
  login?: string;
  email: string;
  name: string;
}

export interface ReleaseResult {
  updates: PackageRelease[];
  prUrl?: string;
  created: boolean;
}
