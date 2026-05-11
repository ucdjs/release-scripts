import { NodeServices } from "@effect/platform-node";
import { GitService } from "../../src/services/git";
import { prepareReleaseBranch } from "../../src/release/branch";
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, vi } from "vitest";

const mockedGit = {
  isWorkingDirectoryClean: vi.fn(),
  doesRemoteBranchExist: vi.fn(),
  doesBranchExist: vi.fn(),
  getDefaultBranch: vi.fn(),
  getCurrentBranch: vi.fn(),
  checkoutBranch: vi.fn(),
  pullLatestChanges: vi.fn(),
  rebaseBranch: vi.fn(),
  isBranchAheadOfRemote: vi.fn(),
  pushBranch: vi.fn(),
  readFileFromGit: vi.fn(),
  getMostRecentPackageStableTag: vi.fn(),
  createAndPushPackageTag: vi.fn(),
  createBranch: vi.fn(),
  commitPaths: vi.fn(),
  commitChanges: vi.fn(),
  getMostRecentPackageTag: vi.fn(),
  getGroupedFilesByCommitSha: vi.fn(),
};
const withNode = <A, E, R>(effect: Effect.Effect<A, E, R>): any =>
  effect.pipe(
    Effect.provide(NodeServices.layer as any),
    Effect.provideService(GitService, {
      isWorkingDirectoryClean: mockedGit.isWorkingDirectoryClean,
      doesRemoteBranchExist: mockedGit.doesRemoteBranchExist,
      doesBranchExist: mockedGit.doesBranchExist,
      getDefaultBranch: mockedGit.getDefaultBranch,
      getCurrentBranch: mockedGit.getCurrentBranch,
      checkoutBranch: mockedGit.checkoutBranch,
      pullLatestChanges: mockedGit.pullLatestChanges,
      rebaseBranch: mockedGit.rebaseBranch,
      isBranchAheadOfRemote: mockedGit.isBranchAheadOfRemote,
      pushBranch: mockedGit.pushBranch,
      readFileFromGit: mockedGit.readFileFromGit,
      getMostRecentPackageStableTag: mockedGit.getMostRecentPackageStableTag,
      createAndPushPackageTag: mockedGit.createAndPushPackageTag,
      createBranch: mockedGit.createBranch,
      commitPaths: mockedGit.commitPaths,
      commitChanges: mockedGit.commitChanges,
      getMostRecentPackageTag: mockedGit.getMostRecentPackageTag,
      getGroupedFilesByCommitSha: mockedGit.getGroupedFilesByCommitSha,
    } as any),
  );

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

  it.effect("skips pull when remote branch does not exist", () =>
    withNode(Effect.gen(function* () {
    mockedGit.getCurrentBranch.mockReturnValue(Effect.succeed("main") as any);
    mockedGit.doesBranchExist.mockReturnValue(Effect.succeed(true) as any);
    mockedGit.doesRemoteBranchExist.mockReturnValue(Effect.succeed(false) as any);
    mockedGit.checkoutBranch.mockReturnValue(Effect.succeed(true) as any);
    mockedGit.rebaseBranch.mockReturnValue(Effect.succeed(undefined) as any);

    yield* prepareReleaseBranch(baseOptions);

    expect(mockedGit.doesRemoteBranchExist).toHaveBeenCalledWith("release/next", "/workspace");
    expect(mockedGit.pullLatestChanges).not.toHaveBeenCalled();
  })));

  it.effect("pulls when remote branch exists", () =>
    withNode(Effect.gen(function* () {
    mockedGit.getCurrentBranch.mockReturnValue(Effect.succeed("main") as any);
    mockedGit.doesBranchExist.mockReturnValue(Effect.succeed(true) as any);
    mockedGit.doesRemoteBranchExist.mockReturnValue(Effect.succeed(true) as any);
    mockedGit.checkoutBranch.mockReturnValue(Effect.succeed(true) as any);
    mockedGit.pullLatestChanges.mockReturnValue(Effect.succeed(true) as any);
    mockedGit.rebaseBranch.mockReturnValue(Effect.succeed(undefined) as any);

    yield* prepareReleaseBranch(baseOptions);

    expect(mockedGit.pullLatestChanges).toHaveBeenCalledWith("release/next", "/workspace");
  })));

  it.effect("creates branch when it does not exist locally", () =>
    withNode(Effect.gen(function* () {
    mockedGit.getCurrentBranch.mockReturnValue(Effect.succeed("main") as any);
    mockedGit.doesBranchExist.mockReturnValue(Effect.succeed(false) as any);
    mockedGit.createBranch.mockReturnValue(Effect.succeed(undefined) as any);
    mockedGit.checkoutBranch.mockReturnValue(Effect.succeed(true) as any);
    mockedGit.rebaseBranch.mockReturnValue(Effect.succeed(undefined) as any);

    yield* prepareReleaseBranch(baseOptions);

    expect(mockedGit.createBranch).toHaveBeenCalledWith("release/next", "main", "/workspace");
    expect(mockedGit.doesRemoteBranchExist).not.toHaveBeenCalled();
    expect(mockedGit.pullLatestChanges).not.toHaveBeenCalled();
  })));
});
