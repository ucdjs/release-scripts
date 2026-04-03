import { describe, expect, it } from "vitest";

import { computeDependencyRange } from "../../src/versioning/version";

describe("computeDependencyRange", () => {
  it("returns null for workspace:* ranges", () => {
    expect(computeDependencyRange("workspace:*", "1.0.0", false)).toBeNull();
  });

  it("returns ^version for regular dependencies", () => {
    expect(computeDependencyRange("^0.5.0", "1.0.0", false)).toBe("^1.0.0");
  });

  it("returns range for peer dependencies", () => {
    expect(computeDependencyRange("^1.0.0", "2.0.0", true)).toBe(">=2.0.0 <3.0.0");
  });

  it("handles 0.x peer dependencies", () => {
    expect(computeDependencyRange("^0.1.0", "0.2.0", true)).toBe(">=0.2.0 <1.0.0");
  });

  it("ignores old range value for regular deps", () => {
    expect(computeDependencyRange("~0.5.0", "1.0.0", false)).toBe("^1.0.0");
    expect(computeDependencyRange(">=0.5.0", "1.0.0", false)).toBe("^1.0.0");
  });

  it("handles peer dependency with large major", () => {
    expect(computeDependencyRange("^10.0.0", "11.0.0", true)).toBe(">=11.0.0 <12.0.0");
  });
});
