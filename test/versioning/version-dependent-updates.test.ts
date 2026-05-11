import { PromptServiceLive } from "../../src/services/prompts";
import type { PackageRelease } from "../../src/types";
import { calculateAndPrepareVersionUpdates } from "../../src/versions";
import { Effect } from "effect";
import { expect, it } from "@effect/vitest";
import { describe, vi } from "vitest";

import { createWorkspacePackage } from "../_shared";

vi.mock("../../src/services/prompts", async () => {
  const actual = await vi.importActual<typeof import("../../src/services/prompts")>("../../src/services/prompts");
  return {
    ...actual,
    confirmOverridePrompt: vi.fn(),
    selectVersionPrompt: vi.fn(),
  };
});

describe("calculateAndPrepareVersionUpdates (dependent updates)", () => {
  it.effect("adds dependent patch bumps and preserves direct updates", () =>
    Effect.gen(function* () {
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

    const result = yield* calculateAndPrepareVersionUpdates({
      workspacePackages,
      packageCommits,
      workspaceRoot: "/repo",
      showPrompt: false,
      globalCommitsPerPackage,
      overrides: {},
    }).pipe(Effect.provide(PromptServiceLive));

    const byName = new Map(result.allUpdates.map((update) => [update.package.name, update]));

    expect(result.allUpdates.map((update) => update.package.name).toSorted()).toEqual(
      ["pkg-a", "pkg-b", "pkg-c"].toSorted(),
    );

    expect(byName.get("pkg-b")?.bumpType).toBe("minor");
    expect(byName.get("pkg-b")?.newVersion).toBe("1.1.0");
    expect(byName.get("pkg-c")?.bumpType).toBe("patch");
    expect(byName.get("pkg-c")?.newVersion).toBe("1.0.1");
    expect(byName.get("pkg-a")?.bumpType).toBe("patch");
    expect(byName.get("pkg-a")?.newVersion).toBe("1.0.1");
  }));

  it.effect("respects overrides that exclude dependent bumps", () =>
    Effect.gen(function* () {
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
    const packageCommits = new Map([
      ["pkg-b", [{ type: "feat", isConventional: true, isBreaking: false } as any]],
    ]);
    const globalCommitsPerPackage = new Map();

    const result = yield* calculateAndPrepareVersionUpdates({
      workspacePackages,
      packageCommits,
      workspaceRoot: "/repo",
      showPrompt: false,
      globalCommitsPerPackage,
      overrides: {
        "pkg-a": { type: "none", version: "1.0.0" },
      },
    }).pipe(Effect.provide(PromptServiceLive));

    const updatedNames = result.allUpdates.map((update) => update.package.name).toSorted();
    expect(updatedNames).toEqual(["pkg-b"]);
  }));

  it.effect("does not add dependents when there are no direct updates", () =>
    Effect.gen(function* () {
    const pkgA = createWorkspacePackage("/repo/packages/a", {
      name: "pkg-a",
      version: "1.0.0",
    });
    const workspacePackages = [pkgA];

    const result = yield* calculateAndPrepareVersionUpdates({
      workspacePackages,
      packageCommits: new Map(),
      workspaceRoot: "/repo",
      showPrompt: false,
      globalCommitsPerPackage: new Map(),
      overrides: {},
    }).pipe(Effect.provide(PromptServiceLive));

    expect(result.allUpdates).toEqual([] as PackageRelease[]);
  }));
});
