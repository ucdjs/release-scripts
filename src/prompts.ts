import type { BumpKind, WorkspacePackage } from "./types";
import prompts from "prompts";
import { calculateNewVersion } from "./version";

export async function promptPackageSelection(
  packages: WorkspacePackage[],
): Promise<string[]> {
  const response = await prompts({
    type: "multiselect",
    name: "selectedPackages",
    message: "Select packages to release",
    choices: packages.map((pkg) => ({
      title: `${pkg.name} (${pkg.version})`,
      value: pkg.name,
      selected: true,
    })),
    min: 1,
    hint: "Space to select/deselect. Return to submit.",
  });

  if (!response.selectedPackages || response.selectedPackages.length === 0) {
    throw new Error("No packages selected");
  }

  return response.selectedPackages;
}

export interface VersionOverride {
  packageName: string;
  newVersion: string;
}

export async function promptVersionOverride(
  packageName: string,
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
      const version = calculateNewVersion(currentVersion, bumpType);
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
      message: `${packageName} (${currentVersion}):`,
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
    return calculateNewVersion(currentVersion, response.choice as BumpKind);
  }
}

export async function promptVersionOverrides(
  packages: Array<{
    name: string;
    currentVersion: string;
    suggestedVersion: string;
    bumpType: BumpKind;
  }>,
): Promise<Map<string, string>> {
  const overrides = new Map<string, string>();

  for (const pkg of packages) {
    const newVersion = await promptVersionOverride(
      pkg.name,
      pkg.currentVersion,
      pkg.suggestedVersion,
      pkg.bumpType,
    );

    overrides.set(pkg.name, newVersion);
  }

  return overrides;
}
