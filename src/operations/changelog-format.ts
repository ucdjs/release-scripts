import type { AuthorInfo, CommitTypeRule } from "#shared/types";
import type { GitCommit } from "commit-parser";
import { groupByType } from "commit-parser";

interface FormatCommitLineOptions {
  commit: GitCommit;
  owner: string;
  repo: string;
  authors: AuthorInfo[];
}

export function formatCommitLine({ commit, owner, repo, authors }: FormatCommitLineOptions): string {
  const commitUrl = `https://github.com/${owner}/${repo}/commit/${commit.hash}`;
  let line = `${commit.description}`;
  const references = commit.references ?? [];

  for (const ref of references) {
    if (!ref.value) continue;

    const number = Number.parseInt(ref.value.replace(/^#/, ""), 10);
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
      .map((author) => author.login ? `[@${author.login}](https://github.com/${author.login})` : author.name)
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

  return Object.entries(types).map(([key, value]) => {
    const commitsInGroup = grouped.get(key) ?? [];
    const formattedCommits = commitsInGroup.map((commit) => ({
      line: formatCommitLine({
        commit,
        owner,
        repo,
        authors: commitAuthors.get(commit.hash) ?? [],
      }),
    }));

    return {
      name: key,
      title: value.title,
      commits: formattedCommits,
    };
  });
}
