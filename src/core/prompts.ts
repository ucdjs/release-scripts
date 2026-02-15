import type { WorkspacePackage } from "#core/workspace";
import type { BumpKind } from "#shared/types";
import {
  getNextPrereleaseVersion,
  getNextVersion,
  getPrereleaseIdentifier,
  isValidSemver,
} from "#operations/semver";
import farver from "farver";
import prompts from "prompts";

export async function selectPackagePrompt(
  packages: WorkspacePackage[],
): Promise<string[]> {
  const response = await prompts({
    type: "multiselect",
    name: "selectedPackages",
    message: "Select packages to release",
    choices: packages.map((pkg) => ({
      title: `${pkg.name} (${farver.bold(pkg.version)})`,
      value: pkg.name,
      selected: true,
    })),
    min: 1,
    hint: "Space to select/deselect. Return to submit.",
    instructions: false,
  });

  if (!response.selectedPackages || response.selectedPackages.length === 0) {
    return [];
  }

  return response.selectedPackages;
}

export async function selectVersionPrompt(
  workspaceRoot: string,
  pkg: WorkspacePackage,
  currentVersion: string,
  suggestedVersion: string,
  options?: {
    defaultChoice?: "auto" | "skip" | "suggested" | "as-is";
    suggestedHint?: string;
  },
): Promise<string | null> {
  const defaultChoice = options?.defaultChoice ?? "auto";
  const suggestedSuffix = options?.suggestedHint
    ? farver.dim(` (${options.suggestedHint})`)
    : "";
  const prereleaseIdentifier = getPrereleaseIdentifier(currentVersion);
  const defaultPrereleaseId = prereleaseIdentifier === "alpha" || prereleaseIdentifier === "beta"
    ? prereleaseIdentifier
    : "beta";

  const nextDefaultPrerelease = getNextPrereleaseVersion(currentVersion, "next", defaultPrereleaseId);
  const nextBeta = getNextPrereleaseVersion(currentVersion, "next", "beta");
  const nextAlpha = getNextPrereleaseVersion(currentVersion, "next", "alpha");
  const prePatchBeta = getNextPrereleaseVersion(currentVersion, "prepatch", "beta");
  const preMinorBeta = getNextPrereleaseVersion(currentVersion, "preminor", "beta");
  const preMajorBeta = getNextPrereleaseVersion(currentVersion, "premajor", "beta");
  const prePatchAlpha = getNextPrereleaseVersion(currentVersion, "prepatch", "alpha");
  const preMinorAlpha = getNextPrereleaseVersion(currentVersion, "preminor", "alpha");
  const preMajorAlpha = getNextPrereleaseVersion(currentVersion, "premajor", "alpha");

  const choices = [
    { value: "skip", title: `skip ${farver.dim("(no change)")}` },
    { value: "suggested", title: `suggested ${farver.bold(suggestedVersion)}${suggestedSuffix}` },
    { value: "as-is", title: `as-is ${farver.dim("(keep current version)")}` },
    { value: "major", title: `major ${farver.bold(getNextVersion(pkg.version, "major"))}` },
    { value: "minor", title: `minor ${farver.bold(getNextVersion(pkg.version, "minor"))}` },
    { value: "patch", title: `patch ${farver.bold(getNextVersion(pkg.version, "patch"))}` },
    { value: "next", title: `next ${farver.bold(nextDefaultPrerelease)}` },
    { value: "prepatch-beta", title: `pre-patch (beta) ${farver.bold(prePatchBeta)}` },
    { value: "preminor-beta", title: `pre-minor (beta) ${farver.bold(preMinorBeta)}` },
    { value: "premajor-beta", title: `pre-major (beta) ${farver.bold(preMajorBeta)}` },
    { value: "prepatch-alpha", title: `pre-patch (alpha) ${farver.bold(prePatchAlpha)}` },
    { value: "preminor-alpha", title: `pre-minor (alpha) ${farver.bold(preMinorAlpha)}` },
    { value: "premajor-alpha", title: `pre-major (alpha) ${farver.bold(preMajorAlpha)}` },
    { value: "next-beta", title: `next beta ${farver.bold(nextBeta)}` },
    { value: "next-alpha", title: `next alpha ${farver.bold(nextAlpha)}` },
    { value: "custom", title: "custom" },
  ];

  const initialValue = defaultChoice === "auto"
    ? (suggestedVersion === currentVersion ? "skip" : "suggested")
    : defaultChoice;
  const initial = Math.max(0, choices.findIndex((choice) => choice.value === initialValue));

  const prereleaseVersionByChoice = {
    "next": nextDefaultPrerelease,
    "next-beta": nextBeta,
    "next-alpha": nextAlpha,
    "prepatch-beta": prePatchBeta,
    "preminor-beta": preMinorBeta,
    "premajor-beta": preMajorBeta,
    "prepatch-alpha": prePatchAlpha,
    "preminor-alpha": preMinorAlpha,
    "premajor-alpha": preMajorAlpha,
  } as const;

  const answers = await prompts([
    {
      type: "autocomplete",
      name: "version",
      message: `${pkg.name}: ${farver.green(pkg.version)}`,
      choices,
      limit: choices.length,
      initial,
    },
    {
      type: (prev) => prev === "custom" ? "text" : null,
      name: "custom",
      message: "Enter the new version number:",
      initial: suggestedVersion,
      validate: (custom: string) => {
        if (isValidSemver(custom)) {
          return true;
        }

        return "That's not a valid version number";
      },
    },
  ]);

  // User cancelled (Ctrl+C)
  if (!answers.version) {
    return null;
  }

  if (answers.version === "skip") {
    return null;
  } else if (answers.version === "suggested") {
    return suggestedVersion;
  } else if (answers.version === "custom") {
    if (!answers.custom) {
      return null;
    }

    return answers.custom;
  } else if (answers.version === "as-is") {
    // TODO: verify that there isn't any tags already existing for this version?
    return currentVersion;
  }

  const prereleaseVersion = prereleaseVersionByChoice[
    answers.version as keyof typeof prereleaseVersionByChoice
  ];

  if (prereleaseVersion) {
    return prereleaseVersion;
  }

  return getNextVersion(pkg.version, answers.version as BumpKind);
}
