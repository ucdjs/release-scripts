import { join, relative } from "node:path";

import type { NormalizedReleaseScriptsOptions } from "../options";
import { DEFAULT_CHANGELOG_TEMPLATE } from "../options";
import type { AuthorInfo, CommitTypeRule } from "../types";
import { logger } from "../errors";
import { Context, Effect, FileSystem, Layer } from "effect";
import type { GitCommit } from "commit-parser";
import { groupByType } from "commit-parser";
import { Eta } from "eta";

import { GitService } from "./git";
import { GitHubService } from "./github";
import type { WorkspacePackage } from "./workspace";

const CHANGELOG_VERSION_RE = /##\s+(?:<small>)?\[?([^\](\s<]+)/;
const HASH_PREFIX_RE = /^#/;
const excludeAuthors = [/\[bot\]/i, /dependabot/i, /\(bot\)/i];

function formatCommitLine(options: {
  commit: GitCommit;
  owner: string;
  repo: string;
  authors: AuthorInfo[];
}): string {
  const { commit, owner, repo, authors } = options;
  const commitUrl = `https://github.com/${owner}/${repo}/commit/${commit.hash}`;
  let line = commit.description;
  const references = commit.references ?? [];

  for (const ref of references) {
    if (!ref.value) continue;

    const number = Number.parseInt(ref.value.replace(HASH_PREFIX_RE, ""), 10);
    if (Number.isNaN(number)) continue;

    if (ref.type === "issue") {
      line += ` ([Issue ${ref.value}](https://github.com/${owner}/${repo}/issues/${number}))`;
      continue;
    }

    line += ` ([PR ${ref.value}](https://github.com/${owner}/${repo}/pull/${number}))`;
  }

  line += ` ([${commit.shortHash}](${commitUrl}))`;

  if (authors.length > 0) {
    const authorList = authors
      .map((author) =>
        author.login ? `[@${author.login}](https://github.com/${author.login})` : author.name,
      )
      .join(", ");

    line += ` (by ${authorList})`;
  }

  return line;
}

export function buildTemplateGroups(options: {
  commits: GitCommit[];
  owner: string;
  repo: string;
  types: Record<string, CommitTypeRule>;
  commitAuthors: Map<string, AuthorInfo[]>;
}): Array<{ name: string; title: string; commits: Array<{ line: string }> }> {
  const { commits, owner, repo, types, commitAuthors } = options;
  const mergeKeys = Object.fromEntries(
    Object.entries(types).map(([key, value]) => [key, value.types ?? [key]]),
  );

  const grouped = groupByType(commits, {
    includeNonConventional: false,
    mergeKeys,
  });

  return Object.entries(types).map(([key, value]) => ({
    name: key,
    title: value.title,
    commits: (grouped.get(key) ?? []).map((commit) => ({
      line: formatCommitLine({
        commit,
        owner,
        repo,
        authors: commitAuthors.get(commit.hash) ?? [],
      }),
    })),
  }));
}

export interface ChangelogServiceShape {
  readonly generateChangelogEntry: (options: {
    packageName: string;
    version: string;
    previousVersion?: string;
    date: string;
    commits: GitCommit[];
    owner: string;
    repo: string;
    types: Record<string, CommitTypeRule>;
    template?: string;
  }) => Effect.Effect<string, unknown, unknown>;
  readonly updateChangelog: (options: {
    normalizedOptions: NormalizedReleaseScriptsOptions;
    workspacePackage: WorkspacePackage;
    version: string;
    previousVersion?: string;
    commits: GitCommit[];
    date: string;
  }) => Effect.Effect<void, unknown, unknown>;
}

export class ChangelogService extends Context.Service<ChangelogService, ChangelogServiceShape>()(
  "@ucdjs/release-scripts/ChangelogService",
) {}

// oxlint-disable-next-line require-yield
export const makeChangelogService = Effect.fn("makeChangelogService")(function* () {
  const resolveCommitAuthors = Effect.fn("resolveCommitAuthors")(function* (commits: GitCommit[]) {
    const github = yield* GitHubService;
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

    const authors = [...authorMap.values()];
    yield* Effect.all(authors.map((info) => github.resolveAuthorInfo(info)));

    return commitAuthors;
  });

  const generateChangelogEntry: ChangelogServiceShape["generateChangelogEntry"] = Effect.fn("generateChangelogEntry")(function* (options) {
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
    } = options;

    const compareUrl =
      previousVersion && previousVersion !== version
        ? `https://github.com/${owner}/${repo}/compare/${packageName}@${previousVersion}...${packageName}@${version}`
        : undefined;

    const commitAuthors = yield* resolveCommitAuthors(commits);
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
  });

  const updateChangelog: ChangelogServiceShape["updateChangelog"] = Effect.fn("updateChangelog")(function* (options) {
    const fs = yield* FileSystem.FileSystem;
    const git = yield* GitService;
    const {
      version,
      previousVersion,
      commits,
      date,
      normalizedOptions,
      workspacePackage,
    } = options;

    if (previousVersion === version) {
      logger.verbose(
        `Skipping changelog update for ${workspacePackage.name}: version unchanged (${version})`,
      );
      return;
    }

    const changelogPath = join(workspacePackage.path, "CHANGELOG.md");
    const changelogRelativePath = relative(
      normalizedOptions.workspaceRoot,
      join(workspacePackage.path, "CHANGELOG.md"),
    );

    const existingContent = yield* git.readFileFromGit(
      normalizedOptions.workspaceRoot,
      normalizedOptions.branch.default,
      changelogRelativePath,
    );

    logger.verbose("Existing content found: ", Boolean(existingContent));

    const newEntry = yield* generateChangelogEntry({
      packageName: workspacePackage.name,
      version,
      previousVersion,
      date,
      commits,
      owner: normalizedOptions.owner,
      repo: normalizedOptions.repo,
      types: normalizedOptions.types,
      template: normalizedOptions.changelog?.template,
    });

    let updatedContent: string;

    if (!existingContent) {
      updatedContent = `# ${workspacePackage.name}\n\n${newEntry}\n`;
      yield* fs.writeFileString(changelogPath, updatedContent);
      return;
    }

    const parsed = parseChangelog(existingContent);
    const lines = existingContent.split("\n");
    const existingVersionIndex = parsed.versions.findIndex((v) => v.version === version);

    if (existingVersionIndex !== -1) {
      const existingVersion = parsed.versions[existingVersionIndex]!;
      const before = lines.slice(0, existingVersion.lineStart);
      const after = lines.slice(existingVersion.lineEnd + 1);
      updatedContent = [...before, newEntry, ...after].join("\n");
    } else {
      const insertAt = parsed.headerLineEnd + 1;
      const before = lines.slice(0, insertAt);
      const after = lines.slice(insertAt);

      if (before.length > 0 && before.at(-1) !== "") {
        before.push("");
      }

      updatedContent = [...before, newEntry, "", ...after].join("\n");
    }

    yield* fs.writeFileString(changelogPath, updatedContent);
  });

  return ChangelogService.of({
    generateChangelogEntry,
    updateChangelog,
  });
});

export const ChangelogServiceLive = Layer.effect(ChangelogService, makeChangelogService());

export function parseChangelog(content: string) {
  const lines = content.split("\n");

  let packageName: string | null = null;
  let headerLineEnd = -1;
  const versions: {
    version: string;
    lineStart: number;
    lineEnd: number;
    content: string;
  }[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();

    if (line.startsWith("# ")) {
      packageName = line.slice(2).trim();
      headerLineEnd = i;
      break;
    }
  }

  for (let i = headerLineEnd + 1; i < lines.length; i++) {
    const line = lines[i]!.trim();

    if (line.startsWith("## ")) {
      const versionMatch = line.match(CHANGELOG_VERSION_RE);

      if (versionMatch) {
        const version = versionMatch[1]!;
        const lineStart = i;

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
