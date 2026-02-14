import { determineHighestBump } from "#versioning/commits";
import { describe, expect, it } from "vitest";
import { createCommit } from "../_shared";
import { determineHighestBump } from "#operations/version";

describe("determineHighestBump", () => {
  it("should return 'none' for empty commit list", () => {
    const result = determineHighestBump([]);
    expect(result).toBe("none");
  });

  it("should return 'patch' if only patch commits are present", () => {
    const result = determineHighestBump([
      createCommit({
        message: "fix: bug fix",
        type: "fix",
        isConventional: true,
      }),
      createCommit({
        message: "chore: update dependencies",
        type: "fix",
        isConventional: true,
      }),
    ]);

    expect(result).toBe("patch");
  });

  it("should return 'minor' if minor and patch commits are present", () => {
    const result = determineHighestBump([
      createCommit({
        message: "feat: new feature",
        type: "feat",
        isConventional: true,
      }),
      createCommit({
        message: "fix: bug fix",
        type: "fix",
        isConventional: true,
      }),
    ]);

    expect(result).toBe("minor");
  });

  it("should return 'major' if a breaking change commit is present", () => {
    const result = determineHighestBump([
      createCommit({
        message: "feat: new feature\n\nBREAKING CHANGE: changes API",
        type: "feat",
        isConventional: true,
        isBreaking: true,
      }),
      createCommit({
        message: "fix: bug fix",
        type: "fix",
        isConventional: true,
      }),
    ]);

    expect(result).toBe("major");
  });

  it("should ignore non-conventional commits", () => {
    const result = determineHighestBump([
      createCommit({
        message: "Some random commit message",
        isConventional: false,
        type: "",
      }),
      createCommit({
        message: "fix: bug fix",
        type: "fix",
        isConventional: true,
      }),
    ]);

    expect(result).toBe("patch");
  });
});
