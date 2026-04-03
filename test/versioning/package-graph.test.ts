import { getNextVersion } from "#operations/semver";
import type { PackageRelease } from "#shared/types";
import {
  buildPackageDependencyGraph,
  createDependentUpdates,
  getAllAffectedPackages,
  getPackagePublishOrder,
} from "#versioning/package";
import { describe, expect, it } from "vitest";

import { createWorkspacePackage } from "../_shared";

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
