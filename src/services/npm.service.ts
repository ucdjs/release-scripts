import { Command, CommandExecutor } from "@effect/platform";
import { Effect, Schema } from "effect";
import { NPMError, PublishError } from "../errors";
import { ReleaseScriptsOptions } from "../options";

export interface PublishOptions {
  packagePath: string;
  tagName?: string;
  otp?: string;
  provenance?: boolean;
  dryRun?: boolean;
}

// Schema for npm packument (package document)
export const PackumentSchema = Schema.Struct({
  "name": Schema.String,
  "dist-tags": Schema.Record({ key: Schema.String, value: Schema.String }),
  "versions": Schema.Record({
    key: Schema.String,
    value: Schema.Struct({
      name: Schema.String,
      version: Schema.String,
      description: Schema.optional(Schema.String),
      dist: Schema.Struct({
        tarball: Schema.String,
        shasum: Schema.String,
        integrity: Schema.optional(Schema.String),
      }),
    }),
  }),
});

export type Packument = typeof PackumentSchema.Type;

export class NPMService extends Effect.Service<NPMService>()("@ucdjs/release-scripts/NPMService", {
  effect: Effect.gen(function* () {
    const executor = yield* CommandExecutor.CommandExecutor;
    const config = yield* ReleaseScriptsOptions;
    const fetchPackument = (packageName: string) =>
      Effect.tryPromise({
        try: async () => {
          const response = await fetch(`https://registry.npmjs.org/${packageName}`);

          if (response.status === 404) {
            return null;
          }

          if (!response.ok) {
            throw new Error(`Failed to fetch packument: ${response.statusText}`);
          }

          const data = await response.json();
          return data;
        },
        catch: (error) => {
          return new NPMError({
            message: error instanceof Error ? error.message : String(error),
            operation: "fetchPackument",
          });
        },
      }).pipe(
        Effect.flatMap((data) => {
          if (data === null) {
            return Effect.succeed(null);
          }
          return Schema.decodeUnknown(PackumentSchema)(data).pipe(
            Effect.mapError((error) =>
              new NPMError({
                message: `Failed to parse packument: ${error}`,
                operation: "fetchPackument",
              }),
            ),
          );
        }),
      );

    const versionExists = (packageName: string, version: string) =>
      fetchPackument(packageName).pipe(
        Effect.map((packument) => {
          if (!packument) {
            return false;
          }
          return version in packument.versions;
        }),
      );

    const getLatestVersion = (packageName: string) =>
      fetchPackument(packageName).pipe(
        Effect.map((packument) => {
          if (!packument) {
            return null;
          }
          return packument["dist-tags"].latest || null;
        }),
      );

    const publish = (options: PublishOptions) =>
      Effect.gen(function* () {
        const args = ["publish"];

        if (options.tagName) {
          args.push("--tag", options.tagName);
        }

        if (options.otp) {
          args.push("--otp", options.otp);
        }

        if (options.provenance !== false) {
          args.push("--provenance");
        }

        if (options.dryRun ?? config.dryRun) {
          args.push("--dry-run");
        }

        const command = Command.make("pnpm", ...args).pipe(
          Command.workingDirectory(options.packagePath),
        );

        const result = yield* executor.string(command).pipe(
          Effect.mapError((err) => new PublishError({
            message: `Failed to publish package at ${options.packagePath}: ${err.message}`,
            cause: err,
          })),
        );

        return result.trim();
      });

    return {
      fetchPackument,
      versionExists,
      getLatestVersion,
      publish,
    } as const;
  }),
  dependencies: [],
}) {}
