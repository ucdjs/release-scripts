import type { GitError } from "../../src/core/git";
import type { GitHubError } from "../../src/core/github";
import type { WorkspaceError } from "../../src/core/workspace";
import { describe, expect, it } from "vitest";

describe("core types", () => {
  it("matches git error shape", () => {
    const err: GitError = {
      type: "git",
      operation: "push",
      message: "failed",
    };

    expect(err.type).toBe("git");
    expect(err.operation).toBe("push");
  });

  it("matches github error shape", () => {
    const err: GitHubError = {
      type: "github",
      operation: "request",
      message: "failed",
    };

    expect(err.type).toBe("github");
    expect(err.operation).toBe("request");
  });

  it("matches workspace error shape", () => {
    const err: WorkspaceError = {
      type: "workspace",
      operation: "discover",
      message: "failed",
    };

    expect(err.type).toBe("workspace");
    expect(err.operation).toBe("discover");
  });
});
