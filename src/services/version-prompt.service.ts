/* eslint-disable no-console */
import type { GitCommit, WorkspacePackageWithCommits } from "../utils/helpers";
import type { BumpKind } from "./package-updater.service";
import { Effect } from "effect";
import prompts from "prompts";
import semver from "semver";
import { ReleaseScriptsOptions } from "../options";

const GREY = "\x1B[90m";
const RESET = "\x1B[0m";

const NON_VERSIONING_TYPES = new Set([
  "chore",
  "docs",
  "style",
  "test",
  "ci",
  "build",
  "refactor",
]);

function isVersioningCommit(commit: GitCommit): boolean {
  return !NON_VERSIONING_TYPES.has(commit.type) || commit.isBreaking;
}

export interface VersionPromptResult {
  newVersion: string;
  bumpType: BumpKind;
  applyToAllRemaining: boolean;
}

function formatCommit(commit: GitCommit): string {
  const isGreyed = !isVersioningCommit(commit);
  const scope = commit.scope ? `(${commit.scope})` : "";
  const description = commit.isConventional
    ? commit.description
    : (commit.message.split("\n")[0] ?? commit.message);

  const line = `${commit.shortHash}  ${commit.type.padEnd(12)}${scope.padEnd(10)}: ${description}`;

  return isGreyed ? `${GREY}${line}${RESET}` : line;
}

function formatCommits(commits: readonly GitCommit[]): string {
  if (commits.length === 0) {
    return "  No commits since the last version";
  }

  const lines = commits
    .slice(0, 10)
    .map((c) => `  ${formatCommit(c)}`);

  if (commits.length > 10) {
    lines.push(`  ${GREY}... and ${commits.length - 10} more${RESET}`);
  }

  return lines.join("\n");
}

function getPrereleaseInfo(version: string): { identifier: string; baseVersion: string } | null {
  const parsed = semver.parse(version);
  if (!parsed) return null;

  if (parsed.prerelease.length === 0) {
    return null;
  }

  const identifier = String(parsed.prerelease[0]);
  return { identifier, baseVersion: `${parsed.major}.${parsed.minor}.${parsed.patch}` };
}

function generateVersionOptions(
  currentVersion: string,
  conventionalBump: BumpKind,
  prereleaseInfo: { identifier: string } | null,
): Array<{ title: string; value: { version: string; bumpType: BumpKind } }> {
  const options: Array<{ title: string; value: { version: string; bumpType: BumpKind } }> = [];

  const majorVersion = semver.inc(currentVersion, "major");
  const minorVersion = semver.inc(currentVersion, "minor");
  const patchVersion = semver.inc(currentVersion, "patch");

  if (majorVersion) {
    options.push({
      title: `major ${majorVersion}`,
      value: { version: majorVersion, bumpType: "major" },
    });
  }

  if (minorVersion) {
    options.push({
      title: `minor ${minorVersion}`,
      value: { version: minorVersion, bumpType: "minor" },
    });
  }

  if (patchVersion) {
    options.push({
      title: `patch ${patchVersion}`,
      value: { version: patchVersion, bumpType: "patch" },
    });
  }

  if (prereleaseInfo) {
    const nextPrerelease = semver.inc(currentVersion, "prerelease", prereleaseInfo.identifier);
    if (nextPrerelease) {
      options.push({
        title: `next ${nextPrerelease}`,
        value: { version: nextPrerelease, bumpType: "patch" },
      });
    }
  }

  const conventionalVersion = conventionalBump !== "none"
    ? semver.inc(currentVersion, conventionalBump)
    : null;

  if (conventionalVersion) {
    options.push({
      title: `conventional ${conventionalVersion}`,
      value: { version: conventionalVersion, bumpType: conventionalBump },
    });
  }

  if (prereleaseInfo) {
    const prePatch = semver.inc(currentVersion, "prepatch", prereleaseInfo.identifier);
    const preMinor = semver.inc(currentVersion, "preminor", prereleaseInfo.identifier);
    const preMajor = semver.inc(currentVersion, "premajor", prereleaseInfo.identifier);

    if (prePatch) {
      options.push({
        title: `pre-patch ${prePatch}`,
        value: { version: prePatch, bumpType: "patch" },
      });
    }

    if (preMinor) {
      options.push({
        title: `pre-minor ${preMinor}`,
        value: { version: preMinor, bumpType: "minor" },
      });
    }

    if (preMajor) {
      options.push({
        title: `pre-major ${preMajor}`,
        value: { version: preMajor, bumpType: "major" },
      });
    }
  } else {
    const betaPatch = semver.inc(currentVersion, "prepatch", "beta");
    const betaMinor = semver.inc(currentVersion, "preminor", "beta");
    const betaMajor = semver.inc(currentVersion, "premajor", "beta");

    if (betaPatch) {
      options.push({
        title: `pre-patch ${betaPatch}`,
        value: { version: betaPatch, bumpType: "patch" },
      });
    }

    if (betaMinor) {
      options.push({
        title: `pre-minor ${betaMinor}`,
        value: { version: betaMinor, bumpType: "minor" },
      });
    }

    if (betaMajor) {
      options.push({
        title: `pre-major ${betaMajor}`,
        value: { version: betaMajor, bumpType: "major" },
      });
    }
  }

  options.push({
    title: `as-is ${currentVersion}`,
    value: { version: currentVersion, bumpType: "none" },
  });

  options.push({
    title: "custom ...",
    value: { version: "custom", bumpType: "none" },
  });

  return options;
}

function findDefaultIndex(
  options: Array<{ title: string; value: { version: string; bumpType: BumpKind } }>,
  conventionalBump: BumpKind,
): number {
  if (conventionalBump === "none") {
    return 0;
  }

  const conventionalIndex = options.findIndex(
    (o) => o.title.startsWith("conventional"),
  );

  return conventionalIndex >= 0 ? conventionalIndex : 0;
}

async function promptForCustomVersion(currentVersion: string): Promise<string | null> {
  const response = await prompts({
    type: "text",
    name: "version",
    message: `Enter custom version (current: ${currentVersion})`,
    validate: (input: string) => {
      const parsed = semver.valid(input);
      if (!parsed) {
        return "Please enter a valid semver version (e.g., 1.2.3)";
      }
      return true;
    },
  });

  return response.version || null;
}

export class VersionPromptService extends Effect.Service<VersionPromptService>()(
  "@ucdjs/release-scripts/VersionPromptService",
  {
    effect: Effect.gen(function* () {
      const config = yield* ReleaseScriptsOptions;

      let applyToAllRemainingChoice: { version: string; bumpType: BumpKind } | null = null;

      function promptForVersion(
        pkg: WorkspacePackageWithCommits,
        conventionalBump: BumpKind,
        remainingCount: number,
      ) {
        return Effect.async<VersionPromptResult, never, never>((resume) => {
          const allCommits = [...pkg.commits, ...pkg.globalCommits];
          const prereleaseInfo = getPrereleaseInfo(pkg.version);

          const commitCount = allCommits.length;
          console.log("");
          console.log(`${commitCount} commit${commitCount === 1 ? "" : "s"} since the last version:`);
          console.log(formatCommits(allCommits));
          console.log("");

          if (applyToAllRemainingChoice) {
            const result: VersionPromptResult = {
              newVersion: applyToAllRemainingChoice.version === "custom"
                ? pkg.version
                : applyToAllRemainingChoice.version,
              bumpType: applyToAllRemainingChoice.bumpType,
              applyToAllRemaining: false,
            };
            resume(Effect.succeed(result));
            return;
          }

          const options = generateVersionOptions(pkg.version, conventionalBump, prereleaseInfo);
          const defaultIndex = findDefaultIndex(options, conventionalBump);

          if (remainingCount > 1) {
            options.push({
              title: "apply-to-all ›",
              value: { version: "apply-to-all", bumpType: "none" },
            });
          }

          prompts({
            type: "select",
            name: "choice",
            message: `Current version ${pkg.version}`,
            choices: options.map((o) => ({
              title: o.title,
              value: o.value,
            })),
            initial: defaultIndex,
            hint: "Use arrow keys to navigate, enter to select",
          }).then(async (response) => {
            if (!response.choice) {
              const result: VersionPromptResult = {
                newVersion: pkg.version,
                bumpType: "none",
                applyToAllRemaining: false,
              };
              resume(Effect.succeed(result));
              return;
            }

            if (response.choice.version === "apply-to-all") {
              const applyOptions = options.filter(
                (o) => o.value.version !== "custom" && o.value.version !== "apply-to-all",
              );

              const applyResponse = await prompts({
                type: "select",
                name: "choice",
                message: `Apply to all ${remainingCount} remaining packages`,
                choices: applyOptions.map((o) => ({
                  title: o.title,
                  value: o.value,
                })),
                initial: findDefaultIndex(applyOptions, conventionalBump),
              });

              if (applyResponse.choice) {
                if (applyResponse.choice.version === "custom") {
                  const customVersion = await promptForCustomVersion(pkg.version);
                  if (customVersion) {
                    applyToAllRemainingChoice = { version: customVersion, bumpType: applyResponse.choice.bumpType };
                  }
                } else {
                  applyToAllRemainingChoice = applyResponse.choice;
                }

                const result: VersionPromptResult = {
                  newVersion: applyToAllRemainingChoice?.version || pkg.version,
                  bumpType: applyToAllRemainingChoice?.bumpType || "none",
                  applyToAllRemaining: true,
                };
                resume(Effect.succeed(result));
              } else {
                promptForVersion(pkg, conventionalBump, remainingCount).pipe(
                  Effect.runPromise,
                ).then((r) => resume(Effect.succeed(r)));
              }
              return;
            }

            let selectedVersion = response.choice.version;
            let selectedBumpType = response.choice.bumpType;

            if (selectedVersion === "custom") {
              const customVersion = await promptForCustomVersion(pkg.version);
              if (customVersion) {
                selectedVersion = customVersion;
              } else {
                selectedVersion = pkg.version;
                selectedBumpType = "none";
              }
            }

            const result: VersionPromptResult = {
              newVersion: selectedVersion,
              bumpType: selectedBumpType,
              applyToAllRemaining: false,
            };
            resume(Effect.succeed(result));
          });
        });
      }

      return {
        promptForVersion,
        isEnabled: config.prompts.versions,
        resetApplyToAll: () => {
          applyToAllRemainingChoice = null;
        },
      } as const;
    }),
    dependencies: [],
  },
) {}
