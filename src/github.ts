import { createDebugger } from "./logger";

const debug = createDebugger("ucdjs:release-scripts:github");

interface SharedGitHubOptions {
  owner: string;
  repo: string;
  githubToken: string;
}

export async function getExistingPullRequest({
  owner,
  repo,
  branch,
  githubToken,
}: SharedGitHubOptions & {
  branch: string;
}) {
  try {
    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls?state=open&base=${branch}`, {
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
      debug?.("No existing pull requests found");
      return null;
    }

    const firstPullRequest = pulls[0];
    if (firstPullRequest == null) {
      debug?.("No existing pull requests found");
      return null;
    }

    // TODO: verify that the PR matches expected criteria (e.g., title, labels)

    debug?.(`Found existing pull request: #${firstPullRequest.number}`);
    return firstPullRequest;
  } catch (err) {
    console.error("Error fetching pull request:", err);
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
}) {
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
    const action = isUpdate ? "Updated" : "Created";
    debug?.(`${action} pull request: #${pr.number}`);
    return pr;
  } catch (err) {
    console.error(`Error upserting pull request:`, err);
    throw err;
  }
}
