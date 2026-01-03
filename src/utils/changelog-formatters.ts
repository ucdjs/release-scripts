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
}

export interface PackageChangelog {
  packageName: string;
  version: string;
  previousVersion: string;
  entries: ChangelogEntry[];
}

/**
 * Pure function to parse commits into changelog entries
 */
export function parseCommits(commits: readonly GitCommit[]): ChangelogEntry[] {
  return commits
    .filter((commit) => commit.isConventional)
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
export const CHANGELOG_TEMPLATE = `# <%= it.packageName %> v<%= it.version %>

**Previous version**: \`<%= it.previousVersion %>\`
**New version**: \`<%= it.version %>\`

<% if (it.entries.length === 0) { %>
*No conventional commits found.*
<% } else { %>
<% const groups = it.groupedEntries; %>
<% const typeOrder = ["breaking", "feat", "fix", "perf", "docs", "style", "refactor", "test", "build", "ci", "chore"]; %>
<% const typeLabels = {
  breaking: "💥 Breaking Changes",
  feat: "✨ Features",
  fix: "🐛 Bug Fixes",
  perf: "⚡ Performance",
  docs: "📝 Documentation",
  style: "💄 Styling",
  refactor: "♻️ Refactoring",
  test: "✅ Tests",
  build: "📦 Build",
  ci: "👷 CI",
  chore: "🔧 Chores"
}; %>

<% for (const type of typeOrder) { %>
<% const entries = groups.get(type); %>
<% if (entries && entries.length > 0) { %>
## <%= typeLabels[type] || type.charAt(0).toUpperCase() + type.slice(1) %>

<% for (const entry of entries) { %>
- <% if (entry.scope) { %>**<%= entry.scope %>**: <% } %><%= entry.description %><% if (entry.references.length > 0) { %> (<%= entry.references.map(r => "#" + r.value).join(", ") %>)<% } %> (\`<%= entry.shortHash %>\`)
<% } %>

<% } %>
<% } %>

<% for (const [type, entries] of groups) { %>
<% if (!typeOrder.includes(type)) { %>
## <%= type.charAt(0).toUpperCase() + type.slice(1) %>

<% for (const entry of entries) { %>
- <% if (entry.scope) { %>**<%= entry.scope %>**: <% } %><%= entry.description %> (\`<%= entry.shortHash %>\`)
<% } %>

<% } %>
<% } %>
<% } %>`;

/**
 * Pure function to format changelog as markdown
 */
export function formatChangelogMarkdown(changelog: PackageChangelog): string {
  const groups = groupByType(changelog.entries);

  return eta.renderString(CHANGELOG_TEMPLATE, {
    packageName: changelog.packageName,
    version: changelog.version,
    previousVersion: changelog.previousVersion,
    entries: changelog.entries,
    groupedEntries: groups,
  });
}

/**
 * Pure function to create a changelog object
 */
export function createChangelog(
  packageName: string,
  version: string,
  previousVersion: string,
  commits: readonly GitCommit[],
): PackageChangelog {
  const entries = parseCommits(commits);

  return {
    packageName,
    version,
    previousVersion,
    entries,
  };
}
