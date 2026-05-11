import { describe, expect, it } from "vitest";

import { GitError } from "../src/services/git";
import { GitHubError } from "../src/services/github";
import { WorkspaceError } from "../src/services/workspace";

describe("core types", () => {
  it("matches git error shape", () => {
    const err = new GitError({
      operation: "push",
      message: "failed",
    });

    expect(err._tag).toBe("GitError");
    expect(err.operation).toBe("push");
  });

  it("matches github error shape", () => {
    const err = new GitHubError({
      operation: "request",
      message: "failed",
    });

    expect(err._tag).toBe("GitHubError");
    expect(err.operation).toBe("request");
  });

  it("matches workspace error shape", () => {
    const err = new WorkspaceError({
      operation: "discover",
      message: "failed",
    });

    expect(err._tag).toBe("WorkspaceError");
    expect(err.operation).toBe("discover");
  });
});
