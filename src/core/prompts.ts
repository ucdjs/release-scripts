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
  const isCurrentPrerelease = prereleaseIdentifier != null;

  const choices = [
    { value: "skip", title: `skip ${farver.dim("(no change)")}` },
    { value: "suggested", title: `suggested ${farver.bold(suggestedVersion)}${suggestedSuffix}` },
    { value: "as-is", title: `as-is ${farver.dim("(keep current version)")}` },
    ...(isCurrentPrerelease
      ? [{ value: "next-prerelease", title: `next prerelease ${farver.bold(nextDefaultPrerelease)}` }]
      : []),
    { value: "patch", title: `patch ${farver.bold(getNextVersion(pkg.version, "patch"))}` },
    { value: "minor", title: `minor ${farver.bold(getNextVersion(pkg.version, "minor"))}` },
    { value: "major", title: `major ${farver.bold(getNextVersion(pkg.version, "major"))}` },
    { value: "prerelease", title: `prerelease ${farver.dim("(choose strategy)")}` },
    { value: "custom", title: "custom" },
  ];

  const initialValue = defaultChoice === "auto"
    ? (suggestedVersion === currentVersion ? "skip" : "suggested")
    : defaultChoice;
  const initial = Math.max(0, choices.findIndex((choice) => choice.value === initialValue));

  const prereleaseVersionByChoice = {
    "next-prerelease": nextDefaultPrerelease,
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

  const answers = await prompts({
    type: "autocomplete",
    name: "version",
    message: `${pkg.name}: ${farver.green(pkg.version)}`,
    choices,
    limit: choices.length,
    initial,
  });

  // User cancelled (Ctrl+C)
  if (!answers.version) {
    return null;
  }

  if (answers.version === "skip") {
    return null;
  } else if (answers.version === "suggested") {
    return suggestedVersion;
  } else if (answers.version === "custom") {
    const customAnswer = await prompts({
      type: "text",
      name: "custom",
      message: "Enter the new version number:",
      initial: suggestedVersion,
      validate: (custom: string) => {
        if (isValidSemver(custom)) {
          return true;
        }

        return "That's not a valid version number";
      },
    });

    if (!customAnswer.custom) {
      return null;
    }

    return customAnswer.custom;
  } else if (answers.version === "as-is") {
    // TODO: verify that there isn't any tags already existing for this version?
    return currentVersion;
  } else if (answers.version === "prerelease") {
    const prereleaseChoices = [
      { value: "next", title: `next ${farver.bold(nextDefaultPrerelease)}` },
      { value: "next-beta", title: `next beta ${farver.bold(nextBeta)}` },
      { value: "next-alpha", title: `next alpha ${farver.bold(nextAlpha)}` },
      { value: "prepatch-beta", title: `pre-patch (beta) ${farver.bold(prePatchBeta)}` },
      { value: "prepatch-alpha", title: `pre-patch (alpha) ${farver.bold(prePatchAlpha)}` },
      { value: "preminor-beta", title: `pre-minor (beta) ${farver.bold(preMinorBeta)}` },
      { value: "preminor-alpha", title: `pre-minor (alpha) ${farver.bold(preMinorAlpha)}` },
      { value: "premajor-beta", title: `pre-major (beta) ${farver.bold(preMajorBeta)}` },
      { value: "premajor-alpha", title: `pre-major (alpha) ${farver.bold(preMajorAlpha)}` },
    ];

    const prereleaseAnswer = await prompts({
      type: "autocomplete",
      name: "prerelease",
      message: `${pkg.name}: select prerelease strategy`,
      choices: prereleaseChoices,
      limit: prereleaseChoices.length,
      initial: 0,
    });

    if (!prereleaseAnswer.prerelease) {
      return null;
    }

    return prereleaseVersionByChoice[
      prereleaseAnswer.prerelease as keyof typeof prereleaseVersionByChoice
    ];
  }

  const prereleaseVersion = prereleaseVersionByChoice[
    answers.version as keyof typeof prereleaseVersionByChoice
  ];

  if (prereleaseVersion) {
    return prereleaseVersion;
  }

  return getNextVersion(pkg.version, answers.version as BumpKind);
}

export async function confirmOverridePrompt(pkg: WorkspacePackage, overrideVersion: string): Promise<"use" | "pick" | null> {
  const response = await prompts({
    type: "select",
    name: "choice",
    message: `${pkg.name}: use override version ${farver.bold(overrideVersion)}?`,
    choices: [
      { title: "use override", value: "use" },
      { title: "pick another version", value: "pick" },
    ],
    initial: 0,
  });

  if (!response.choice) {
    return null;
  }

  return response.choice;
}
