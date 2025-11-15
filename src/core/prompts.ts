import type { WorkspacePackage } from "#core/workspace";
import type { BumpKind } from "#shared/types";
import { getNextVersion, isValidSemver } from "#versioning/version";
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

export interface VersionOverride {
  packageName: string;
  newVersion: string;
}

export async function selectVersionPrompt(
  workspaceRoot: string,
  pkg: WorkspacePackage,
  currentVersion: string,
  suggestedVersion: string,
): Promise<string | null> {
  const answers = await prompts([
    {
      type: "autocomplete",
      name: "version",
      message: `${pkg.name}: ${farver.green(pkg.version)}`,
      choices: [
        { value: "skip", title: `skip ${farver.dim("(no change)")}` },
        { value: "major", title: `major ${farver.bold(getNextVersion(pkg.version, "major"))}` },
        { value: "minor", title: `minor ${farver.bold(getNextVersion(pkg.version, "minor"))}` },
        { value: "patch", title: `patch ${farver.bold(getNextVersion(pkg.version, "patch"))}` },

        { value: "suggested", title: `suggested ${farver.bold(suggestedVersion)}` },

        { value: "custom", title: "custom" },
      ],
      initial: suggestedVersion === currentVersion ? 0 : 4, // Default to "skip" if no change, otherwise "suggested"
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
  } else {
    // It's a bump type
    return getNextVersion(pkg.version, answers.version as BumpKind);
  }
}
