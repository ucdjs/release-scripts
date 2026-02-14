import type { AuthorInfo, CommitTypeRule } from "#shared/types";
import type { GitCommit } from "commit-parser";
import type { NormalizedReleaseScriptsOptions } from "../options";
import type { GitHubClient } from "./github";
import type { WorkspacePackage } from "./workspace";
import { writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { buildTemplateGroups } from "#operations/changelog-format";
import { logger } from "#shared/utils";
import { Eta } from "eta";
import { DEFAULT_CHANGELOG_TEMPLATE } from "../options";
import { readFileFromGit } from "./git";

const excludeAuthors = [
  /\[bot\]/i,
  /dependabot/i,
  /\(bot\)/i,
];

export async function generateChangelogEntry(options: {
  packageName: string;
  version: string;
  previousVersion?: string;
  date: string;
  commits: GitCommit[];
  owner: string;
  repo: string;
  types: Record<string, CommitTypeRule>;
  template?: string;
  githubClient: GitHubClient;
}): Promise<string> {
  const {
    packageName,
    version,
    previousVersion,
    date,
    commits,
    owner,
    repo,
    types,
    template,
    githubClient,
  } = options;

  // Build compare URL
  const compareUrl = previousVersion
    ? `https://github.com/${owner}/${repo}/compare/${packageName}@${previousVersion}...${packageName}@${version}`
    : undefined;

  const commitAuthors = await resolveCommitAuthors(commits, githubClient);
  const templateGroups = buildTemplateGroups({
    commits,
    owner,
    repo,
    types,
    commitAuthors,
  });

  const templateData = {
    packageName,
    version,
    previousVersion,
    date,
    compareUrl,
    owner,
    repo,
    groups: templateGroups,
  };

  const eta = new Eta();
  const templateToUse = template || DEFAULT_CHANGELOG_TEMPLATE;

  return eta.renderString(templateToUse, templateData).trim();
}

export async function updateChangelog(options: {
  normalizedOptions: NormalizedReleaseScriptsOptions;
  workspacePackage: WorkspacePackage;
  version: string;
  previousVersion?: string;
  commits: GitCommit[];
  date: string;
  githubClient: GitHubClient;
}): Promise<void> {
  const {
    version,
    previousVersion,
    commits,
    date,
    normalizedOptions,
    workspacePackage,
    githubClient,
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
  const newEntry = await generateChangelogEntry({
    packageName: workspacePackage.name,
    version,
    previousVersion,
    date,
    commits,
    owner: normalizedOptions.owner!,
    repo: normalizedOptions.repo!,
    types: normalizedOptions.types,
    template: normalizedOptions.changelog?.template,
    githubClient,
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

async function resolveCommitAuthors(
  commits: GitCommit[],
  githubClient: GitHubClient,
): Promise<Map<string, AuthorInfo[]>> {
  const authorMap = new Map<string, AuthorInfo>();
  const commitAuthors = new Map<string, AuthorInfo[]>();

  for (const commit of commits) {
    const authorsForCommit: AuthorInfo[] = [];

    commit.authors.forEach((author, idx) => {
      if (!author.email || !author.name) {
        return;
      }

      if (excludeAuthors.some((re) => re.test(author.name))) {
        return;
      }

      if (!authorMap.has(author.email)) {
        authorMap.set(author.email, {
          commits: [],
          name: author.name,
          email: author.email,
        });
      }

      const info = authorMap.get(author.email)!;

      if (idx === 0) {
        info.commits.push(commit.shortHash);
      }

      authorsForCommit.push(info);
    });

    commitAuthors.set(commit.hash, authorsForCommit);
  }

  const authors = Array.from(authorMap.values());
  await Promise.all(authors.map((info) => githubClient.resolveAuthorInfo(info)));

  return commitAuthors;
}

// formatCommitLine moved to operations/changelog-format

export function parseChangelog(content: string) {
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
