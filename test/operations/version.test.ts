import { describe, expect, it } from "vitest";
import { createCommit } from "../_shared";
import { determineHighestBump } from "#operations/version";

describe("version operations", () => {
  it("returns none for empty commits", () => {
    expect(determineHighestBump([])).toBe("none");
  });

  it("returns patch for fix commits", () => {
    const result = determineHighestBump([
      createCommit({ type: "fix", isConventional: true }),
    ]);
    expect(result).toBe("patch");
  });

  it("returns minor for feat commits", () => {
    const result = determineHighestBump([
      createCommit({ type: "feat", isConventional: true }),
    ]);
    expect(result).toBe("minor");
  });

  it("returns major for breaking commits", () => {
    const result = determineHighestBump([
      createCommit({ type: "feat", isBreaking: true, isConventional: true }),
    ]);
    expect(result).toBe("major");
  });
});
