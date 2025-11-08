import type { BumpKind } from "./types";

/**
 * Validation utilities for release scripts
 */

export function isValidSemver(version: string): boolean {
  // Basic semver validation: X.Y.Z with optional pre-release/build metadata
  const semverRegex = /^\d+\.\d+\.\d+(?:[-+].+)?$/;
  return semverRegex.test(version);
}

export function validateSemver(version: string): void {
  if (!isValidSemver(version)) {
    throw new Error(`Invalid semver version: ${version}`);
  }
}

export function isValidBumpKind(bump: string): bump is BumpKind {
  return ["none", "patch", "minor", "major"].includes(bump);
}

export function validateBumpKind(bump: string): asserts bump is BumpKind {
  if (!isValidBumpKind(bump)) {
    throw new Error(`Invalid bump kind: ${bump}. Must be one of: none, patch, minor, major`);
  }
}

export function isValidPackageName(name: string): boolean {
  // NPM package name rules (simplified)
  // - Can contain lowercase letters, numbers, hyphens, underscores
  // - Can be scoped (@scope/name)
  const packageNameRegex = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
  return packageNameRegex.test(name);
}

export function validatePackageName(name: string): void {
  if (!isValidPackageName(name)) {
    throw new Error(`Invalid package name: ${name}`);
  }
}

export function validateNonEmpty<T>(
  array: T[],
  message: string,
): asserts array is [T, ...T[]] {
  if (array.length === 0) {
    throw new Error(message);
  }
}

export function validateNotNull<T>(
  value: T | null | undefined,
  message: string,
): asserts value is T {
  if (value === null || value === undefined) {
    throw new Error(message);
  }
}
