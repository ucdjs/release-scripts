import type { BumpKind } from "#shared/types";

export function isValidSemver(version: string): boolean {
  const semverRegex = /^\d+\.\d+\.\d+(?:[-+].+)?$/;
  return semverRegex.test(version);
}

export function getNextVersion(currentVersion: string, bump: BumpKind): string {
  if (bump === "none") {
    return currentVersion;
  }

  if (!isValidSemver(currentVersion)) {
    throw new Error(`Cannot bump version for invalid semver: ${currentVersion}`);
  }

  const match = currentVersion.match(/^(\d+)\.(\d+)\.(\d+)(.*)$/);
  if (!match) {
    throw new Error(`Invalid semver version: ${currentVersion}`);
  }

  const [, major, minor, patch] = match;
  let newMajor = Number.parseInt(major!, 10);
  let newMinor = Number.parseInt(minor!, 10);
  let newPatch = Number.parseInt(patch!, 10);

  switch (bump) {
    case "major":
      newMajor += 1;
      newMinor = 0;
      newPatch = 0;
      break;
    case "minor":
      newMinor += 1;
      newPatch = 0;
      break;
    case "patch":
      newPatch += 1;
      break;
  }

  return `${newMajor}.${newMinor}.${newPatch}`;
}

export function calculateBumpType(oldVersion: string, newVersion: string): BumpKind {
  if (!isValidSemver(oldVersion) || !isValidSemver(newVersion)) {
    throw new Error(`Cannot calculate bump type for invalid semver: ${oldVersion} or ${newVersion}`);
  }

  const oldParts = oldVersion.split(".").map(Number);
  const newParts = newVersion.split(".").map(Number);

  if (newParts[0]! > oldParts[0]!) return "major";
  if (newParts[1]! > oldParts[1]!) return "minor";
  if (newParts[2]! > oldParts[2]!) return "patch";

  return "none";
}
