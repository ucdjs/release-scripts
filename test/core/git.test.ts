import {
  createBranch,
  doesBranchExist,
  getAvailableBranches,
  getCurrentBranch,
  getDefaultBranch,
  isWorkingDirectoryClean,
} from "#core/git";
import { logger } from "#shared/utils";
import * as tinyexec from "tinyexec";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("tinyexec");
const mockExec = vi.mocked(tinyexec.exec);

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(logger, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.resetAllMocks();
});

describe("git utilities", () => {
  describe("isWorkingDirectoryClean", () => {
    it("should return true if working directory is clean", async () => {
      mockExec.mockResolvedValue({
        stdout: "",
        stderr: "",
        exitCode: 0,
      });

      const result = await isWorkingDirectoryClean("/workspace");
      expect(mockExec).toHaveBeenCalledWith(
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
    });

    it("should return false if working directory has uncommitted changes", async () => {
      mockExec.mockResolvedValue({
        stdout: " M src/index.ts\n",
        stderr: "",
        exitCode: 0,
      });

      const result = await isWorkingDirectoryClean("/workspace");
      expect(result).toBe(false);
    });

    it("should return false and log error when git command fails", async () => {
      const gitError = new Error("fatal: not a git repository");
      mockExec.mockRejectedValue(gitError);

      const result = await isWorkingDirectoryClean("/workspace");

      expect(logger.error).toHaveBeenCalledWith(
        "Error checking git status:",
        gitError,
      );
      expect(result).toBe(false);
    });
  });

  describe("branch utilities", () => {
    describe("doesBranchExist", () => {
      it("should return true if branch exists", async () => {
        mockExec.mockResolvedValue({
          stdout: "branch-sha-123456",
          stderr: "",
          exitCode: 0,
        });

        const result = await doesBranchExist("feature-branch", "/workspace");
        expect(mockExec).toHaveBeenCalledWith(
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
      });

      it("should return false if branch does not exist", async () => {
        mockExec.mockRejectedValue(new Error("fatal: Needed a single revision"));

        const result = await doesBranchExist("nonexistent-branch", "/workspace");
        expect(result).toBe(false);
      });
    });

    describe("getDefaultBranch", () => {
      it("should return the default branch name", async () => {
        mockExec.mockResolvedValue({
          stdout: "refs/remotes/origin/main\n",
          stderr: "",
          exitCode: 0,
        });

        const result = await getDefaultBranch("/workspace");

        expect(mockExec).toHaveBeenCalledWith(
          "git",
          ["symbolic-ref", "refs/remotes/origin/HEAD"],
          expect.objectContaining({
            nodeOptions: expect.objectContaining({
              stdio: "pipe",
            }),
          }),
        );

        expect(result).toBe("main");
      });

      it("should return different branch name", async () => {
        mockExec.mockResolvedValue({
          stdout: "refs/remotes/origin/develop\n",
          stderr: "",
          exitCode: 0,
        });

        const result = await getDefaultBranch("/workspace");

        expect(result).toBe("develop");
      });

      it("should return 'main' if default branch cannot be determined", async () => {
        mockExec.mockRejectedValue(new Error("Some git error"));

        const result = await getDefaultBranch("/workspace");

        expect(result).toBe("main");
      });

      it("should return 'main' if remote show output is unexpected", async () => {
        mockExec.mockResolvedValue({
          stdout: "Some unexpected output\n",
          stderr: "",
          exitCode: 0,
        });

        const result = await getDefaultBranch("/workspace");

        expect(result).toBe("main");
      });
    });

    describe("getCurrentBranch", () => {
      it("should return the current branch name", async () => {
        mockExec.mockResolvedValue({
          stdout: "feature-branch\n",
          stderr: "",
          exitCode: 0,
        });

        const result = await getCurrentBranch("/workspace");

        expect(mockExec).toHaveBeenCalledWith(
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
      });

      it("should handle errors and throw", async () => {
        mockExec.mockRejectedValue(new Error("Some git error"));

        await expect(getCurrentBranch("/workspace")).rejects.toThrow(
          "Some git error",
        );
      });
    });

    describe("getAvailableBranches", () => {
      it("should return a list of available branches", async () => {
        mockExec.mockResolvedValue({
          stdout: "  main\n* feature-branch\ndevelop\n",
          stderr: "",
          exitCode: 0,
        });

        const result = await getAvailableBranches("/workspace");

        expect(mockExec).toHaveBeenCalledWith(
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
      });

      it("should handle errors and throw", async () => {
        mockExec.mockRejectedValue(new Error("Some git error"));

        await expect(getAvailableBranches("/workspace")).rejects.toThrow(
          "Some git error",
        );
      });
    });

    describe("createBranch", () => {
      it("should create a new branch from the specified base branch", async () => {
        mockExec.mockResolvedValue({
          stdout: "",
          stderr: "",
          exitCode: 0,
        });

        await createBranch("new-feature", "main", "/workspace");

        expect(mockExec).toHaveBeenCalledWith(
          "git",
          ["checkout", "-b", "new-feature", "main"],
          expect.objectContaining({
            nodeOptions: expect.objectContaining({
              cwd: "/workspace",
              stdio: "pipe",
            }),
          }),
        );
      });

      it.todo("should handle errors and throw", async () => {
        mockExec.mockRejectedValue(new Error("Some git error"));

        await expect(
          createBranch("new-feature", "main", "/workspace"),
        ).rejects.toThrow("Some git error");
      });
    });
  });
});
