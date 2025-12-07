import type { ReleaseScriptsOptionsInput } from "../src/options";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import {
  normalizeReleaseScriptsOptions,
  ReleaseScriptsOptions,
} from "../src/options";

describe("normalizeReleaseScriptsOptions - global", () => {
  it("normalizes minimal valid input", () => {
    const input: ReleaseScriptsOptionsInput = {
      repo: "octocat/hello-world",
      githubToken: "token123",
    };

    const result = normalizeReleaseScriptsOptions(input);
    expect(result.owner).toBe("octocat");
    expect(result.repo).toBe("hello-world");
    expect(result.githubToken).toBe("token123");
    expect(result.dryRun).toBe(false);
    expect(result.workspaceRoot).toBeDefined();
    expect(result.packages).toBe(true);
    expect(result.branch.release).toBe("release/next");
    expect(result.branch.default).toBe("main");
    expect(result.globalCommitMode).toBe("dependencies");
  });

  it("throws if repo is missing or invalid", () => {
    expect(() => normalizeReleaseScriptsOptions({ githubToken: "token", repo: "invalid/" })).toThrow();
    expect(() => normalizeReleaseScriptsOptions({ githubToken: "token", repo: "/invalid" })).toThrow();
  });

  it("throws if githubToken is missing", () => {
    expect(() => normalizeReleaseScriptsOptions({ repo: "octocat/hello-world", githubToken: "" })).toThrow();
  });

  it("normalizes packages object", () => {
    const input: ReleaseScriptsOptionsInput = {
      repo: "octocat/hello-world",
      githubToken: "token",
      packages: { exclude: ["foo"], include: ["bar"], excludePrivate: true },
    };
    const result = normalizeReleaseScriptsOptions(input);
    expect(result.packages).toEqual({ exclude: ["foo"], include: ["bar"], excludePrivate: true });
  });
});

describe("normalizeReleaseScriptsOptions - prepare", () => {
  it("normalizes default values", () => {
    const result = normalizeReleaseScriptsOptions({ repo: "octocat/hello-world", githubToken: "token" });
    expect(result.pullRequest.title).toBe("chore: release new version");
    expect(result.pullRequest.body).toContain("This PR contains the following changes");
    expect(result.changelog.enabled).toBe(true);
    expect(result.changelog.template).toContain("# Changelog");
  });

  it("overrides pullRequest and changelog", () => {
    const input: ReleaseScriptsOptionsInput = {
      repo: "octocat/hello-world",
      githubToken: "token",
      pullRequest: { title: "custom title", body: "custom body" },
      changelog: { enabled: false, template: "custom template" },
    };
    const result = normalizeReleaseScriptsOptions(input);
    expect(result.pullRequest.title).toBe("custom title");
    expect(result.pullRequest.body).toBe("custom body");
    expect(result.changelog.enabled).toBe(false);
    expect(result.changelog.template).toBe("custom template");
  });
});

describe("Context.Tag dependency injection", () => {
  it.effect("injects and accesses ReleaseScriptsOptions (global)", () =>
    Effect.gen(function* (_) {
      const value = yield* _(ReleaseScriptsOptions);

      expect(value.owner).toBe("octocat");
      expect(value.repo).toBe("hello-world");
      expect(value.githubToken).toBe("token");
    }).pipe(
      Effect.provideService(ReleaseScriptsOptions, normalizeReleaseScriptsOptions({ repo: "octocat/hello-world", githubToken: "token" })),
    ));

  it.effect("injects and accesses ReleaseScriptsOptions (prepare)", () =>
    Effect.gen(function* (_) {
      const value = yield* _(ReleaseScriptsOptions);

      expect(value.pullRequest.title).toBe("t");
      expect(value.pullRequest.body).toBe("b");
      expect(value.changelog.enabled).toBe(false);
      expect(value.changelog.template).toBe("tpl");
    }).pipe(
      Effect.provideService(
        ReleaseScriptsOptions,
        normalizeReleaseScriptsOptions({
          repo: "octocat/hello-world",
          githubToken: "token",
          pullRequest: { title: "t", body: "b" },
          changelog: { enabled: false, template: "tpl" },
        }),
      ),
    ));
});
