import type { PackageChangelog } from "../utils/changelog-formatters";
import type { GitCommit, WorkspacePackageWithCommits } from "../utils/helpers";
import { Effect } from "effect";
import { ReleaseScriptsOptions } from "../options";
import { appendChangelogEntry, createChangelog, formatChangelogEntryMarkdown } from "../utils/changelog-formatters";

export interface ChangelogResult {
  changelog: PackageChangelog;
  markdown: string;
  filePath: string;
}

export class ChangelogService extends Effect.Service<ChangelogService>()("@ucdjs/release-scripts/ChangelogService", {
  effect: Effect.gen(function* () {
    const config = yield* ReleaseScriptsOptions;

    function generateChangelog(
      pkg: WorkspacePackageWithCommits,
      newVersion: string,
      commits: readonly GitCommit[],
    ): Effect.Effect<ChangelogResult> {
      return Effect.gen(function* () {
        const changelog = createChangelog(
          pkg.name,
          newVersion,
          pkg.version,
          commits,
          `${config.owner}/${config.repo}`,
        );

        const entryMarkdown = formatChangelogEntryMarkdown(changelog);
        const existing = yield* Effect.tryPromise({
          try: async () => {
            const fs = await import("node:fs/promises");
            return await fs.readFile(`${pkg.path}/CHANGELOG.md`, "utf-8");
          },
          catch: (err) => err as Error,
        }).pipe(
          Effect.catchAll(() => Effect.succeed("")),
        );

        const markdown = appendChangelogEntry(existing, entryMarkdown, pkg.name);

        return {
          changelog,
          markdown,
          filePath: `${pkg.path}/CHANGELOG.md`,
        };
      });
    }

    return {
      generateChangelog,
    } as const;
  }),
  dependencies: [],
}) {}
