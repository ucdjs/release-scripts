import type { PackageChangelog } from "../utils/changelog-formatters";
import type { GitCommit, WorkspacePackageWithCommits } from "../utils/helpers";
import { Effect } from "effect";
import { createChangelog, formatChangelogMarkdown } from "../utils/changelog-formatters";

export interface ChangelogResult {
  changelog: PackageChangelog;
  markdown: string;
  filePath: string;
}

export class ChangelogService extends Effect.Service<ChangelogService>()("@ucdjs/release-scripts/ChangelogService", {
  effect: Effect.gen(function* () {
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
        );

        const markdown = formatChangelogMarkdown(changelog);

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
