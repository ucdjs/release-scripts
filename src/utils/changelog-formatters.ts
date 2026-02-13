import type { GitCommit } from "./helpers";
import { Eta } from "eta";

const eta = new Eta();

export interface ChangelogEntry {
  type: string;
  scope?: string;
  description: string;
  breaking: boolean;
  hash: string;
  shortHash: string;
  references: Array<{ type: string; value: string }>;
  authors: Array<{ name: string; email: string; profile?: string }>;
}

export interface PackageChangelog {
  packageName: string;
  version: string;
  previousVersion: string;
  entries: ChangelogEntry[];
  repo?: string;
}

/**
 * Pure function to parse commits into changelog entries
 */
export function parseCommits(commits: readonly GitCommit[]): ChangelogEntry[] {
  return commits
    .filter((commit) => commit.isConventional)
    .filter((commit) => commit.type !== "chore")
    .map((commit) => ({
      type: commit.type || "other",
      scope: commit.scope,
      description: commit.description,
      breaking: commit.isBreaking || false,
      hash: commit.hash,
      shortHash: commit.shortHash,
      references: commit.references.map((ref) => ({
        type: ref.type,
        value: ref.value,
      })),
      authors: commit.authors.map((author) => ({
        name: author.name,
        email: author.email,
        profile: author.profile,
      })),
    }));
}

/**
 * Pure function to group changelog entries by type
 */
export function groupByType(entries: ChangelogEntry[]): Map<string, ChangelogEntry[]> {
  const groups = new Map<string, ChangelogEntry[]>();

  for (const entry of entries) {
    const type = entry.breaking ? "breaking" : entry.type;
    if (!groups.has(type)) {
      groups.set(type, []);
    }
    groups.get(type)!.push(entry);
  }

  return groups;
}

/**
 * Changelog template for Eta rendering
 */
export const CHANGELOG_ENTRY_TEMPLATE = `## <%= it.version %>

<% if (it.entries.length === 0) { %>
*No conventional commits found.*
<% } else { %>
<% const groups = it.groupedEntries; %>
<% const typeOrder = ["breaking", "feat", "fix", "perf", "docs", "style", "refactor", "test", "build", "ci", "chore"]; %>
<% const typeLabels = {
  breaking: "💥 Breaking Changes",
  feat: "🚀 Features",
  fix: "🐞 Bug Fixes",
  perf: "⚡ Performance",
  docs: "Documentation",
  style: "Styling",
  refactor: "Refactoring",
  test: "Tests",
  build: "Build",
  ci: "CI",
  chore: "Chores"
}; %>

<% const formatAuthor = (entry) => {
  const author = entry.authors && entry.authors.length > 0 ? entry.authors[0] : null;
  if (!author) return "unknown";
  if (author.profile && author.profile.includes("github.com/")) {
    const username = author.profile.split("github.com/")[1];
    return "@" + username;
  }
  return author.name || "unknown";
}; %>

<% const commitUrl = (hash) => it.repo ? "https://github.com/" + it.repo + "/commit/" + hash : ""; %>

<% const formatLine = (entry) => {
  const authorText = formatAuthor(entry);
  const commitLink = commitUrl(entry.hash);
  const hashPart = commitLink
    ? " [<samp>(" + entry.shortHash + ")</samp>](" + commitLink + ")"
    : " <samp>(" + entry.shortHash + ")</samp>";
  return entry.description + " &nbsp;-&nbsp; by " + authorText + hashPart;
}; %>

<% for (const type of typeOrder) { %>
<% const entries = groups.get(type); %>
<% if (entries && entries.length > 0) { %>
### &nbsp;&nbsp;&nbsp;<%= typeLabels[type] || type.charAt(0).toUpperCase() + type.slice(1) %>

<% const unscoped = entries.filter(e => !e.scope); %>
<% const scoped = entries.filter(e => e.scope); %>

<% for (const entry of unscoped) { %>
- <%= formatLine(entry) %>
<% } %>

<% const scopes = [...new Set(scoped.map(e => e.scope))]; %>
<% for (const scope of scopes) { %>
- **<%= scope %>**:
  <% const scopeEntries = scoped.filter(e => e.scope === scope); %>
  <% for (const entry of scopeEntries) { %>
  - <%= formatLine(entry) %>
  <% } %>
<% } %>

<% } %>
<% } %>

<% for (const [type, entries] of groups) { %>
<% if (!typeOrder.includes(type)) { %>
### &nbsp;&nbsp;&nbsp;<%= type.charAt(0).toUpperCase() + type.slice(1) %>

<% for (const entry of entries) { %>
- <%= formatLine(entry) %>
<% } %>

<% } %>
<% } %>

<% if (it.repo) { %>
##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/<%= it.repo %>/compare/v<%= it.previousVersion %>...v<%= it.version %>)
<% } %>
<% } %>`;

/**
 * Pure function to format changelog as markdown
 */
export function formatChangelogEntryMarkdown(changelog: PackageChangelog): string {
  const groups = groupByType(changelog.entries);

  return eta.renderString(CHANGELOG_ENTRY_TEMPLATE, {
    packageName: changelog.packageName,
    version: changelog.version,
    previousVersion: changelog.previousVersion,
    entries: changelog.entries,
    groupedEntries: groups,
    repo: changelog.repo,
  });
}

export function appendChangelogEntry(
  existingContent: string | null,
  changelogEntry: string,
  packageName: string,
): string {
  const entry = changelogEntry.trim();
  if (!entry) {
    return existingContent ?? `# ${packageName}\n`;
  }

  if (!existingContent || existingContent.trim() === "") {
    return `# ${packageName}\n\n${entry}\n`;
  }

  const lines = existingContent.split("\n");
  const firstLine = lines[0]?.trim() ?? "";

  if (!firstLine.startsWith("# ")) {
    const trimmed = existingContent.trim();
    return `# ${packageName}\n\n${entry}\n\n${trimmed}\n`;
  }

  let insertIndex = 1;
  while (insertIndex < lines.length && lines[insertIndex]?.trim() === "") {
    insertIndex++;
  }

  const rest = lines.slice(insertIndex).join("\n").trim();
  if (rest) {
    return `${firstLine}\n\n${entry}\n\n${rest}\n`;
  }

  return `${firstLine}\n\n${entry}\n`;
}

/**
 * Pure function to create a changelog object
 */
export function createChangelog(
  packageName: string,
  version: string,
  previousVersion: string,
  commits: readonly GitCommit[],
  repo?: string,
): PackageChangelog {
  const entries = parseCommits(commits);

  return {
    packageName,
    version,
    previousVersion,
    entries,
    repo,
  };
}
