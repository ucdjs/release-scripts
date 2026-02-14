import { describe, expect, it } from "vitest";
import { createGitHubOperations } from "../../src/core/github";

describe("createGitHubOperations", () => {
  it("wraps successful calls", async () => {
    const ops = createGitHubOperations({ owner: "x", repo: "y", githubToken: "t" }, {
      getExistingPullRequest: async () => null,
    });

    const result = await ops.getExistingPullRequest("release/next");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBeNull();
    }
  });

  it("wraps errors", async () => {
    const ops = createGitHubOperations({ owner: "x", repo: "y", githubToken: "t" }, {
      getExistingPullRequest: async () => {
        throw new Error("boom");
      },
    });

    const result = await ops.getExistingPullRequest("release/next");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe("github");
      expect(result.error.operation).toBe("getExistingPullRequest");
    }
  });
});
