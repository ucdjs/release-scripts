import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getIsCI } from "../../src/shared/utils";

describe("getIsCI", () => {
  let originalCI: string | undefined;

  beforeEach(() => {
    originalCI = process.env.CI;
  });

  afterEach(() => {
    if (originalCI === undefined) {
      delete process.env.CI;
    } else {
      process.env.CI = originalCI;
    }
  });

  it("returns true when CI=true", () => {
    process.env.CI = "true";
    expect(getIsCI()).toBe(true);
  });

  it("returns true when CI is non-empty string", () => {
    process.env.CI = "1";
    expect(getIsCI()).toBe(true);
  });

  it("returns false when CI is unset", () => {
    delete process.env.CI;
    expect(getIsCI()).toBe(false);
  });

  it("returns false when CI=false", () => {
    process.env.CI = "false";
    expect(getIsCI()).toBe(false);
  });

  it("returns false when CI is empty string", () => {
    process.env.CI = "";
    expect(getIsCI()).toBe(false);
  });

  it("returns false when CI=FALSE (case insensitive)", () => {
    process.env.CI = "FALSE";
    expect(getIsCI()).toBe(false);
  });
});
