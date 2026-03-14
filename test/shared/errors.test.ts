import { describe, expect, it, vi } from "vitest";
import { exitWithError, formatUnknownError, printReleaseError, ReleaseError } from "../../src/shared/errors";

describe("formatUnknownError", () => {
  it("handles Error instances", () => {
    const result = formatUnknownError(new Error("test error"));
    expect(result.message).toBe("test error");
    expect(result.stack).toBeDefined();
  });

  it("handles string errors", () => {
    const result = formatUnknownError("string error");
    expect(result.message).toBe("string error");
  });

  it("handles plain objects with message", () => {
    const result = formatUnknownError({ message: "obj error" });
    expect(result.message).toBe("obj error");
  });

  it("handles errors with stderr", () => {
    const error = new Error("cmd failed");
    (error as any).stderr = "some stderr output";
    const result = formatUnknownError(error);
    expect(result.stderr).toBe("some stderr output");
  });

  it("handles errors with status code", () => {
    const error = new Error("http error");
    (error as any).status = 404;
    const result = formatUnknownError(error);
    expect(result.status).toBe(404);
  });

  it("extracts shortMessage from tinyexec-style errors", () => {
    const error = new Error("Process exited with non-zero status (1)");
    (error as any).shortMessage = "Command failed: git push";
    const result = formatUnknownError(error);
    expect(result.message).toBe("Command failed: git push");
  });

  it("handles unknown types by converting to string", () => {
    const result = formatUnknownError(42);
    expect(result.message).toBe("42");
  });

  it("handles errors with code", () => {
    const error = new Error("ENOENT");
    (error as any).code = "ENOENT";
    const result = formatUnknownError(error);
    expect(result.code).toBe("ENOENT");
  });
});

describe("releaseError", () => {
  it("stores message, hint, and cause", () => {
    const cause = new Error("underlying");
    const err = new ReleaseError("msg", "hint", cause);
    expect(err.message).toBe("msg");
    expect(err.hint).toBe("hint");
    expect(err.cause).toBe(cause);
  });

  it("is instanceof Error", () => {
    const err = new ReleaseError("test");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("ReleaseError");
  });

  it("works without hint and cause", () => {
    const err = new ReleaseError("simple");
    expect(err.hint).toBeUndefined();
    expect(err.cause).toBeUndefined();
  });
});

describe("exitWithError", () => {
  it("throws ReleaseError with message, hint, and cause", () => {
    const cause = new Error("cause");
    expect(() => exitWithError("msg", "hint", cause)).toThrow(ReleaseError);
    try {
      exitWithError("msg", "hint", cause);
    } catch (e) {
      expect((e as ReleaseError).message).toBe("msg");
      expect((e as ReleaseError).hint).toBe("hint");
      expect((e as ReleaseError).cause).toBe(cause);
    }
  });

  it("throws without hint", () => {
    expect(() => exitWithError("msg")).toThrow(ReleaseError);
  });
});

describe("printReleaseError", () => {
  it("prints formatted error to stderr", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    printReleaseError(new ReleaseError("Something broke", "Check config"));
    const output = spy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("Something broke");
    expect(output).toContain("Check config");
    spy.mockRestore();
  });

  it("prints cause details when present", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const cause = new Error("underlying issue");
    printReleaseError(new ReleaseError("Top error", undefined, cause));
    const output = spy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("Top error");
    expect(output).toContain("underlying issue");
    spy.mockRestore();
  });
});
