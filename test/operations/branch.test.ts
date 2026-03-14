import * as git from "#core/git";
import { prepareReleaseBranch } from "#operations/branch";
import { ok } from "#types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("#core/git");

const mockedGit = vi.mocked(git);

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.resetAllMocks();
});

describe("prepareReleaseBranch", () => {
  const baseOptions = {
    workspaceRoot: "/workspace",
    releaseBranch: "release/next",
    defaultBranch: "main",
  };

  it("skips pull when remote branch does not exist", async () => {
    mockedGit.getCurrentBranch.mockResolvedValue(ok("main"));
    mockedGit.doesBranchExist.mockResolvedValue(ok(true));
    mockedGit.doesRemoteBranchExist.mockResolvedValue(ok(false));
    mockedGit.checkoutBranch.mockResolvedValue(ok(true));
    mockedGit.rebaseBranch.mockResolvedValue(ok(undefined));

    const result = await prepareReleaseBranch(baseOptions);

    expect(result.ok).toBe(true);
    expect(mockedGit.doesRemoteBranchExist).toHaveBeenCalledWith("release/next", "/workspace");
    expect(mockedGit.pullLatestChanges).not.toHaveBeenCalled();
  });

  it("pulls when remote branch exists", async () => {
    mockedGit.getCurrentBranch.mockResolvedValue(ok("main"));
    mockedGit.doesBranchExist.mockResolvedValue(ok(true));
    mockedGit.doesRemoteBranchExist.mockResolvedValue(ok(true));
    mockedGit.checkoutBranch.mockResolvedValue(ok(true));
    mockedGit.pullLatestChanges.mockResolvedValue(ok(true));
    mockedGit.rebaseBranch.mockResolvedValue(ok(undefined));

    const result = await prepareReleaseBranch(baseOptions);

    expect(result.ok).toBe(true);
    expect(mockedGit.pullLatestChanges).toHaveBeenCalledWith("release/next", "/workspace");
  });

  it("creates branch when it does not exist locally", async () => {
    mockedGit.getCurrentBranch.mockResolvedValue(ok("main"));
    mockedGit.doesBranchExist.mockResolvedValue(ok(false));
    mockedGit.createBranch.mockResolvedValue(ok(undefined));
    mockedGit.checkoutBranch.mockResolvedValue(ok(true));
    mockedGit.rebaseBranch.mockResolvedValue(ok(undefined));

    const result = await prepareReleaseBranch(baseOptions);

    expect(result.ok).toBe(true);
    expect(mockedGit.createBranch).toHaveBeenCalledWith("release/next", "main", "/workspace");
    expect(mockedGit.doesRemoteBranchExist).not.toHaveBeenCalled();
    expect(mockedGit.pullLatestChanges).not.toHaveBeenCalled();
  });
});
