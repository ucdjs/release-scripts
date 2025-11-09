import type { BumpKind } from "./types";
import type { WorkspacePackage } from "./workspace";
import farver from "farver";
import prompts from "prompts";
import { logger } from "./utils";
import { getNextVersion } from "./version";

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
  pkg: WorkspacePackage,
  suggestedVersion: string,
) {
  const answers = await prompts([
    {
      type: "autocomplete",
      name: "version",
      message: `${pkg.name}: ${farver.green(pkg.version)}`,
      choices: [
        { value: "major", title: `major ${farver.bold(getNextVersion(pkg.version, "major"))}` },
        { value: "minor", title: `minor ${farver.bold(getNextVersion(pkg.version, "minor"))}` },
        { value: "patch", title: `patch ${farver.bold(getNextVersion(pkg.version, "patch"))}` },

        { value: "suggested", title: `suggested ${farver.bold(suggestedVersion)}` },

        { value: "custom", title: "custom" },
      ],
      initial: "suggested",
    },
    {
      type: (prev) => prev === "custom" ? "text" : null,
      name: "custom",
      message: "Enter the new version number:",
      initial: suggestedVersion,
      validate: (custom: string) => {
        const semverRegex = /^\d+\.\d+\.\d+(?:[-+].+)?$/;
        return semverRegex.test(custom) ? true : "That's not a valid version number";
      },
    },
  ]);

  logger.log(answers);

  throw new Error("Not implemented yet");
}

export interface VersionOverride {
  packageName: string;
  newVersion: string;
}

export async function promptVersionOverride(
  pkg: WorkspacePackage,
  workspaceRoot: string,
  currentVersion: string,
  suggestedVersion: string,
  suggestedBumpType: BumpKind,
): Promise<string> {
  const choices = [
    {
      title: `Use suggested: ${suggestedVersion} (${suggestedBumpType})`,
      value: "suggested",
    },
  ];

  // Add other bump type options if they differ from suggested
  const bumpTypes: BumpKind[] = ["patch", "minor", "major"];
  for (const bumpType of bumpTypes) {
    if (bumpType !== suggestedBumpType) {
      const version = getNextVersion(currentVersion, bumpType);
      choices.push({
        title: `${bumpType}: ${version}`,
        value: bumpType,
      });
    }
  }

  choices.push({
    title: "Custom version",
    value: "custom",
  });

  const response = await prompts([
    {
      type: "select",
      name: "choice",
      message: `${pkg.name} (${currentVersion}):`,
      choices,
      initial: 0,
    },
    {
      type: (prev) => (prev === "custom" ? "text" : null),
      name: "customVersion",
      message: "Enter custom version:",
      initial: suggestedVersion,
      validate: (value) => {
        const semverRegex = /^\d+\.\d+\.\d+(?:[-+].+)?$/;
        return semverRegex.test(value) || "Invalid semver version (e.g., 1.0.0)";
      },
    },
  ]);

  if (response.choice === "suggested") {
    return suggestedVersion;
  } else if (response.choice === "custom") {
    return response.customVersion;
  } else {
    // It's a bump type
    return getNextVersion(currentVersion, response.choice as BumpKind);
  }
}

export async function promptVersionOverrides(
  packages: Array<{
    package: WorkspacePackage;
    currentVersion: string;
    suggestedVersion: string;
    bumpType: BumpKind;
  }>,
  workspaceRoot: string,
): Promise<Map<string, string>> {
  const overrides = new Map<string, string>();

  for (const item of packages) {
    const newVersion = await promptVersionOverride(
      item.package,
      workspaceRoot,
      item.currentVersion,
      item.suggestedVersion,
      item.bumpType,
    );

    overrides.set(item.package.name, newVersion);
  }

  return overrides;
}
