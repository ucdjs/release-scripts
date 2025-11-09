import type { GitCommit } from "commit-parser";
import type { BumpKind, WorkspacePackage } from "./types";
import prompts from "prompts";
import { getPackageCommits } from "./commits";
import { calculateNewVersion } from "./version";

interface GroupedCommits {
  feat: GitCommit[];
  fix: GitCommit[];
  perf: GitCommit[];
  chore: GitCommit[];
  docs: GitCommit[];
  style: GitCommit[];
  refactor: GitCommit[];
  test: GitCommit[];
  build: GitCommit[];
  ci: GitCommit[];
  revert: GitCommit[];
  other: GitCommit[];
}

/**
 * Get commits for a package grouped by conventional commit type
 *
 * @param pkg - The workspace package
 * @param workspaceRoot - Root directory of the workspace
 * @param limit - Maximum number of commits to return (default: 10)
 * @returns Commits grouped by type
 */
export async function getCommitsForPackage(
  pkg: WorkspacePackage,
  workspaceRoot: string,
  limit = 10,
): Promise<GroupedCommits> {
  const commits = await getPackageCommits(pkg, workspaceRoot);

  // Limit commits
  const limitedCommits = commits.slice(0, limit);

  // Group by type
  const grouped: GroupedCommits = {
    feat: [],
    fix: [],
    perf: [],
    chore: [],
    docs: [],
    style: [],
    refactor: [],
    test: [],
    build: [],
    ci: [],
    revert: [],
    other: [],
  };

  for (const commit of limitedCommits) {
    if (commit.type && commit.type in grouped) {
      grouped[commit.type as keyof GroupedCommits].push(commit);
    } else {
      grouped.other.push(commit);
    }
  }

  return grouped;
}

/**
 * Format grouped commits into a readable string
 */
function formatCommitGroups(grouped: GroupedCommits): string {
  const lines: string[] = [];

  const typeLabels: Record<keyof GroupedCommits, string> = {
    feat: "Features",
    fix: "Bug Fixes",
    perf: "Performance",
    chore: "Chores",
    docs: "Documentation",
    style: "Styling",
    refactor: "Refactoring",
    test: "Tests",
    build: "Build",
    ci: "CI",
    revert: "Reverts",
    other: "Other",
  };

  const typeOrder: (keyof GroupedCommits)[] = [
    "feat",
    "fix",
    "perf",
    "refactor",
    "test",
    "docs",
    "style",
    "build",
    "ci",
    "chore",
    "revert",
    "other",
  ];

  for (const type of typeOrder) {
    const commits = grouped[type];
    if (commits.length > 0) {
      lines.push(`\n${typeLabels[type]}:`);
      for (const commit of commits) {
        const scope = commit.scope ? `(${commit.scope})` : "";
        const breaking = commit.isBreaking ? " ⚠️  BREAKING" : "";
        lines.push(`  • ${commit.type}${scope}: ${commit.message}${breaking}`);
      }
    }
  }

  return lines.join("\n");
}

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
  pkg: WorkspacePackage,
  workspaceRoot: string,
  currentVersion: string,
  suggestedVersion: string,
  suggestedBumpType: BumpKind,
): Promise<string> {
  // Get and display commits for this package
  const commits = await getCommitsForPackage(pkg, workspaceRoot);
  const commitSummary = formatCommitGroups(commits);

  if (commitSummary.trim()) {
    console.log(`\nRecent changes in ${pkg.name}:${commitSummary}\n`);
  }
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
    return calculateNewVersion(currentVersion, response.choice as BumpKind);
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
