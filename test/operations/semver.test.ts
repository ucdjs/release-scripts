import { calculateBumpType, getNextVersion, isValidSemver } from "#operations/semver";
import { describe, expect, it } from "vitest";

describe("semver operations", () => {
  it("validates semver strings", () => {
    expect(isValidSemver("1.2.3")).toBe(true);
    expect(isValidSemver("1.2.3-beta.1")).toBe(true);
    expect(isValidSemver("1.2")).toBe(false);
  });

  it("calculates next versions", () => {
    expect(getNextVersion("1.0.0", "major")).toBe("2.0.0");
    expect(getNextVersion("1.0.0", "minor")).toBe("1.1.0");
    expect(getNextVersion("1.0.0", "patch")).toBe("1.0.1");
    expect(getNextVersion("1.0.0", "none")).toBe("1.0.0");
  });

  it("calculates bump types", () => {
    expect(calculateBumpType("1.0.0", "2.0.0")).toBe("major");
    expect(calculateBumpType("1.0.0", "1.1.0")).toBe("minor");
    expect(calculateBumpType("1.0.0", "1.0.1")).toBe("patch");
    expect(calculateBumpType("1.0.0", "1.0.0")).toBe("none");
  });
});
