import { describe, expect, it } from "vitest";
import { createGitOperations } from "../../src/core/git";

describe("createGitOperations", () => {
  it("wraps successful calls", async () => {
    const ops = createGitOperations({
      getCurrentBranch: async () => "main",
    });

    const result = await ops.getCurrentBranch("/tmp");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe("main");
    }
  });

  it("wraps errors", async () => {
    const ops = createGitOperations({
      getCurrentBranch: async () => {
        throw new Error("boom");
      },
    });

    const result = await ops.getCurrentBranch("/tmp");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe("git");
      expect(result.error.operation).toBe("getCurrentBranch");
    }
  });
});
