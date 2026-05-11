import { Effect } from "effect";
import { afterEach, beforeEach, describe } from "vitest";
import { expect, it } from "@effect/vitest";

import { getIsCI } from "../../src/errors";

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

  it.effect("returns true when CI=true", () =>
    Effect.sync(() => {
      process.env.CI = "true";
      expect(getIsCI()).toBe(true);
    }));

  it.effect("returns true when CI is non-empty string", () =>
    Effect.sync(() => {
      process.env.CI = "1";
      expect(getIsCI()).toBe(true);
    }));

  it.effect("returns false when CI is unset", () =>
    Effect.sync(() => {
      delete process.env.CI;
      expect(getIsCI()).toBe(false);
    }));

  it.effect("returns false when CI=false", () =>
    Effect.sync(() => {
      process.env.CI = "false";
      expect(getIsCI()).toBe(false);
    }));

  it.effect("returns false when CI is empty string", () =>
    Effect.sync(() => {
      process.env.CI = "";
      expect(getIsCI()).toBe(false);
    }));

  it.effect("returns false when CI=FALSE (case insensitive)", () =>
    Effect.sync(() => {
      process.env.CI = "FALSE";
      expect(getIsCI()).toBe(false);
    }));
});
