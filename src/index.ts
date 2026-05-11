import { NodeServices } from "@effect/platform-node";
import { Effect, Layer } from "effect";

import { logger } from "./errors";
import type { ReleaseResult } from "./types";
import { ChangelogServiceLive } from "./services/changelog";
import { prepareWorkflow as release } from "./prepare";
import { publishWorkflow as publish } from "./publish";
import { verifyWorkflow as verify } from "./verify";

import type { WorkspacePackage } from "./services/workspace";
import { GitHubServiceLive } from "./services/github";
import { PromptServiceLive } from "./services/prompts";
import { WorkspaceService, WorkspaceServiceLive } from "./services/workspace";
import type { ReleaseScriptsOptionsInput } from "./options";
import { normalizeReleaseScriptsOptions, ReleaseOptions } from "./options";
import { GitServiceLive } from "./services/git";
import { NpmServiceLive } from "./services/npm";

export interface ReleaseScripts {
  verify: () => Promise<void>;
  prepare: () => Promise<ReleaseResult | null>;
  publish: () => Promise<void>;
  packages: {
    list: () => Promise<WorkspacePackage[]>;
    get: (packageName: string) => Promise<WorkspacePackage | undefined>;
  };
}

export function createReleaseScripts(
  options: ReleaseScriptsOptionsInput,
): ReleaseScripts {
  // Normalize options once for packages.list and packages.get
  const normalizedOptions = normalizeReleaseScriptsOptions(options);

  logger.verbose("Release scripts config", {
    repo: `${normalizedOptions.owner}/${normalizedOptions.repo}`,
    workspaceRoot: normalizedOptions.workspaceRoot,
    dryRun: normalizedOptions.dryRun,
    safeguards: normalizedOptions.safeguards,
    branch: normalizedOptions.branch,
    globalCommitMode: normalizedOptions.globalCommitMode,
    prompts: normalizedOptions.prompts,
    packages: normalizedOptions.packages,
    npm: {
      access: normalizedOptions.npm.access,
      provenance: normalizedOptions.npm.provenance,
      otp: normalizedOptions.npm.otp ? "set" : "unset",
    },
    changelog: normalizedOptions.changelog,
  });

  const runtimeLayer = Layer.mergeAll(
    NodeServices.layer,
    Layer.succeed(ReleaseOptions, normalizedOptions),
    GitServiceLive,
    GitHubServiceLive,
    NpmServiceLive,
    ChangelogServiceLive,
    PromptServiceLive,
    WorkspaceServiceLive,
  );

  const runEffect = <A, E, R>(effect: Effect.Effect<A, E, R>): Promise<A> =>
    Effect.runPromise(effect.pipe(Effect.provide(runtimeLayer)) as Effect.Effect<A, E>);

  return {
    verify(): Promise<void> {
      return runEffect(verify());
    },
    prepare(): Promise<ReleaseResult | null> {
      return runEffect(release());
    },
    publish(): Promise<void> {
      return runEffect(publish());
    },
    packages: {
      list(): Promise<WorkspacePackage[]> {
        return runEffect(
          Effect.gen(function* () {
            const workspace = yield* WorkspaceService;
            return yield* workspace.discoverWorkspacePackages(
              normalizedOptions.workspaceRoot,
              normalizedOptions,
            );
          }),
        );
      },
      get(packageName: string): Promise<WorkspacePackage | undefined> {
        return runEffect(
          Effect.gen(function* () {
            const workspace = yield* WorkspaceService;
            const packages = yield* workspace.discoverWorkspacePackages(
              normalizedOptions.workspaceRoot,
              normalizedOptions,
            );
            return packages.find((p) => p.name === packageName);
          }),
        );
      },
    },
  };
}
