import type { CommandExecutor } from "@effect/platform";
import { it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { GitCommandError } from "../../src/errors";
import { ConfigOptions } from "../../src/services/config.service";
import { GitService } from "../../src/services/git.service";

const mockConfig = {
  workspaceRoot: "/test/workspace",
  githubToken: "test-token",
  owner: "test-owner",
  repo: "test-repo",
  packages: {
    exclude: [],
    include: [],
    excludePrivate: false,
  },
  prompts: { packages: true, versions: true },
  branch: { default: "main", release: "release/next" },
  safeguards: true,
  globalCommitMode: "dependencies" as const,
  pullRequest: { title: "chore: release", body: "" },
  changelog: { enabled: true, template: "" },
  groups: [],
};

function createMockExecutor(impl: Partial<CommandExecutor.CommandExecutor>): CommandExecutor.CommandExecutor {
  return {
    string: () => Effect.succeed(""),
    lines: () => Effect.succeed([]),
    exitCode: () => Effect.succeed(0),
    start: () => Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
    stream: () => Effect.succeed(""),
    ...impl,
  } as any;
}

it("should parse branches from git output", () =>
  Effect.gen(function* () {
    const mockBranches = "main\nfeature/test\nrelease/next";
    const mockExecutor = createMockExecutor({
      string: () => Effect.succeed(mockBranches),
    });

    const testLayer = Layer.merge(
      ConfigOptions.layer(mockConfig),
      GitService.mockLayer(mockExecutor),
    );

    const result = yield* GitService.pipe(
      Effect.flatMap((gitService) => gitService.listBranches),
      Effect.provide(testLayer),
    );

    if (result[0] !== "main" || result[1] !== "feature/test" || result[2] !== "release/next") {
      throw new Error(`Expected ["main", "feature/test", "release/next"], got ${JSON.stringify(result)}`);
    }
  }));

it("should handle empty branch list", () =>
  Effect.gen(function* () {
    const mockExecutor = createMockExecutor({
      string: () => Effect.succeed(""),
    });

    const testLayer = Layer.merge(
      ConfigOptions.layer(mockConfig),
      GitService.mockLayer(mockExecutor),
    );

    const result = yield* GitService.pipe(
      Effect.flatMap((gitService) => gitService.listBranches),
      Effect.provide(testLayer),
    );

    if (result.length !== 0) {
      throw new Error(`Expected empty array, got ${JSON.stringify(result)}`);
    }
  }));

it("should handle git command errors", () =>
  Effect.gen(function* () {
    const mockExecutor = createMockExecutor({
      string: () =>
        Effect.fail(
          new Error("fatal: not a git repository"),
        ) as Effect.Effect<string, any, never>,
    });

    const testLayer = Layer.merge(
      ConfigOptions.layer(mockConfig),
      GitService.mockLayer(mockExecutor),
    );

    const result = yield* GitService.pipe(
      Effect.flatMap((gitService) => gitService.listBranches),
      Effect.provide(testLayer),
      Effect.flip,
    );

    if (!(result instanceof GitCommandError)) {
      throw new Error(`Expected GitCommandError, got ${(result as any).constructor?.name || typeof result}`);
    }
  }));

it("should trim whitespace from branch names", () =>
  Effect.gen(function* () {
    const mockBranches = "  main  \n  feature/test  \n  release/next  ";
    const mockExecutor = createMockExecutor({
      string: () => Effect.succeed(mockBranches),
    });

    const testLayer = Layer.merge(
      ConfigOptions.layer(mockConfig),
      GitService.mockLayer(mockExecutor),
    );

    const result = yield* GitService.pipe(
      Effect.flatMap((gitService) => gitService.listBranches),
      Effect.provide(testLayer),
    );

    if (result[0] !== "main" || result[1] !== "feature/test" || result[2] !== "release/next") {
      throw new Error(`Expected trimmed ["main", "feature/test", "release/next"], got ${JSON.stringify(result)}`);
    }
  }));
