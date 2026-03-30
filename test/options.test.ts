import { ReleaseError } from "#shared/errors";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_TYPES, normalizeReleaseScriptsOptions } from "../src/options";

const VALID_OPTIONS = {
  githubToken: "ghp_token",
  repo: "owner/repo",
} as const;

describe("normalizeReleaseScriptsOptions", () => {
  describe("validation", () => {
    it("throws ReleaseError when githubToken is empty", () => {
      expect(() => normalizeReleaseScriptsOptions({ ...VALID_OPTIONS, githubToken: "" }))
        .toThrow(ReleaseError);
    });

    it("throws ReleaseError when githubToken is only whitespace", () => {
      expect(() => normalizeReleaseScriptsOptions({ ...VALID_OPTIONS, githubToken: "   " }))
        .toThrow(ReleaseError);
    });

    it("throws ReleaseError when repo has no slash", () => {
      expect(() => normalizeReleaseScriptsOptions({ ...VALID_OPTIONS, repo: "justarepo" }))
        .toThrow(ReleaseError);
    });

    it("throws ReleaseError when repo is empty string", () => {
      expect(() => normalizeReleaseScriptsOptions({ ...VALID_OPTIONS, repo: "" }))
        .toThrow(ReleaseError);
    });
  });

  describe("defaults", () => {
    it("sets default branch names", () => {
      const opts = normalizeReleaseScriptsOptions(VALID_OPTIONS);
      expect(opts.branch.default).toBe("main");
      expect(opts.branch.release).toBe("release/next");
    });

    it("sets default npm options", () => {
      const opts = normalizeReleaseScriptsOptions(VALID_OPTIONS);
      expect(opts.npm.access).toBe("public");
      expect(opts.npm.provenance).toBe(true);
      expect(opts.npm.otp).toBeUndefined();
    });

    it("enables changelog by default", () => {
      const opts = normalizeReleaseScriptsOptions(VALID_OPTIONS);
      expect(opts.changelog.enabled).toBe(true);
      expect(opts.changelog.emojis).toBe(true);
      expect(opts.changelog.combinePrereleaseIntoFirstStable).toBe(false);
    });

    it("uses DEFAULT_TYPES when no types provided", () => {
      const opts = normalizeReleaseScriptsOptions(VALID_OPTIONS);
      expect(opts.types).toEqual(DEFAULT_TYPES);
    });

    it("enables safeguards by default", () => {
      const opts = normalizeReleaseScriptsOptions(VALID_OPTIONS);
      expect(opts.safeguards).toBe(true);
    });

    it("sets globalCommitMode to dependencies by default", () => {
      const opts = normalizeReleaseScriptsOptions(VALID_OPTIONS);
      expect(opts.globalCommitMode).toBe("dependencies");
    });
  });

  describe("owner/repo parsing", () => {
    it("splits repo into owner and repo fields", () => {
      const opts = normalizeReleaseScriptsOptions({ ...VALID_OPTIONS, repo: "acme/my-lib" });
      expect(opts.owner).toBe("acme");
      expect(opts.repo).toBe("my-lib");
    });

    it("trims whitespace from githubToken", () => {
      const opts = normalizeReleaseScriptsOptions({ ...VALID_OPTIONS, githubToken: "  tok  " });
      expect(opts.githubToken).toBe("tok");
    });
  });

  describe("packages option normalization", () => {
    it("passes true through as-is", () => {
      const opts = normalizeReleaseScriptsOptions({ ...VALID_OPTIONS, packages: true });
      expect(opts.packages).toBe(true);
    });

    it("passes string array through as-is", () => {
      const opts = normalizeReleaseScriptsOptions({ ...VALID_OPTIONS, packages: ["@scope/a"] });
      expect(opts.packages).toEqual(["@scope/a"]);
    });

    it("normalizes object form with defaults", () => {
      const opts = normalizeReleaseScriptsOptions({ ...VALID_OPTIONS, packages: {} });
      expect(opts.packages).toEqual({ include: [], exclude: [], excludePrivate: false });
    });

    it("preserves provided include/exclude/excludePrivate values", () => {
      const opts = normalizeReleaseScriptsOptions({
        ...VALID_OPTIONS,
        packages: { include: ["@a/b"], exclude: ["@c/d"], excludePrivate: true },
      });
      expect(opts.packages).toEqual({ include: ["@a/b"], exclude: ["@c/d"], excludePrivate: true });
    });
  });

  describe("types merging", () => {
    it("merges custom types on top of DEFAULT_TYPES", () => {
      const opts = normalizeReleaseScriptsOptions({
        ...VALID_OPTIONS,
        types: { refactor: { title: "♻️ Refactors" } },
      });
      expect(opts.types.feat).toEqual(DEFAULT_TYPES.feat);
      expect(opts.types.refactor).toEqual({ title: "♻️ Refactors" });
    });

    it("allows overriding a default type", () => {
      const opts = normalizeReleaseScriptsOptions({
        ...VALID_OPTIONS,
        types: { feat: { title: "✨ Features" } },
      });
      expect(opts.types.feat).toEqual({ title: "✨ Features" });
    });
  });

  describe("ci mode", () => {
    beforeEach(() => {
      process.env.CI = "true";
    });

    afterEach(() => {
      delete process.env.CI;
    });

    it("disables prompts when CI=true", () => {
      const opts = normalizeReleaseScriptsOptions(VALID_OPTIONS);
      expect(opts.prompts.versions).toBe(false);
      expect(opts.prompts.packages).toBe(false);
    });
  });
});
