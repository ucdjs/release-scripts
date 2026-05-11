import { NodeServices } from "@effect/platform-node";
import { NpmService, NpmServiceLive } from "../../src/services/npm";
import { runIfNotDryEffect } from "#shared/utils";
import { expect, it, layer } from "@effect/vitest";
import { Cause, Effect, Layer } from "effect";
import { HttpResponse } from "msw";
import { afterEach, assert, beforeEach, vi } from "vitest";

import { mockFetch, NPM_REGISTRY } from "../_msw";
import { createNormalizedReleaseOptions } from "../_shared";

vi.mock("#shared/utils", async () => {
  const actual = await vi.importActual<typeof import("#shared/utils")>("#shared/utils");
  return {
    ...actual,
    runIfNotDryEffect: vi.fn(),
  };
});

const mockRunIfNotDryEffect = vi.mocked(runIfNotDryEffect);
const asTest = (effect: Effect.Effect<void, unknown, unknown>): any => effect;

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

layer(Layer.mergeAll(NodeServices.layer, NpmServiceLive))("checkVersionExists", (it) => {
  it.effect("returns false when the package does not exist on the registry (404)", () =>
    asTest(Effect.gen(function* () {
    mockFetch("GET", `${NPM_REGISTRY}/:pkg`, () => {
      return HttpResponse.json({ error: "Not found" }, { status: 404 });
    });

    const npm = yield* NpmService;
    const result = yield* npm.checkVersionExists("my-package", "1.0.0");
    expect(result).toBe(false);
  })));

  it.effect("returns true when the requested version exists", () =>
    asTest(Effect.gen(function* () {
    mockFetch("GET", `${NPM_REGISTRY}/:pkg`, () => {
      return HttpResponse.json({
        name: "my-package",
        "dist-tags": { latest: "1.1.0" },
        versions: { "1.0.0": {}, "1.1.0": {} },
      });
    });

    const npm = yield* NpmService;
    const result = yield* npm.checkVersionExists("my-package", "1.0.0");
    expect(result).toBe(true);
  })));

  it.effect("returns false when the package exists but the requested version does not", () =>
    asTest(Effect.gen(function* () {
    mockFetch("GET", `${NPM_REGISTRY}/:pkg`, () => {
      return HttpResponse.json({
        name: "my-package",
        "dist-tags": { latest: "1.1.0" },
        versions: { "1.0.0": {}, "1.1.0": {} },
      });
    });

    const npm = yield* NpmService;
    const result = yield* npm.checkVersionExists("my-package", "2.0.0");
    expect(result).toBe(false);
  })));

  it.effect("returns err on a non-404 registry error", () =>
    asTest(Effect.gen(function* () {
    mockFetch("GET", `${NPM_REGISTRY}/:pkg`, () => {
      return HttpResponse.json({ error: "Service Unavailable" }, { status: 503 });
    });

    const npm = yield* NpmService;
    const exit = yield* Effect.exit(npm.checkVersionExists("my-package", "1.0.0"));
    assert(exit._tag === "Failure");
    expect((Cause.squash(exit.cause) as any)._tag).toBe("NPMError");
  })));

  it.effect("url-encodes scoped package names correctly", () =>
    asTest(Effect.gen(function* () {
    let capturedUrl = "";
    mockFetch("GET", `${NPM_REGISTRY}/:pkg`, ({ request }) => {
      capturedUrl = request.url;
      return HttpResponse.json({
        name: "@scope/pkg",
        "dist-tags": { latest: "0.1.0" },
        versions: { "0.1.0": {} },
      });
    });

    const npm = yield* NpmService;
    yield* npm.checkVersionExists("@scope/pkg", "0.1.0");
    // @scope/pkg is encoded as @scope%2Fpkg (single path segment)
    expect(capturedUrl).toContain("@scope%2Fpkg");
  })));

  it.effect("respects NPM_CONFIG_REGISTRY env var", () =>
    asTest(Effect.gen(function* () {
    process.env.NPM_CONFIG_REGISTRY = "https://my-registry.example.com";

    mockFetch("GET", "https://my-registry.example.com/:pkg", () => {
      return HttpResponse.json({
        name: "my-package",
        "dist-tags": { latest: "3.0.0" },
        versions: { "3.0.0": {} },
      });
    });

    const npm = yield* NpmService;
    const result = yield* npm.checkVersionExists("my-package", "3.0.0");
    expect(result).toBe(true);
  })));

  it.effect("returns err with ENETWORK code on network failure", () =>
    asTest(Effect.gen(function* () {
    mockFetch("GET", `${NPM_REGISTRY}/:pkg`, () => {
      return HttpResponse.error();
    });

    const npm = yield* NpmService;
    const exit = yield* Effect.exit(npm.checkVersionExists("my-package", "1.0.0"));
    assert(exit._tag === "Failure");
    const error = Cause.squash(exit.cause) as any;
    expect(error._tag).toBe("NPMError");
    expect(error.code).toBe("ENETWORK");
  })));
});

layer(Layer.mergeAll(NodeServices.layer, NpmServiceLive))("publishPackage", (it) => {
  it.effect("passes --tag beta for a beta prerelease version", () =>
    asTest(Effect.gen(function* () {
    mockRunIfNotDryEffect.mockReturnValue(Effect.succeed({ stdout: "", stderr: "", exitCode: 0 } as any) as any);

    const npm = yield* NpmService;
    yield* npm.publishPackage(
      "@scope/pkg",
      "1.0.0-beta.1",
      "/workspace",
      createNormalizedReleaseOptions({ dryRun: false }),
    );

    expect(mockRunIfNotDryEffect).toHaveBeenCalledWith(
      "pnpm",
      expect.arrayContaining(["--tag", "beta"]),
      expect.anything(),
    );
  })));

  it.effect("passes --tag alpha for an alpha prerelease version", () =>
    asTest(Effect.gen(function* () {
    mockRunIfNotDryEffect.mockReturnValue(Effect.succeed({ stdout: "", stderr: "", exitCode: 0 } as any) as any);

    const npm = yield* NpmService;
    yield* npm.publishPackage(
      "@scope/pkg",
      "1.0.0-alpha.1",
      "/workspace",
      createNormalizedReleaseOptions({ dryRun: false }),
    );

    expect(mockRunIfNotDryEffect).toHaveBeenCalledWith(
      "pnpm",
      expect.arrayContaining(["--tag", "alpha"]),
      expect.anything(),
    );
  })));

  it.effect("passes --tag next for an unrecognised prerelease identifier", () =>
    asTest(Effect.gen(function* () {
    mockRunIfNotDryEffect.mockReturnValue(Effect.succeed({ stdout: "", stderr: "", exitCode: 0 } as any) as any);

    const npm = yield* NpmService;
    yield* npm.publishPackage(
      "@scope/pkg",
      "1.0.0-rc.1",
      "/workspace",
      createNormalizedReleaseOptions({ dryRun: false }),
    );

    expect(mockRunIfNotDryEffect).toHaveBeenCalledWith(
      "pnpm",
      expect.arrayContaining(["--tag", "next"]),
      expect.anything(),
    );
  })));

  it.effect("does not pass --tag for a stable release", () =>
    asTest(Effect.gen(function* () {
    mockRunIfNotDryEffect.mockReturnValue(Effect.succeed({ stdout: "", stderr: "", exitCode: 0 } as any) as any);

    const npm = yield* NpmService;
    yield* npm.publishPackage(
      "@scope/pkg",
      "1.0.0",
      "/workspace",
      createNormalizedReleaseOptions({ dryRun: false }),
    );

    expect(mockRunIfNotDryEffect).toHaveBeenCalledWith(
      "pnpm",
      expect.not.arrayContaining(["--tag"]),
      expect.anything(),
    );
  })));

  it.effect("passes --otp when npm.otp is set in options", () =>
    asTest(Effect.gen(function* () {
    mockRunIfNotDryEffect.mockReturnValue(Effect.succeed({ stdout: "", stderr: "", exitCode: 0 } as any) as any);

    const npm = yield* NpmService;
    yield* npm.publishPackage(
      "@scope/pkg",
      "1.0.0",
      "/workspace",
      createNormalizedReleaseOptions({
        dryRun: false,
        npm: { otp: "123456", provenance: true, access: "public" },
      }),
    );

    expect(mockRunIfNotDryEffect).toHaveBeenCalledWith(
      "pnpm",
      expect.arrayContaining(["--otp", "123456"]),
      expect.anything(),
    );
  })));
});
