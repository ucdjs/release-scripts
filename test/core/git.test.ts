import { NodeServices } from "@effect/platform-node";
import {
  GitService,
  GitServiceLive,
} from "../../src/services/git";
import { runEffect, runIfNotDryEffect } from "#shared/utils";
import { expect, it, layer } from "@effect/vitest";
import { Cause, Effect, Layer } from "effect";
import { afterEach, assert, beforeEach, describe, vi } from "vitest";

vi.mock("#shared/utils", async () => {
  const actual = await vi.importActual<typeof import("#shared/utils")>("#shared/utils");
  return {
    ...actual,
    runEffect: vi.fn(),
    runIfNotDryEffect: vi.fn(),
  };
});

const mockRunEffect = vi.mocked(runEffect);
const mockRunIfNotDryEffect = vi.mocked(runIfNotDryEffect);
const asTest = (effect: Effect.Effect<void, unknown, unknown>): any => effect;

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.resetAllMocks();
});

layer(Layer.mergeAll(NodeServices.layer, GitServiceLive))("git utilities", (it) => {
  describe("isWorkingDirectoryClean", () => {
    it.effect("should return true if working directory is clean", () =>
      asTest(Effect.gen(function* () {
      mockRunEffect.mockReturnValue(Effect.succeed({
        stdout: "",
        stderr: "",
        exitCode: 0,
      }) as any);

      const git = yield* GitService;
      const result = yield* git.isWorkingDirectoryClean("/workspace");
      expect(mockRunEffect).toHaveBeenCalledWith(
        "git",
        ["status", "--porcelain"],
        expect.objectContaining({
          nodeOptions: expect.objectContaining({
            cwd: "/workspace",
            stdio: "pipe",
          }),
        }),
      );

      expect(result).toBe(true);
    })));

    it.effect("should return false if working directory has uncommitted changes", () =>
      asTest(Effect.gen(function* () {
      mockRunEffect.mockReturnValue(Effect.succeed({
        stdout: " M src/index.ts\n",
        stderr: "",
        exitCode: 0,
      }) as any);

      const git = yield* GitService;
      const result = yield* git.isWorkingDirectoryClean("/workspace");
      expect(result).toBe(false);
    })));

    it.effect("should return error when git command fails", () =>
      asTest(Effect.gen(function* () {
      const gitError = new Error("fatal: not a git repository");
      mockRunEffect.mockReturnValue(Effect.fail(gitError) as any);

      const git = yield* GitService;
      const exit = yield* Effect.exit(git.isWorkingDirectoryClean("/workspace"));

      assert(exit._tag === "Failure");
      const error = Cause.squash(exit.cause) as any;
      expect(error._tag).toBe("GitError");
      expect(error.operation).toBe("isWorkingDirectoryClean");
    })));
  });

  describe("branch utilities", () => {
    describe("doesRemoteBranchExist", () => {
      it.effect("should return true when remote branch exists", () =>
        asTest(Effect.gen(function* () {
        mockRunEffect.mockReturnValue(Effect.succeed({
          stdout: "abc123\trefs/heads/main\n",
          stderr: "",
          exitCode: 0,
        }) as any);

        const git = yield* GitService;
        const result = yield* git.doesRemoteBranchExist("main", "/workspace");
        expect(mockRunEffect).toHaveBeenCalledWith(
          "git",
          ["ls-remote", "--exit-code", "--heads", "origin", "main"],
          expect.objectContaining({
            nodeOptions: expect.objectContaining({
              cwd: "/workspace",
              stdio: "pipe",
            }),
          }),
        );

        expect(result).toBe(true);
      })));

      it.effect("should return false when remote branch does not exist", () =>
        asTest(Effect.gen(function* () {
        mockRunEffect.mockReturnValue(Effect.fail(new Error("exit code 2")) as any);

        const git = yield* GitService;
        const result = yield* git.doesRemoteBranchExist("release/next", "/workspace");
        expect(result).toBe(false);
      })));
    });

    describe("doesBranchExist", () => {
      it.effect("should return true if branch exists", () =>
        asTest(Effect.gen(function* () {
        mockRunEffect.mockReturnValue(Effect.succeed({
          stdout: "branch-sha-123456",
          stderr: "",
          exitCode: 0,
        }) as any);

        const git = yield* GitService;
        const result = yield* git.doesBranchExist("feature-branch", "/workspace");
        expect(mockRunEffect).toHaveBeenCalledWith(
          "git",
          ["rev-parse", "--verify", "feature-branch"],
          expect.objectContaining({
            nodeOptions: expect.objectContaining({
              cwd: "/workspace",
              stdio: "pipe",
            }),
          }),
        );

        expect(result).toBe(true);
      })));

      it.effect("should return false if branch does not exist", () =>
        asTest(Effect.gen(function* () {
        mockRunEffect.mockReturnValue(Effect.fail(new Error("fatal: Needed a single revision")) as any);

        const git = yield* GitService;
        const result = yield* git.doesBranchExist("nonexistent-branch", "/workspace");
        expect(result).toBe(false);
      })));
    });

    describe("getDefaultBranch", () => {
      it.effect("should return the default branch name", () =>
        asTest(Effect.gen(function* () {
        mockRunEffect.mockReturnValue(Effect.succeed({
          stdout: "refs/remotes/origin/main\n",
          stderr: "",
          exitCode: 0,
        }) as any);

        const git = yield* GitService;
        const result = yield* git.getDefaultBranch("/workspace");

        expect(mockRunEffect).toHaveBeenCalledWith(
          "git",
          ["symbolic-ref", "refs/remotes/origin/HEAD"],
          expect.objectContaining({
            nodeOptions: expect.objectContaining({
              stdio: "pipe",
            }),
          }),
        );

        expect(result).toBe("main");
      })));

      it.effect("should return different branch name", () =>
        asTest(Effect.gen(function* () {
        mockRunEffect.mockReturnValue(Effect.succeed({
          stdout: "refs/remotes/origin/develop\n",
          stderr: "",
          exitCode: 0,
        }) as any);

        const git = yield* GitService;
        const result = yield* git.getDefaultBranch("/workspace");

        expect(result).toBe("develop");
      })));

      it.effect("should return 'main' if default branch cannot be determined", () =>
        asTest(Effect.gen(function* () {
        mockRunEffect.mockReturnValue(Effect.fail(new Error("Some git error")) as any);

        const git = yield* GitService;
        const result = yield* git.getDefaultBranch("/workspace");

        expect(result).toBe("main");
      })));

      it.effect("should return 'main' if remote show output is unexpected", () =>
        asTest(Effect.gen(function* () {
        mockRunEffect.mockReturnValue(Effect.succeed({
          stdout: "Some unexpected output\n",
          stderr: "",
          exitCode: 0,
        }) as any);

        const git = yield* GitService;
        const result = yield* git.getDefaultBranch("/workspace");

        expect(result).toBe("main");
      })));
    });

    describe("getCurrentBranch", () => {
      it.effect("should return the current branch name", () =>
        asTest(Effect.gen(function* () {
        mockRunEffect.mockReturnValue(Effect.succeed({
          stdout: "feature-branch\n",
          stderr: "",
          exitCode: 0,
        }) as any);

        const git = yield* GitService;
        const result = yield* git.getCurrentBranch("/workspace");

        expect(mockRunEffect).toHaveBeenCalledWith(
          "git",
          ["rev-parse", "--abbrev-ref", "HEAD"],
          expect.objectContaining({
            nodeOptions: expect.objectContaining({
              cwd: "/workspace",
              stdio: "pipe",
            }),
          }),
        );

        expect(result).toBe("feature-branch");
      })));

      it.effect("should handle errors", () =>
        asTest(Effect.gen(function* () {
        mockRunEffect.mockReturnValue(Effect.fail(new Error("Some git error")) as any);

        const git = yield* GitService;
        const exit = yield* Effect.exit(git.getCurrentBranch("/workspace"));
        assert(exit._tag === "Failure");
        expect((Cause.squash(exit.cause) as any).operation).toBe("getCurrentBranch");
      })));
    });

    describe("getAvailableBranches", () => {
      it.effect("should return a list of available branches", () =>
        asTest(Effect.gen(function* () {
        mockRunEffect.mockReturnValue(Effect.succeed({
          stdout: "  main\n* feature-branch\ndevelop\n",
          stderr: "",
          exitCode: 0,
        }) as any);

        const git = yield* GitService;
        const result = yield* git.getAvailableBranches("/workspace");

        expect(mockRunEffect).toHaveBeenCalledWith(
          "git",
          ["branch", "--list"],
          expect.objectContaining({
            nodeOptions: expect.objectContaining({
              cwd: "/workspace",
              stdio: "pipe",
            }),
          }),
        );

        expect(result).toEqual(["main", "feature-branch", "develop"]);
      })));

      it.effect("should handle errors", () =>
        asTest(Effect.gen(function* () {
        mockRunEffect.mockReturnValue(Effect.fail(new Error("Some git error")) as any);

        const git = yield* GitService;
        const exit = yield* Effect.exit(git.getAvailableBranches("/workspace"));
        assert(exit._tag === "Failure");
        expect((Cause.squash(exit.cause) as any).operation).toBe("getAvailableBranches");
      })));
    });

    describe("createBranch", () => {
      it.effect("should create a new branch from the specified base branch", () =>
        asTest(Effect.gen(function* () {
        mockRunIfNotDryEffect.mockReturnValue(Effect.succeed({
          stdout: "",
          stderr: "",
          exitCode: 0,
        }) as any);

        const git = yield* GitService;
        const result = yield* git.createBranch("new-feature", "main", "/workspace");

        expect(mockRunIfNotDryEffect).toHaveBeenCalledWith(
          "git",
          ["branch", "new-feature", "main"],
          expect.objectContaining({
            nodeOptions: expect.objectContaining({
              cwd: "/workspace",
              stdio: "pipe",
            }),
          }),
        );
        expect(result).toBeUndefined();
      })));

      it.effect("should handle errors", () =>
        asTest(Effect.gen(function* () {
        mockRunIfNotDryEffect.mockReturnValue(Effect.fail(new Error("Some git error")) as any);

        const git = yield* GitService;
        const exit = yield* Effect.exit(git.createBranch("new-feature", "main", "/workspace"));
        assert(exit._tag === "Failure");
        expect((Cause.squash(exit.cause) as any).operation).toBe("createBranch");
      })));
    });
  });

  describe("package tags", () => {
    it.effect("should return the highest semver tag for a package", () =>
      asTest(Effect.gen(function* () {
      mockRunEffect.mockReturnValue(Effect.succeed({
        stdout: "other-package@1.0.0\nmy-package@1.2.0\nmy-package@1.10.0\nmy-package@1.1.0\n",
        stderr: "",
        exitCode: 0,
      } as any) as any);

      const git = yield* GitService;
      const result = yield* git.getMostRecentPackageTag("/workspace", "my-package");

      expect(mockRunEffect).toHaveBeenCalledWith(
        "git",
        ["tag", "--list", "my-package@*"],
        expect.objectContaining({
          nodeOptions: expect.objectContaining({
            cwd: "/workspace",
            stdio: "pipe",
          }),
        }),
      );
      expect(result).toBe("my-package@1.10.0");
    })));

    it.effect("should ignore non-semver tags like @latest", () =>
      asTest(Effect.gen(function* () {
      mockRunEffect.mockReturnValue(Effect.succeed({
        stdout: "my-package@latest\nmy-package@1.0.0\nmy-package@2.0.0\n",
        stderr: "",
        exitCode: 0,
      } as any) as any);

      const git = yield* GitService;
      const result = yield* git.getMostRecentPackageTag("/workspace", "my-package");

      expect(result).toBe("my-package@2.0.0");
    })));

    it.effect("should return undefined if no tag exists for package", () =>
      asTest(Effect.gen(function* () {
      mockRunEffect.mockReturnValue(Effect.succeed({
        stdout: "",
        stderr: "",
        exitCode: 0,
      } as any) as any);

      const git = yield* GitService;
      const result = yield* git.getMostRecentPackageTag("/workspace", "my-package");

      expect(result).toBeUndefined();
    })));

    it.effect("should return undefined if no tags exist", () =>
      asTest(Effect.gen(function* () {
      mockRunEffect.mockReturnValue(Effect.succeed({
        stdout: "",
        stderr: "",
        exitCode: 0,
      } as any) as any);

      const git = yield* GitService;
      const result = yield* git.getMostRecentPackageTag("/workspace", "my-package");

      expect(result).toBeUndefined();
    })));
  });
});
