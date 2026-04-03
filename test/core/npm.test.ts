import { checkVersionExists, publishPackage } from "#core/npm";
import { HttpResponse } from "msw";
import * as tinyexec from "tinyexec";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";

import { mockFetch, NPM_REGISTRY } from "../_msw";
import { createNormalizedReleaseOptions } from "../_shared";

vi.mock("tinyexec");

const mockExec = vi.mocked(tinyexec.exec);

let previousNpmRegistry: string | undefined;

beforeEach(() => {
  previousNpmRegistry = process.env.NPM_CONFIG_REGISTRY;
  vi.clearAllMocks();
});

afterEach(() => {
  vi.resetAllMocks();
  if (previousNpmRegistry === undefined) {
    delete process.env.NPM_CONFIG_REGISTRY;
  } else {
    process.env.NPM_CONFIG_REGISTRY = previousNpmRegistry;
  }
});

describe("checkVersionExists", () => {
  it("returns false when the package does not exist on the registry (404)", async () => {
    mockFetch("GET", `${NPM_REGISTRY}/:pkg`, () => {
      return HttpResponse.json({ error: "Not found" }, { status: 404 });
    });

    const result = await checkVersionExists("my-package", "1.0.0");
    assert(result.ok);
    expect(result.value).toBe(false);
  });

  it("returns true when the requested version exists", async () => {
    mockFetch("GET", `${NPM_REGISTRY}/:pkg`, () => {
      return HttpResponse.json({
        name: "my-package",
        "dist-tags": { latest: "1.1.0" },
        versions: { "1.0.0": {}, "1.1.0": {} },
      });
    });

    const result = await checkVersionExists("my-package", "1.0.0");
    assert(result.ok);
    expect(result.value).toBe(true);
  });

  it("returns false when the package exists but the requested version does not", async () => {
    mockFetch("GET", `${NPM_REGISTRY}/:pkg`, () => {
      return HttpResponse.json({
        name: "my-package",
        "dist-tags": { latest: "1.1.0" },
        versions: { "1.0.0": {}, "1.1.0": {} },
      });
    });

    const result = await checkVersionExists("my-package", "2.0.0");
    assert(result.ok);
    expect(result.value).toBe(false);
  });

  it("returns err on a non-404 registry error", async () => {
    mockFetch("GET", `${NPM_REGISTRY}/:pkg`, () => {
      return HttpResponse.json({ error: "Service Unavailable" }, { status: 503 });
    });

    const result = await checkVersionExists("my-package", "1.0.0");
    assert(!result.ok);
    expect(result.error.type).toBe("npm");
  });

  it("url-encodes scoped package names correctly", async () => {
    let capturedUrl = "";
    mockFetch("GET", `${NPM_REGISTRY}/:pkg`, ({ request }) => {
      capturedUrl = request.url;
      return HttpResponse.json({
        name: "@scope/pkg",
        "dist-tags": { latest: "0.1.0" },
        versions: { "0.1.0": {} },
      });
    });

    await checkVersionExists("@scope/pkg", "0.1.0");
    // @scope/pkg is encoded as @scope%2Fpkg (single path segment)
    expect(capturedUrl).toContain("@scope%2Fpkg");
  });

  it("respects NPM_CONFIG_REGISTRY env var", async () => {
    process.env.NPM_CONFIG_REGISTRY = "https://my-registry.example.com";

    mockFetch("GET", "https://my-registry.example.com/:pkg", () => {
      return HttpResponse.json({
        name: "my-package",
        "dist-tags": { latest: "3.0.0" },
        versions: { "3.0.0": {} },
      });
    });

    const result = await checkVersionExists("my-package", "3.0.0");
    assert(result.ok);
    expect(result.value).toBe(true);
  });

  it("returns err with ENETWORK code on network failure", async () => {
    mockFetch("GET", `${NPM_REGISTRY}/:pkg`, () => {
      return HttpResponse.error();
    });

    const result = await checkVersionExists("my-package", "1.0.0");
    assert(!result.ok);
    expect(result.error.type).toBe("npm");
    expect(result.error.code).toBe("ENETWORK");
  });
});

describe("publishPackage", () => {
  it("passes --tag beta for a beta prerelease version", async () => {
    mockExec.mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 } as any);

    await publishPackage(
      "@scope/pkg",
      "1.0.0-beta.1",
      "/workspace",
      createNormalizedReleaseOptions({ dryRun: false }),
    );

    expect(mockExec).toHaveBeenCalledWith(
      "pnpm",
      expect.arrayContaining(["--tag", "beta"]),
      expect.anything(),
    );
  });

  it("passes --tag alpha for an alpha prerelease version", async () => {
    mockExec.mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 } as any);

    await publishPackage(
      "@scope/pkg",
      "1.0.0-alpha.1",
      "/workspace",
      createNormalizedReleaseOptions({ dryRun: false }),
    );

    expect(mockExec).toHaveBeenCalledWith(
      "pnpm",
      expect.arrayContaining(["--tag", "alpha"]),
      expect.anything(),
    );
  });

  it("passes --tag next for an unrecognised prerelease identifier", async () => {
    mockExec.mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 } as any);

    await publishPackage(
      "@scope/pkg",
      "1.0.0-rc.1",
      "/workspace",
      createNormalizedReleaseOptions({ dryRun: false }),
    );

    expect(mockExec).toHaveBeenCalledWith(
      "pnpm",
      expect.arrayContaining(["--tag", "next"]),
      expect.anything(),
    );
  });

  it("does not pass --tag for a stable release", async () => {
    mockExec.mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 } as any);

    await publishPackage(
      "@scope/pkg",
      "1.0.0",
      "/workspace",
      createNormalizedReleaseOptions({ dryRun: false }),
    );

    expect(mockExec).toHaveBeenCalledWith(
      "pnpm",
      expect.not.arrayContaining(["--tag"]),
      expect.anything(),
    );
  });

  it("passes --otp when npm.otp is set in options", async () => {
    mockExec.mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 } as any);

    await publishPackage(
      "@scope/pkg",
      "1.0.0",
      "/workspace",
      createNormalizedReleaseOptions({
        dryRun: false,
        npm: { otp: "123456", provenance: true, access: "public" },
      }),
    );

    expect(mockExec).toHaveBeenCalledWith(
      "pnpm",
      expect.arrayContaining(["--otp", "123456"]),
      expect.anything(),
    );
  });
});
