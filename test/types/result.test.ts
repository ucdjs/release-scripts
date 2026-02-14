import { describe, expect, it } from "vitest";
import { err, isErr, isOk, ok } from "../../src/types/result";

describe("result", () => {
  it("creates ok values", () => {
    const result = ok(123);
    expect(result.ok).toBe(true);
    expect(result.value).toBe(123);
    expect(isOk(result)).toBe(true);
    expect(isErr(result)).toBe(false);
  });

  it("creates err values", () => {
    const result = err("boom");
    expect(result.ok).toBe(false);
    expect(result.error).toBe("boom");
    expect(isOk(result)).toBe(false);
    expect(isErr(result)).toBe(true);
  });
});
