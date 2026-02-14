import { describe, expect, it } from "vitest";
import { createWorkspaceOperations } from "../../src/core/workspace";

describe("createWorkspaceOperations", () => {
  it("wraps successful calls", async () => {
    const ops = createWorkspaceOperations({
      discoverWorkspacePackages: async () => [],
    });

    const result = await ops.discoverWorkspacePackages("/tmp", {});
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual([]);
    }
  });

  it("wraps errors", async () => {
    const ops = createWorkspaceOperations({
      discoverWorkspacePackages: async () => {
        throw new Error("boom");
      },
    });

    const result = await ops.discoverWorkspacePackages("/tmp", {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe("workspace");
      expect(result.error.operation).toBe("discoverWorkspacePackages");
    }
  });
});
