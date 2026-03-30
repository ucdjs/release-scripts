import type { PackageRelease } from "#shared/types";
import { calculateAndPrepareVersionUpdates } from "#versioning/version";
import { describe, expect, it, vi } from "vitest";
import { createWorkspacePackage } from "../_shared";

vi.mock("#core/prompts", () => ({
  confirmOverridePrompt: vi.fn(),
  selectVersionPrompt: vi.fn(),
}));

describe("calculateAndPrepareVersionUpdates (dependent updates)", () => {
  it("adds dependent patch bumps and preserves direct updates", async () => {
    const pkgD = createWorkspacePackage("/repo/packages/d", {
      name: "pkg-d",
      version: "1.0.0",
    });
    const pkgB = createWorkspacePackage("/repo/packages/b", {
      name: "pkg-b",
      version: "1.0.0",
      workspaceDependencies: ["pkg-d"],
    });
    const pkgC = createWorkspacePackage("/repo/packages/c", {
      name: "pkg-c",
      version: "1.0.0",
      workspaceDependencies: ["pkg-d"],
    });
    const pkgA = createWorkspacePackage("/repo/packages/a", {
      name: "pkg-a",
      version: "1.0.0",
      workspaceDependencies: ["pkg-b", "pkg-c"],
    });

    const workspacePackages = [pkgA, pkgB, pkgC, pkgD];
    const packageCommits = new Map([
      ["pkg-b", [{ type: "feat", isConventional: true, isBreaking: false } as any]],
      ["pkg-c", [{ type: "fix", isConventional: true, isBreaking: false } as any]],
    ]);
    const globalCommitsPerPackage = new Map();

    const result = await calculateAndPrepareVersionUpdates({
      workspacePackages,
      packageCommits,
      workspaceRoot: "/repo",
      showPrompt: false,
      globalCommitsPerPackage,
      overrides: {},
    });

    const byName = new Map(result.allUpdates.map((update) => [update.package.name, update]));

    expect(result.allUpdates.map((update) => update.package.name).sort()).toEqual(["pkg-a", "pkg-b", "pkg-c"].sort());

    expect(byName.get("pkg-b")?.bumpType).toBe("minor");
    expect(byName.get("pkg-b")?.newVersion).toBe("1.1.0");
    expect(byName.get("pkg-c")?.bumpType).toBe("patch");
    expect(byName.get("pkg-c")?.newVersion).toBe("1.0.1");
    expect(byName.get("pkg-a")?.bumpType).toBe("patch");
    expect(byName.get("pkg-a")?.newVersion).toBe("1.0.1");
  });

  it("respects overrides that exclude dependent bumps", async () => {
    const pkgD = createWorkspacePackage("/repo/packages/d", {
      name: "pkg-d",
      version: "1.0.0",
    });
    const pkgB = createWorkspacePackage("/repo/packages/b", {
      name: "pkg-b",
      version: "1.0.0",
      workspaceDependencies: ["pkg-d"],
    });
    const pkgA = createWorkspacePackage("/repo/packages/a", {
      name: "pkg-a",
      version: "1.0.0",
      workspaceDependencies: ["pkg-b"],
    });

    const workspacePackages = [pkgA, pkgB, pkgD];
    const packageCommits = new Map([["pkg-b", [{ type: "feat", isConventional: true, isBreaking: false } as any]]]);
    const globalCommitsPerPackage = new Map();

    const result = await calculateAndPrepareVersionUpdates({
      workspacePackages,
      packageCommits,
      workspaceRoot: "/repo",
      showPrompt: false,
      globalCommitsPerPackage,
      overrides: {
        "pkg-a": { type: "none", version: "1.0.0" },
      },
    });

    const updatedNames = result.allUpdates.map((update) => update.package.name).sort();
    expect(updatedNames).toEqual(["pkg-b"]);
  });

  it("does not add dependents when there are no direct updates", async () => {
    const pkgA = createWorkspacePackage("/repo/packages/a", {
      name: "pkg-a",
      version: "1.0.0",
    });
    const workspacePackages = [pkgA];

    const result = await calculateAndPrepareVersionUpdates({
      workspacePackages,
      packageCommits: new Map(),
      workspaceRoot: "/repo",
      showPrompt: false,
      globalCommitsPerPackage: new Map(),
      overrides: {},
    });

    expect(result.allUpdates).toEqual([] as PackageRelease[]);
  });
});
