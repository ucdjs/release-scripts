import type { GitCommit } from "commit-parser";
import { determineHighestBump, getMostRecentPackageTag } from "#versioning/commits";
import * as tinyexec from "tinyexec";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

function createFakeCommit(commit: Partial<GitCommit>): GitCommit {
  return commit as GitCommit;
}

vi.mock("tinyexec");

afterEach(() => {
  vi.resetAllMocks();
});

describe("getMostRecentPackageTag", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should return the last tag for a package", async () => {
    const mockExec = vi.mocked(tinyexec.exec);
    mockExec.mockResolvedValue({
      stdout: "other-package@1.0.0\nmy-package@1.2.0\nmy-package@1.1.0\n",
      stderr: "",
      exitCode: 0,
    } as any);

    const result = await getMostRecentPackageTag("/workspace", "my-package");

    expect(mockExec).toHaveBeenCalledWith(
      "git",
      ["tag", "--list", "my-package@*"],
      expect.objectContaining({
        nodeOptions: expect.objectContaining({
          cwd: "/workspace",
          stdio: "pipe",
        }),
      }),
    );
    expect(result).toBe("my-package@1.1.0");
  });

  it("should return undefined if no tag exists for package", async () => {
    const mockExec = vi.mocked(tinyexec.exec);
    mockExec.mockResolvedValue({
      stdout: "",
      stderr: "",
      exitCode: 0,
    } as any);

    const result = await getMostRecentPackageTag("/workspace", "my-package");

    expect(result).toBeUndefined();
  });

  it("should return undefined if no tags exist", async () => {
    const mockExec = vi.mocked(tinyexec.exec);
    mockExec.mockResolvedValue({
      stdout: "",
      stderr: "",
      exitCode: 0,
    } as any);

    const result = await getMostRecentPackageTag("/workspace", "my-package");

    expect(result).toBeUndefined();
  });
});

describe("determineHighestBump", () => {
  it("should return 'none' for empty commit list", () => {
    const result = determineHighestBump([]);
    expect(result).toBe("none");
  });

  it("should return 'patch' if only patch commits are present", () => {
    const result = determineHighestBump([
      createFakeCommit({
        message: "fix: bug fix",
        type: "fix",
        isConventional: true,
      }),
      createFakeCommit({
        message: "chore: update dependencies",
        type: "fix",
        isConventional: true,
      }),
    ]);

    expect(result).toBe("patch");
  });

  it("should return 'minor' if minor and patch commits are present", () => {
    const result = determineHighestBump([
      createFakeCommit({
        message: "feat: new feature",
        type: "feat",
        isConventional: true,
      }),
      createFakeCommit({
        message: "fix: bug fix",
        type: "fix",
        isConventional: true,
      }),
    ]);

    expect(result).toBe("minor");
  });

  it("should return 'major' if a breaking change commit is present", () => {
    const result = determineHighestBump([
      createFakeCommit({
        message: "feat: new feature\n\nBREAKING CHANGE: changes API",
        type: "feat",
        isConventional: true,
        isBreaking: true,
      }),
      createFakeCommit({
        message: "fix: bug fix",
        type: "fix",
        isConventional: true,
      }),
    ]);

    expect(result).toBe("major");
  });

  it("should ignore non-conventional commits", () => {
    const result = determineHighestBump([
      createFakeCommit({
        message: "Some random commit message",
      }),
      createFakeCommit({
        message: "fix: bug fix",
        type: "fix",
        isConventional: true,
      }),
    ]);

    expect(result).toBe("patch");
  });
});
