import process from "node:process";

import { NodeServices } from "@effect/platform-node";
import { expect as effectExpect, it as effectIt } from "@effect/vitest";
import { Cause, Effect, Exit, Option } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CommandError,
  exitWithError,
  formatUnknownError,
  getIsCI,
  printReleaseError,
  ReleaseError,
  runCommandEffect,
} from "../src/errors";

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

effectIt.effect("runCommandEffect captures stdout with pipe stdio", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const result = yield* runCommandEffect(
        process.execPath,
        ["-e", "process.stdout.write('ok')"],
        {
          nodeOptions: {
            stdio: "pipe",
          },
        },
      ).pipe(Effect.provide(NodeServices.layer));

      effectExpect(result.stdout).toBe("ok");
      effectExpect(result.stderr).toBe("");
      effectExpect(result.exitCode).toBe(0);
    }),
  ));

effectIt.effect("runCommandEffect fails with CommandError on non-zero exit", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        runCommandEffect(process.execPath, ["-e", "process.stderr.write('boom'); process.exit(2)"], {
          nodeOptions: {
            stdio: "pipe",
          },
        }).pipe(Effect.provide(NodeServices.layer)),
      );

      effectExpect(Exit.isFailure(exit)).toBe(true);

      if (Exit.isFailure(exit)) {
        const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
        effectExpect(error).toBeInstanceOf(CommandError);
        effectExpect(error?.stderr).toContain("boom");
        effectExpect(error?.exitCode).toBe(2);
      }
    }),
  ));

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

  effectIt.effect("returns true when CI=true", () =>
    Effect.sync(() => {
      process.env.CI = "true";
      effectExpect(getIsCI()).toBe(true);
    }));

  effectIt.effect("returns true when CI is non-empty string", () =>
    Effect.sync(() => {
      process.env.CI = "1";
      effectExpect(getIsCI()).toBe(true);
    }));

  effectIt.effect("returns false when CI is unset", () =>
    Effect.sync(() => {
      delete process.env.CI;
      effectExpect(getIsCI()).toBe(false);
    }));

  effectIt.effect("returns false when CI=false", () =>
    Effect.sync(() => {
      process.env.CI = "false";
      effectExpect(getIsCI()).toBe(false);
    }));

  effectIt.effect("returns false when CI is empty string", () =>
    Effect.sync(() => {
      process.env.CI = "";
      effectExpect(getIsCI()).toBe(false);
    }));

  effectIt.effect("returns false when CI=FALSE (case insensitive)", () =>
    Effect.sync(() => {
      process.env.CI = "FALSE";
      effectExpect(getIsCI()).toBe(false);
    }));
});
