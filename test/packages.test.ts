import { PromptServiceLive } from "../src/services/prompts";
import { getNextVersion } from "../src/versions";
import type { PackageRelease } from "../src/types";
import {
  buildPackageDependencyGraph,
  createDependentUpdates,
  getAllAffectedPackages,
  getPackagePublishOrder,
} from "../src/packages";
import { calculateAndPrepareVersionUpdates } from "../src/versions";
import { Effect } from "effect";
import { expect, it } from "@effect/vitest";
import { describe, vi } from "vitest";

import { createWorkspacePackage } from "./_shared";

vi.mock("../src/services/prompts", async () => {
  const actual = await vi.importActual<typeof import("../src/services/prompts")>("../src/services/prompts");
  return {
    ...actual,
    confirmOverridePrompt: vi.fn(),
    selectVersionPrompt: vi.fn(),
  };
});

function createRelease(
  pkg: ReturnType<typeof createWorkspacePackage>,
  bump: PackageRelease["bumpType"],
  hasDirectChanges = true,
): PackageRelease {
  return {
    package: pkg,
    currentVersion: pkg.version,
    newVersion: getNextVersion(pkg.version, bump),
    bumpType: bump,
    hasDirectChanges,
    changeKind: "auto",
  };
}

function createWorkspaceFixture() {
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
  const pkgE = createWorkspacePackage("/repo/packages/e", {
    name: "pkg-e",
    version: "1.0.0",
    workspaceDevDependencies: ["pkg-a"],
  });

  return {
    pkgA,
    pkgB,
    pkgC,
    pkgD,
    pkgE,
    packages: [pkgA, pkgB, pkgC, pkgD, pkgE],
  };
}

describe("package dependency graph", () => {
  it("builds dependents mapping from workspace deps", () => {
    const { packages } = createWorkspaceFixture();
    const graph = buildPackageDependencyGraph(packages);

    expect(graph.packages.size).toBe(5);
    expect([...graph.dependents.get("pkg-d")!]).toEqual(["pkg-b", "pkg-c"]);
    expect([...graph.dependents.get("pkg-b")!]).toEqual(["pkg-a"]);
    expect([...graph.dependents.get("pkg-c")!]).toEqual(["pkg-a"]);
    expect([...graph.dependents.get("pkg-a")!]).toEqual(["pkg-e"]);
    expect([...graph.dependents.get("pkg-e")!]).toEqual([]);
  });

  it("calculates transitive affected packages", () => {
    const { packages } = createWorkspaceFixture();
    const graph = buildPackageDependencyGraph(packages);

    const affectedFromD = getAllAffectedPackages(graph, new Set(["pkg-d"]));
    expect([...affectedFromD].toSorted()).toEqual(
      ["pkg-a", "pkg-b", "pkg-c", "pkg-d", "pkg-e"].toSorted(),
    );

    const affectedFromB = getAllAffectedPackages(graph, new Set(["pkg-b"]));
    expect([...affectedFromB].toSorted()).toEqual(["pkg-a", "pkg-b", "pkg-e"].toSorted());
  });

  it("orders publish list by dependency level (stable)", () => {
    const { packages } = createWorkspaceFixture();
    const graph = buildPackageDependencyGraph(packages);

    const order = getPackagePublishOrder(graph, new Set(["pkg-b", "pkg-c"]));
    expect(order.map((entry) => `${entry.package.name}:${entry.level}`)).toEqual([
      "pkg-b:0",
      "pkg-c:0",
      "pkg-a:1",
    ]);

    const orderFromD = getPackagePublishOrder(graph, new Set(["pkg-d"]));
    expect(orderFromD.map((entry) => `${entry.package.name}:${entry.level}`)).toEqual([
      "pkg-d:0",
      "pkg-b:1",
      "pkg-c:1",
    ]);

    const orderFromA = getPackagePublishOrder(graph, new Set(["pkg-a"]));
    expect(orderFromA.map((entry) => `${entry.package.name}:${entry.level}`)).toEqual([
      "pkg-a:0",
      "pkg-e:1",
    ]);
  });

  it("creates dependent updates with patch bumps", () => {
    const { packages, pkgB, pkgC } = createWorkspaceFixture();
    const graph = buildPackageDependencyGraph(packages);
    const directUpdates = [createRelease(pkgB, "minor"), createRelease(pkgC, "patch")];

    const updates = createDependentUpdates(graph, packages, directUpdates);
    const byName = new Map(updates.map((update) => [update.package.name, update]));

    expect(updates).toHaveLength(4);
    expect(byName.get("pkg-a")?.bumpType).toBe("patch");
    expect(byName.get("pkg-a")?.newVersion).toBe("1.0.1");
    expect(byName.get("pkg-a")?.hasDirectChanges).toBe(false);
    expect(byName.get("pkg-e")?.bumpType).toBe("patch");
    expect(byName.get("pkg-e")?.newVersion).toBe("1.0.1");
    expect(byName.get("pkg-e")?.hasDirectChanges).toBe(false);
  });

  it("respects excluded packages for dependent bumps", () => {
    const { packages, pkgB, pkgC } = createWorkspaceFixture();
    const graph = buildPackageDependencyGraph(packages);
    const directUpdates = [createRelease(pkgB, "minor"), createRelease(pkgC, "patch")];

    const updates = createDependentUpdates(graph, packages, directUpdates, new Set(["pkg-a"]));
    const updatedNames = updates.map((update) => update.package.name).toSorted();

    expect(updatedNames).toEqual(["pkg-b", "pkg-c", "pkg-e"].toSorted());
  });
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
