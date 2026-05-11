import type { WorkspacePackage } from "./workspace";
import {
  getNextPrereleaseVersion,
  getNextStableVersion,
  getPrereleaseIdentifier,
  isValidSemver,
} from "../shared/semver";
import type { BumpKind } from "../shared/types";
import { Context, Effect, Layer } from "effect";
import farver from "farver";
import prompts from "prompts";
import semver from "semver";

export interface PromptServiceShape {
  readonly selectPackagePrompt: (packages: WorkspacePackage[]) => Effect.Effect<string[], unknown>;
  readonly selectVersionPrompt: (
    workspaceRoot: string,
    pkg: WorkspacePackage,
    currentVersion: string,
    suggestedVersion: string,
    options?: {
      defaultChoice?: "auto" | "skip" | "suggested" | "as-is";
      suggestedHint?: string;
    },
  ) => Effect.Effect<string | null, unknown>;
  readonly confirmOverridePrompt: (
    pkg: WorkspacePackage,
    overrideVersion: string,
  ) => Effect.Effect<"use" | "pick" | null, unknown>;
}

export class PromptService extends Context.Service<PromptService, PromptServiceShape>()(
  "@ucdjs/release-scripts/PromptService",
) {}

// oxlint-disable-next-line require-yield
export const makePromptService = Effect.fn("makePromptService")(function* () {
  const selectPackagePrompt: PromptServiceShape["selectPackagePrompt"] = Effect.fn(
    "selectPackagePrompt",
  )(function* (packages) {
    const response = yield* Effect.tryPromise(() =>
      prompts({
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
      }),
    );

    if (!response.selectedPackages || response.selectedPackages.length === 0) {
      return [];
    }

    return response.selectedPackages;
  });

  const selectVersionPrompt: PromptServiceShape["selectVersionPrompt"] = Effect.fn(
    "selectVersionPrompt",
  )(function* (workspaceRoot, pkg, currentVersion, suggestedVersion, options) {
    const defaultChoice = options?.defaultChoice ?? "auto";
    const suggestedSuffix = options?.suggestedHint ? farver.dim(` (${options.suggestedHint})`) : "";
    const prereleaseIdentifier = getPrereleaseIdentifier(currentVersion);
    const defaultPrereleaseId =
      prereleaseIdentifier === "alpha" || prereleaseIdentifier === "beta"
        ? prereleaseIdentifier
        : "beta";

    const nextDefaultPrerelease = getNextPrereleaseVersion(
      currentVersion,
      "next",
      defaultPrereleaseId,
    );
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
        ? [
            {
              value: "next-prerelease",
              title: `next prerelease ${farver.bold(nextDefaultPrerelease)}`,
            },
          ]
        : []),
      { value: "patch", title: `patch ${farver.bold(getNextStableVersion(pkg.version, "patch"))}` },
      { value: "minor", title: `minor ${farver.bold(getNextStableVersion(pkg.version, "minor"))}` },
      { value: "major", title: `major ${farver.bold(getNextStableVersion(pkg.version, "major"))}` },
      { value: "prerelease", title: `prerelease ${farver.dim("(choose strategy)")}` },
      { value: "custom", title: "custom" },
    ];

    const initialValue =
      defaultChoice === "auto"
        ? suggestedVersion === currentVersion
          ? "skip"
          : "suggested"
        : defaultChoice;
    const initial = Math.max(0, choices.findIndex((choice) => choice.value === initialValue));

    const prereleaseVersionByChoice = {
      "next-prerelease": nextDefaultPrerelease,
      next: nextDefaultPrerelease,
      "next-beta": nextBeta,
      "next-alpha": nextAlpha,
      "prepatch-beta": prePatchBeta,
      "preminor-beta": preMinorBeta,
      "premajor-beta": preMajorBeta,
      "prepatch-alpha": prePatchAlpha,
      "preminor-alpha": preMinorAlpha,
      "premajor-alpha": preMajorAlpha,
    } as const;

    const answers = yield* Effect.tryPromise(() =>
      prompts({
        type: "autocomplete",
        name: "version",
        message: `${pkg.name}: ${farver.green(pkg.version)}`,
        choices,
        limit: choices.length,
        initial,
      }),
    );

    if (!answers.version) {
      return null;
    }

    if (answers.version === "skip") {
      return null;
    }
    if (answers.version === "suggested") {
      return suggestedVersion;
    }
    if (answers.version === "custom") {
      const customAnswer = yield* Effect.tryPromise(() =>
        prompts({
          type: "text",
          name: "custom",
          message: "Enter the new version number:",
          initial: suggestedVersion,
          validate: (custom: string) => {
            if (!isValidSemver(custom)) {
              return "That's not a valid version number";
            }
            if (!isValidSemver(currentVersion)) {
              return `Current version "${currentVersion}" is not valid semver — cannot compare`;
            }
            if (!semver.gt(custom, currentVersion)) {
              return `Version must be greater than the current version (${currentVersion})`;
            }
            return true;
          },
        }),
      );

      if (!customAnswer.custom) {
        return null;
      }

      return customAnswer.custom;
    }
    if (answers.version === "as-is") {
      return currentVersion;
    }
    if (answers.version === "prerelease") {
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

      const prereleaseAnswer = yield* Effect.tryPromise(() =>
        prompts({
          type: "autocomplete",
          name: "prerelease",
          message: `${pkg.name}: select prerelease strategy`,
          choices: prereleaseChoices,
          limit: prereleaseChoices.length,
          initial: 0,
        }),
      );

      if (!prereleaseAnswer.prerelease) {
        return null;
      }

      return prereleaseVersionByChoice[
        prereleaseAnswer.prerelease as keyof typeof prereleaseVersionByChoice
      ];
    }

    const prereleaseVersion =
      prereleaseVersionByChoice[answers.version as keyof typeof prereleaseVersionByChoice];

    if (prereleaseVersion) {
      return prereleaseVersion;
    }

    const stableBump = answers.version as Exclude<BumpKind, "none">;
    return getNextStableVersion(pkg.version, stableBump);
  });

  const confirmOverridePrompt: PromptServiceShape["confirmOverridePrompt"] = Effect.fn(
    "confirmOverridePrompt",
  )(function* (pkg, overrideVersion) {
    const response = yield* Effect.tryPromise(() =>
      prompts({
        type: "select",
        name: "choice",
        message: `${pkg.name}: use override version ${farver.bold(overrideVersion)}?`,
        choices: [
          { title: "use override", value: "use" },
          { title: "pick another version", value: "pick" },
        ],
        initial: 0,
      }),
    );

    if (!response.choice) {
      return null;
    }

    return response.choice;
  });

  return PromptService.of({
    selectPackagePrompt,
    selectVersionPrompt,
    confirmOverridePrompt,
  });
});

export const PromptServiceLive = Layer.effect(PromptService, makePromptService());
