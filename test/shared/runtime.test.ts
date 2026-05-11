import process from "node:process";

import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Option } from "effect";

import { CommandError, runCommandEffect } from "../../src/errors";

it.effect("runCommandEffect captures stdout with pipe stdio", () =>
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

      expect(result.stdout).toBe("ok");
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
    }),
  ));

it.effect("runCommandEffect fails with CommandError on non-zero exit", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        runCommandEffect(process.execPath, ["-e", "process.stderr.write('boom'); process.exit(2)"], {
          nodeOptions: {
            stdio: "pipe",
          },
        }).pipe(Effect.provide(NodeServices.layer)),
      );

      expect(Exit.isFailure(exit)).toBe(true);

      if (Exit.isFailure(exit)) {
        const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
        expect(error).toBeInstanceOf(CommandError);
        expect(error?.stderr).toContain("boom");
        expect(error?.exitCode).toBe(2);
      }
    }),
  ));
