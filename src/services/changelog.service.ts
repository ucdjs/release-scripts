import type { GitCommit } from "commit-parser";
import type { WorkspacePackageWithCommits } from "../utils/helpers";
import { Effect, Schema } from "effect";
import { Eta } from "eta";

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

const eta = new Eta();

export class ChangelogService extends Effect.Service<ChangelogService>()("@ucdjs/release-scripts/ChangelogService", {
  effect: Effect.gen(function* () {
    function parseCommits(commits: readonly GitCommit[]): ChangelogEntry[] {
      return commits
        .filter((commit) => commit.isConventional)
        .map((commit) => ({
          type: commit.type || "other",
          scope: commit.scope,
          description: commit.description,
          breaking: commit.isBreaking || false,
          hash: commit.hash,
          shortHash: commit.shortHash,
          references: commit.references.map((ref: { type: string; value: string }) => ({
            type: ref.type,
            value: ref.value,
          })),
        }));
    }

    function groupByType(entries: ChangelogEntry[]): Map<string, ChangelogEntry[]> {
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

    const changelogTemplate = `# <%= it.packageName %> v<%= it.version %>

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

    function formatChangelogMarkdown(changelog: PackageChangelog): string {
      const groups = groupByType(changelog.entries);

      return eta.renderString(changelogTemplate, {
        packageName: changelog.packageName,
        version: changelog.version,
        previousVersion: changelog.previousVersion,
        entries: changelog.entries,
        groupedEntries: groups,
      });
    }

    function generateChangelog(
      pkg: WorkspacePackageWithCommits,
      newVersion: string,
      commits: readonly GitCommit[],
    ) {
      return Effect.gen(function* () {
        const entries = parseCommits(commits);

        const changelog: PackageChangelog = {
          packageName: pkg.name,
          version: newVersion,
          previousVersion: pkg.version,
          entries,
        };

        const markdown = formatChangelogMarkdown(changelog);

        return {
          changelog,
          markdown,
          filePath: `${pkg.path}/CHANGELOG.md`,
        };
      });
    }

    return {
      parseCommits,
      groupByType,
      formatChangelogMarkdown,
      generateChangelog,
    } as const;
  }),
  dependencies: [],
}) {}
