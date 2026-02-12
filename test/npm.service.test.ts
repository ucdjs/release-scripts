import type { Context } from "effect";
import { NodeCommandExecutor, NodeFileSystem } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { afterEach, beforeEach, describe, expect, vi } from "vitest";
import { ReleaseScriptsOptions } from "../src/options";
import { NPMService } from "../src/services/npm.service";

describe("npm service", () => {
  const originalFetch = globalThis.fetch;

  const mockConfig = {
    dryRun: false,
    workspaceRoot: "/test",
    githubToken: "test-token",
    owner: "test",
    repo: "test",
    packages: true,
    branch: {
      release: "release/next",
      default: "main",
    },
    globalCommitMode: "dependencies" as const,
    pullRequest: {
      title: "test",
      body: "test",
    },
    changelog: {
      enabled: true,
      template: "",
      emojis: true,
    },
    types: {},
    npm: {
      otp: undefined,
      provenance: true,
    },
  };

  const TestConfigLayer = Layer.succeed(
    ReleaseScriptsOptions,
    mockConfig as Context.Tag.Service<typeof ReleaseScriptsOptions>,
  );

  const TestLayer = NPMService.Default.pipe(
    Layer.provide(TestConfigLayer),
    Layer.provide(NodeCommandExecutor.layer),
    Layer.provide(NodeFileSystem.layer),
  );

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const mockPackument = {
    "name": "test-package",
    "dist-tags": {
      latest: "1.2.3",
      next: "2.0.0-beta.1",
    },
    "versions": {
      "1.0.0": {
        name: "test-package",
        version: "1.0.0",
        description: "Test package v1.0.0",
        dist: {
          tarball: "https://registry.npmjs.org/test-package/-/test-package-1.0.0.tgz",
          shasum: "abc123",
          integrity: "sha512-test",
        },
      },
      "1.2.3": {
        name: "test-package",
        version: "1.2.3",
        description: "Test package v1.2.3",
        dist: {
          tarball: "https://registry.npmjs.org/test-package/-/test-package-1.2.3.tgz",
          shasum: "def456",
          integrity: "sha512-test2",
        },
      },
      "2.0.0-beta.1": {
        name: "test-package",
        version: "2.0.0-beta.1",
        description: "Test package v2.0.0-beta.1",
        dist: {
          tarball: "https://registry.npmjs.org/test-package/-/test-package-2.0.0-beta.1.tgz",
          shasum: "ghi789",
        },
      },
    },
  };

  describe("fetchPackument", () => {
    it.effect("fetches packument for an existing package", () =>
      Effect.gen(function* () {
        globalThis.fetch = vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          json: async () => mockPackument,
        });

        const npm = yield* NPMService;
        const result = yield* npm.fetchPackument("test-package");

        expect(result).toEqual(mockPackument);
        expect(globalThis.fetch).toHaveBeenCalledWith("https://registry.npmjs.org/test-package");
      }).pipe(Effect.provide(TestLayer)));

    it.effect("returns null for non-existent package (404)", () =>
      Effect.gen(function* () {
        globalThis.fetch = vi.fn().mockResolvedValue({
          ok: false,
          status: 404,
        });

        const npm = yield* NPMService;
        const result = yield* npm.fetchPackument("non-existent-package");

        expect(result).toBeNull();
        expect(globalThis.fetch).toHaveBeenCalledWith("https://registry.npmjs.org/non-existent-package");
      }).pipe(Effect.provide(TestLayer)));

    it.effect("fails with NPMError on network error", () =>
      Effect.gen(function* () {
        globalThis.fetch = vi.fn().mockRejectedValue(new Error("Network error"));

        const npm = yield* NPMService;
        const result = yield* npm.fetchPackument("test-package").pipe(Effect.flip);

        expect(result._tag).toBe("NPMError");
        expect(result.message).toContain("Network error");
      }).pipe(Effect.provide(TestLayer)));

    it.effect("fails with NPMError on non-404 HTTP error", () =>
      Effect.gen(function* () {
        globalThis.fetch = vi.fn().mockResolvedValue({
          ok: false,
          status: 500,
          statusText: "Internal Server Error",
        });

        const npm = yield* NPMService;
        const result = yield* npm.fetchPackument("test-package").pipe(Effect.flip);

        expect(result._tag).toBe("NPMError");
        expect(result.message).toContain("Failed to fetch packument: Internal Server Error");
      }).pipe(Effect.provide(TestLayer)));
  });

  describe("versionExists", () => {
    it.effect("returns true when version exists", () =>
      Effect.gen(function* () {
        globalThis.fetch = vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          json: async () => mockPackument,
        });

        const npm = yield* NPMService;
        const result = yield* npm.versionExists("test-package", "1.2.3");

        expect(result).toBe(true);
      }).pipe(Effect.provide(TestLayer)));

    it.effect("returns true for beta version", () =>
      Effect.gen(function* () {
        globalThis.fetch = vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          json: async () => mockPackument,
        });

        const npm = yield* NPMService;
        const result = yield* npm.versionExists("test-package", "2.0.0-beta.1");

        expect(result).toBe(true);
      }).pipe(Effect.provide(TestLayer)));

    it.effect("returns false when version does not exist", () =>
      Effect.gen(function* () {
        globalThis.fetch = vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          json: async () => mockPackument,
        });

        const npm = yield* NPMService;
        const result = yield* npm.versionExists("test-package", "99.99.99");

        expect(result).toBe(false);
      }).pipe(Effect.provide(TestLayer)));

    it.effect("returns false when package does not exist", () =>
      Effect.gen(function* () {
        globalThis.fetch = vi.fn().mockResolvedValue({
          ok: false,
          status: 404,
        });

        const npm = yield* NPMService;
        const result = yield* npm.versionExists("non-existent-package", "1.0.0");

        expect(result).toBe(false);
      }).pipe(Effect.provide(TestLayer)));
  });

  describe("getLatestVersion", () => {
    it.effect("returns latest version from dist-tags", () =>
      Effect.gen(function* () {
        globalThis.fetch = vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          json: async () => mockPackument,
        });

        const npm = yield* NPMService;
        const result = yield* npm.getLatestVersion("test-package");

        expect(result).toBe("1.2.3");
      }).pipe(Effect.provide(TestLayer)));

    it.effect("returns null when package does not exist", () =>
      Effect.gen(function* () {
        globalThis.fetch = vi.fn().mockResolvedValue({
          ok: false,
          status: 404,
        });

        const npm = yield* NPMService;
        const result = yield* npm.getLatestVersion("non-existent-package");

        expect(result).toBeNull();
      }).pipe(Effect.provide(TestLayer)));

    it.effect("returns null when dist-tags has no latest tag", () =>
      Effect.gen(function* () {
        const packumentWithoutLatest = {
          ...mockPackument,
          "dist-tags": {
            next: "2.0.0-beta.1",
          },
        };

        globalThis.fetch = vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          json: async () => packumentWithoutLatest,
        });

        const npm = yield* NPMService;
        const result = yield* npm.getLatestVersion("test-package");

        expect(result).toBeNull();
      }).pipe(Effect.provide(TestLayer)));
  });
});
