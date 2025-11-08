import type { VersionUpdate } from "./types";
import farver from "farver";

interface SharedGitHubOptions {
  owner: string;
  repo: string;
  githubToken: string;
}

interface GitHubPullRequest {
  number: number;
  title: string;
  body: string;
  draft: boolean;
  html_url?: string;
}

export async function getExistingPullRequest({
  owner,
  repo,
  branch,
  githubToken,
}: SharedGitHubOptions & {
  branch: string;
}): Promise<GitHubPullRequest | null> {
  try {
    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls?state=open&head=${branch}`, {
      headers: {
        Accept: "application/vnd.github.v3+json",
        Authorization: `token ${githubToken}`,
      },
    });

    if (!res.ok) {
      throw new Error(`GitHub API request failed with status ${res.status}`);
    }

    const pulls = await res.json();

    if (pulls == null || !Array.isArray(pulls) || pulls.length === 0) {
      return null;
    }

    const firstPullRequest: unknown = pulls[0];

    if (
      typeof firstPullRequest !== "object"
      || firstPullRequest === null
      || !("number" in firstPullRequest)
      || typeof firstPullRequest.number !== "number"
      || !("title" in firstPullRequest)
      || typeof firstPullRequest.title !== "string"
      || !("body" in firstPullRequest)
      || typeof firstPullRequest.body !== "string"
      || !("draft" in firstPullRequest)
      || typeof firstPullRequest.draft !== "boolean"
      || !("html_url" in firstPullRequest)
      || typeof firstPullRequest.html_url !== "string"
    ) {
      throw new TypeError("Pull request data validation failed");
    }

    const pullRequest: GitHubPullRequest = {
      number: firstPullRequest.number,
      title: firstPullRequest.title,
      body: firstPullRequest.body,
      draft: firstPullRequest.draft,
      html_url: firstPullRequest.html_url,
    };

    console.info(`Found existing pull request: ${farver.yellow(`#${pullRequest.number}`)}`);

    return pullRequest;
  } catch (err) {
    console.error("Error fetching pull request:", err);
    return null;
  }
}

export async function upsertPullRequest({
  owner,
  repo,
  title,
  body,
  head,
  base,
  pullNumber,
  githubToken,
}: SharedGitHubOptions & {
  title: string;
  body: string;
  head?: string;
  base?: string;
  pullNumber?: number;
}): Promise<GitHubPullRequest | null> {
  try {
    const isUpdate = pullNumber != null;
    const url = isUpdate
      ? `https://api.github.com/repos/${owner}/${repo}/pulls/${pullNumber}`
      : `https://api.github.com/repos/${owner}/${repo}/pulls`;

    const method = isUpdate ? "PATCH" : "POST";

    const requestBody = isUpdate
      ? { title, body }
      : { title, body, head, base };

    const res = await fetch(url, {
      method,
      headers: {
        Accept: "application/vnd.github.v3+json",
        Authorization: `token ${githubToken}`,
      },
      body: JSON.stringify(requestBody),
    });

    if (!res.ok) {
      throw new Error(`GitHub API request failed with status ${res.status}`);
    }

    const pr = await res.json();

    if (
      typeof pr !== "object"
      || pr === null
      || !("number" in pr)
      || typeof pr.number !== "number"
      || !("title" in pr)
      || typeof pr.title !== "string"
      || !("body" in pr)
      || typeof pr.body !== "string"
      || !("draft" in pr)
      || typeof pr.draft !== "boolean"
      || !("html_url" in pr)
      || typeof pr.html_url !== "string"
    ) {
      throw new TypeError("Pull request data validation failed");
    }

    const action = isUpdate ? "Updated" : "Created";
    console.info(`${action} pull request: ${farver.yellow(`#${pr.number}`)}`);

    return {
      number: pr.number,
      title: pr.title,
      body: pr.body,
      draft: pr.draft,
      html_url: pr.html_url,
    };
  } catch (err) {
    console.error(`Error upserting pull request:`, err);
    throw err;
  }
}

export function generatePullRequestBody(updates: VersionUpdate[], _body?: string): string {
  const lines: string[] = [];

  // TODO: Add support for custom body templates

  lines.push("## Packages");
  lines.push("");

  // Group by direct changes vs dependency updates
  const directChanges = updates.filter((u) => u.hasDirectChanges);
  const dependencyUpdates = updates.filter((u) => !u.hasDirectChanges);

  if (directChanges.length > 0) {
    lines.push("### Direct Changes");
    lines.push("");
    for (const update of directChanges) {
      lines.push(
        `- **${update.package.name}**: ${update.currentVersion} → ${update.newVersion} (${update.bumpType})`,
      );
    }
    lines.push("");
  }

  if (dependencyUpdates.length > 0) {
    lines.push("### Dependency Updates");
    lines.push("");
    for (const update of dependencyUpdates) {
      lines.push(
        `- **${update.package.name}**: ${update.currentVersion} → ${update.newVersion} (dependencies changed)`,
      );
    }
    lines.push("");
  }

  lines.push("---");
  lines.push("");
  lines.push("This release PR was automatically generated.");

  return lines.join("\n");
}
