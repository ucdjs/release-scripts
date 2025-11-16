import type { NormalizedReleaseOptions } from "#shared/options";
import type { GitCommit } from "commit-parser";
import type { WorkspacePackage } from "./workspace";
import { writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { logger } from "#shared/utils";
import { groupByType } from "commit-parser";
import { readFileFromGit } from "./git";
import { resolveAuthorInfo } from "./github";

export function generateChangelogEntry(options: {
  packageName: string;
  version: string;
  previousVersion?: string;
  date: string;
  commits: GitCommit[];
  owner: string;
  repo: string;
}): string {
  const { packageName, version, previousVersion, date, commits, owner, repo } = options;

  // Build version header
  let header: string;
  if (previousVersion) {
    const compareUrl = `https://github.com/${owner}/${repo}/compare/${packageName}@${previousVersion}...${packageName}@${version}`;
    header = `## [${version}](${compareUrl}) (${date})`;
  } else {
    header = `## ${version} (${date})`;
  }

  const lines: string[] = [header, ""];

  const grouped = groupByType(commits, {
    excludeKeys: [
      "chore",
      "test",
    ],
  });

  const typeToTitleMap: Record<string, string> = {
    feat: "Features",
    fix: "Bug Fixes",
    misc: "Miscellaneous",
    refactor: "Refactoring",
    perf: "Performance Improvements",
    docs: "Documentation",
    build: "Build System",
    ci: "Continuous Integration",
  };

  for (const key of grouped.keys()) {
    const commitsInGroup = grouped.get(key)!;
    if (commitsInGroup.length === 0) {
      logger.verbose(`No commits found for type ${key}, skipping section.`);
      continue;
    }

    logger.verbose(`Found ${commitsInGroup.length} commits for type ${key}.`);

    lines.push(`### ${typeToTitleMap[key] ?? key}`, "");
    for (const commit of commitsInGroup) {
      const commitUrl = `https://github.com/${owner}/${repo}/commit/${commit.hash}`;

      let line = `* ${commit.description}`;

      if (commit.references.length > 0) logger.verbose("Located references in commit", commit.references.length);

      // Append references (PRs, issues)
      for (const ref of commit.references) {
        if (!ref.value) continue;

        const number = Number.parseInt(ref.value.replace(/^#/, ""), 10);
        if (Number.isNaN(number)) continue;

        if (ref.type === "issue") {
          line += ` ([Issue ${ref.value}](https://github.com/${owner}/${repo}/issues/${number}))`;
          continue;
        }

        // Assume it's a PR
        line += ` ([PR ${ref.value}](https://github.com/${owner}/${repo}/pull/${number}))`;
      }

      line += ` ([${commit.shortHash}](${commitUrl}))`;

      // Append authors if available
      if (commit.authors.length > 0) {
        line += ` (by ${commit.authors.map((a) => a.name).join(", ")})`;
      }

      lines.push(line);
    }

    lines.push("");
  }

  // Remove trailing empty line
  if (lines[lines.length - 1] === "") {
    lines.pop();
  }

  return lines.join("\n");
}

export async function updateChangelog(options: {
  normalizedOptions: NormalizedReleaseOptions;
  workspacePackage: WorkspacePackage;
  version: string;
  previousVersion?: string;
  commits: GitCommit[];
  date: string;
}): Promise<void> {
  const {
    version,
    previousVersion,
    commits,
    date,
    normalizedOptions,
    workspacePackage,
  } = options;

  const changelogPath = join(workspacePackage.path, "CHANGELOG.md");

  const changelogRelativePath = relative(
    normalizedOptions.workspaceRoot,
    join(workspacePackage.path, "CHANGELOG.md"),
  );

  // Read the changelog from the default branch to get clean state without unreleased entries
  // This ensures that if a previous release PR was abandoned, we don't keep the old entry
  const existingContent = await readFileFromGit(
    normalizedOptions.workspaceRoot,
    normalizedOptions.branch.default,
    changelogRelativePath,
  );

  logger.verbose("Existing content found: ", Boolean(existingContent));

  // Generate the new changelog entry
  const newEntry = generateChangelogEntry({
    packageName: workspacePackage.name,
    version,
    previousVersion,
    date,
    commits,
    owner: normalizedOptions.owner!,
    repo: normalizedOptions.repo!,
  });

  let updatedContent: string;

  if (!existingContent) {
    updatedContent = `# ${workspacePackage.name}\n\n${newEntry}\n`;

    await writeFile(changelogPath, updatedContent, "utf-8");
    return;
  }

  const parsed = parseChangelog(existingContent);
  const lines = existingContent.split("\n");

  // Check if this version already exists
  const existingVersionIndex = parsed.versions.findIndex((v) => v.version === version);

  if (existingVersionIndex !== -1) {
    // Version exists - append new commits to it (PR update scenario)
    const existingVersion = parsed.versions[existingVersionIndex]!;

    // For now, just replace the entire version entry
    // TODO: In future, we could parse commits and only add new ones
    const before = lines.slice(0, existingVersion.lineStart);
    const after = lines.slice(existingVersion.lineEnd + 1);

    updatedContent = [...before, newEntry, ...after].join("\n");
  } else {
    // Version doesn't exist - insert new entry at top (below package header)
    const insertAt = parsed.headerLineEnd + 1;

    const before = lines.slice(0, insertAt);
    const after = lines.slice(insertAt);

    // Add empty line after header if needed
    if (before.length > 0 && before[before.length - 1] !== "") {
      before.push("");
    }

    updatedContent = [...before, newEntry, "", ...after].join("\n");
  }

  // Write updated content back
  await writeFile(changelogPath, updatedContent, "utf-8");
}

function parseChangelog(content: string) {
  const lines = content.split("\n");

  let packageName: string | null = null;

  // We need to start at -1, since some changelogs might not have a package name header
  // which will cause us to miss the first version entry otherwise.
  let headerLineEnd = -1;
  const versions: {
    version: string;
    lineStart: number;
    lineEnd: number;
    content: string;
  }[] = [];

  // Extract package name from first heading (# @package/name)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();

    if (line.startsWith("# ")) {
      packageName = line.slice(2).trim();
      headerLineEnd = i;
      break;
    }
  }

  // Find all version entries (## version or ## [version](link))
  for (let i = headerLineEnd + 1; i < lines.length; i++) {
    const line = lines[i]!.trim();

    if (line.startsWith("## ")) {
      // Extract version from various formats:
      // ## 0.1.0
      // ## [0.1.0](link) (date)
      // ## <small>0.1.0</small>
      const versionMatch = line.match(/##\s+(?:<small>)?\[?([^\](\s<]+)/);

      if (versionMatch) {
        const version = versionMatch[1]!;
        const lineStart = i;

        // Find where this version entry ends (next ## or end of file)
        let lineEnd = lines.length - 1;
        for (let j = i + 1; j < lines.length; j++) {
          if (lines[j]!.trim().startsWith("## ")) {
            lineEnd = j - 1;
            break;
          }
        }

        const versionContent = lines.slice(lineStart, lineEnd + 1).join("\n");

        versions.push({
          version,
          lineStart,
          lineEnd,
          content: versionContent,
        });
      }
    }
  }

  return {
    packageName,
    versions,
    headerLineEnd,
  };
}
