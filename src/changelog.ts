import type { GitCommit } from "commit-parser";
import type { VersionUpdate } from "./types";
import type { WorkspacePackage } from "./workspace";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { logger } from "./utils";

export interface ChangelogOptions {
  /**
   * Whether to generate changelogs
   * @default false
   */
  enabled?: boolean;

  /**
   * Transform function to customize the changelog content
   */
  transform?: (changelog: string, pkg: WorkspacePackage) => string | Promise<string>;

  /**
   * Repository information for generating links
   */
  repository?: {
    owner: string;
    repo: string;
  };
}

/**
 * Get section label for commit type
 */
function getSectionLabel(type: string): string {
  const labelMap: Record<string, string> = {
    feat: "Features",
    fix: "Bug Fixes",
    docs: "Documentation",
    style: "Styles",
    refactor: "Code Refactoring",
    perf: "Performance Improvements",
    test: "Tests",
    build: "Build System",
    ci: "Continuous Integration",
    chore: "Miscellaneous Chores",
    revert: "Reverts",
  };

  return labelMap[type] || "Other Changes";
}

/**
 * Generate changelog content from commits
 */
export function generateChangelog(
  pkg: WorkspacePackage,
  newVersion: string,
  commits: GitCommit[],
  previousVersion?: string,
  repository?: { owner: string; repo: string },
): string {
  const date = new Date().toISOString().split("T")[0];

  // Generate version header with compare link if repository provided
  let versionHeader = `## `;
  if (repository && previousVersion) {
    const compareUrl = `https://github.com/${repository.owner}/${repository.repo}/compare/${pkg.name}@${previousVersion}...${pkg.name}@${newVersion}`;
    versionHeader += `[${newVersion}](${compareUrl})`;
  } else {
    versionHeader += newVersion;
  }
  versionHeader += ` (${date})\n\n`;

  let changelog = versionHeader;

  // Group commits by type
  const grouped = new Map<string, GitCommit[]>();

  for (const commit of commits) {
    if (!commit.isConventional || !commit.type) {
      continue;
    }

    const type = commit.type;
    if (!grouped.has(type)) {
      grouped.set(type, []);
    }
    grouped.get(type)!.push(commit);
  }

  // Define display order
  const typeOrder = ["feat", "fix", "perf", "refactor", "docs", "test", "build", "ci", "chore", "revert", "style"];

  // Generate sections
  for (const type of typeOrder) {
    const commits = grouped.get(type);
    if (!commits || commits.length === 0) {
      continue;
    }

    const label = getSectionLabel(type);
    changelog += `### ${label}\n\n`;

    for (const commit of commits) {
      const scope = commit.scope ? `**${commit.scope}:** ` : "";
      const breaking = commit.isBreaking ? " **BREAKING CHANGE**" : "";

      let entry = `* ${scope}${commit.description}${breaking}`;

      // Add commit hash link if repository provided
      if (repository) {
        const commitUrl = `https://github.com/${repository.owner}/${repository.repo}/commit/${commit.shortHash}`;
        entry += ` ([${commit.shortHash}](${commitUrl}))`;
      } else {
        entry += ` (${commit.shortHash})`;
      }

      changelog += `${entry}\n`;
    }

    changelog += "\n";
  }

  return changelog.trim();
}

/**
 * Write changelog to package's CHANGELOG.md file
 */
export async function writeChangelog(
  pkg: WorkspacePackage,
  newContent: string,
  version: string,
): Promise<void> {
  const changelogPath = join(pkg.path, "CHANGELOG.md");
  let existingContent = "";

  // Read existing changelog if it exists
  if (existsSync(changelogPath)) {
    existingContent = await readFile(changelogPath, "utf-8");
  }

  let updatedContent: string;

  if (existingContent) {
    // Remove title if it exists
    const withoutTitle = existingContent.replace(/^# Changelog\n\n/, "");

    // Check if this version already exists in the changelog
    const versionHeaderRegex = new RegExp(`^## ${version.replace(/\./g, "\\.")}(\\s|$)`, "m");
    const hasVersion = versionHeaderRegex.test(withoutTitle);

    if (hasVersion) {
      // Replace existing version entry
      // Find the start of this version section and the next version section
      const versionSectionRegex = new RegExp(
        `^## ${version.replace(/\./g, "\\.")}[\\s\\S]*?(?=^## |$)`,
        "m",
      );
      const updated = withoutTitle.replace(versionSectionRegex, `${newContent}\n\n`);
      updatedContent = `# Changelog\n\n${updated}`;
    } else {
      // Prepend new version
      updatedContent = `# Changelog\n\n${newContent}\n\n${withoutTitle}`;
    }
  } else {
    updatedContent = `# Changelog\n\n${newContent}\n`;
  }

  await writeFile(changelogPath, updatedContent, "utf-8");
  logger.log(`Updated changelog: ${changelogPath}`);
}

/**
 * Generate and write changelogs for all updated packages
 */
export async function updateChangelogs(
  updates: VersionUpdate[],
  packageCommits: Map<string, GitCommit[]>,
  options?: ChangelogOptions,
): Promise<void> {
  if (!options?.enabled) {
    logger.log("Changelog generation is disabled");
    return;
  }

  logger.info("Generating changelogs...");

  for (const update of updates) {
    // Only generate changelog for packages with direct changes
    if (!update.hasDirectChanges) {
      continue;
    }

    const commits = packageCommits.get(update.package.name) || [];
    if (commits.length === 0) {
      continue;
    }

    let changelog = generateChangelog(
      update.package,
      update.newVersion,
      commits,
      update.currentVersion,
      options.repository,
    );

    // Apply transform if provided
    if (options.transform) {
      changelog = await options.transform(changelog, update.package);
    }

    logger.info(`Generating changelog for package ${update.package.name}`);
    await writeChangelog(update.package, changelog, update.newVersion);
  }
}
