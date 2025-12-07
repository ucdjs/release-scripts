import type { WorkspacePackage } from "#services/workspace";
import type * as CommitParser from "commit-parser";
import { GitService } from "#services/git";
import { WorkspacePackageSchema } from "#services/workspace";
import { Effect, Schema } from "effect";
import { OverridesLoadError } from "../errors";

export interface VersionOverrides {
  [packageName: string]: string;
}

export interface LoadOverridesOptions {
  sha: string;
  overridesPath: string;
}

export function loadOverrides(options: LoadOverridesOptions) {
  return Effect.gen(function* () {
    const git = yield* GitService;

    return yield* git.workspace.readFile(options.overridesPath, options.sha).pipe(
      Effect.map((content) => ({
        content,
        readError: null as unknown,
      })),
      Effect.catchAll((err) =>
        Effect.succeed({
          content: "",
          readError: err,
        }),
      ),
      Effect.flatMap(({ content, readError }) => {
        if (!content) {
          return Effect.succeed({} as VersionOverrides);
        }

        return Effect.try({
          try: () => JSON.parse(content) as VersionOverrides,
          catch: (err) => {
            return new OverridesLoadError({
              message: "Failed to parse overrides file.",
              cause: readError || err,
            });
          },
        }).pipe(
          Effect.catchAll(() => Effect.succeed({} as VersionOverrides)),
        );
      }),
    );
  });
}

const GitCommitSchema = Schema.Struct({
  isConventional: Schema.Boolean,
  isBreaking: Schema.Boolean,
  type: Schema.String,
  scope: Schema.Union(Schema.String, Schema.Undefined),
  description: Schema.String,
  references: Schema.Array(Schema.Struct({
    type: Schema.Union(Schema.Literal("issue"), Schema.Literal("pull-request")),
    value: Schema.String,
  })),
  authors: Schema.Array(Schema.Struct({
    name: Schema.String,
    email: Schema.String,
    profile: Schema.optional(Schema.String),
  })),
  hash: Schema.String,
  shortHash: Schema.String,
  body: Schema.String,
  message: Schema.String,
  date: Schema.String,
});

export const WorkspacePackageWithCommitsSchema = Schema.Struct({
  ...WorkspacePackageSchema.fields,
  commits: Schema.Array(GitCommitSchema),
  globalCommits: Schema.Array(GitCommitSchema).pipe(
    Schema.propertySignature,
    Schema.withConstructorDefault(() => []),
  ),
});

export type WorkspacePackageWithCommits = Schema.Schema.Type<typeof WorkspacePackageWithCommitsSchema>;

export function mergePackageCommitsIntoPackages(
  packages: readonly WorkspacePackage[],
) {
  return Effect.gen(function* () {
    const git = yield* GitService;

    return yield* Effect.forEach(packages, (pkg) =>
      Effect.gen(function* () {
        const lastTag = yield* git.tags.mostRecentForPackage(pkg.name);

        const commits = yield* git.commits.get({
          from: lastTag || undefined,
          to: "HEAD",
          folder: pkg.path,
        });

        const withCommits = {
          ...pkg,
          commits,
          globalCommits: [],
        };

        return yield* Schema.decode(WorkspacePackageWithCommitsSchema)(withCommits).pipe(
          Effect.mapError((e) => new Error(`Failed to decode package with commits for ${pkg.name}: ${e}`)),
        );
      }));
  });
}

/**
 * Retrieves global commits that affect all packages in a monorepo.
 *
 * This function handles an important edge case in monorepo releases:
 * When pkg-a is released, then a global change is made, and then pkg-b is released,
 * we need to ensure that the global change is only attributed to pkg-a's release,
 * not re-counted for pkg-b.
 *
 * Algorithm:
 * 1. Find the overall commit range across all packages
 * 2. Fetch all commits and file changes once for this range
 * 3. For each package, filter commits based on its last tag cutoff
 * 4. Apply mode-specific filtering for global commits
 *
 * Example scenario:
 * - pkg-a: last released at commit A
 * - global change at commit B (after A)
 * - pkg-b: last released at commit C (after B)
 *
 * Result:
 * - For pkg-a: includes commits from A to HEAD (including B)
 * - For pkg-b: includes commits from C to HEAD (excluding B, since it was already in pkg-b's release range)
 *
 * @param packages - Array of workspace packages with their associated commits
 * @param mode - Determines which global commits to include:
 *   - "none": No global commits (returns empty map)
 *   - "all": All commits that touch files outside any package directory
 *   - "dependencies": Only commits that touch dependency-related files (package.json, lock files, etc.)
 *
 * @returns A map of package names to their relevant global commits
 */
export function mergeCommitsAffectingGloballyIntoPackage(
  packages: readonly WorkspacePackageWithCommits[],
  mode: "none" | "all" | "dependencies",
) {
  return Effect.gen(function* () {
    const git = yield* GitService;

    // Early return for "none" mode
    if (mode === "none") {
      return packages;
    }

    const [oldestCommitSha, newestCommitSha] = findCommitRange(packages);
    if (oldestCommitSha == null || newestCommitSha == null) {
      return packages;
    }

    const allCommits = yield* git.commits.get({
      from: oldestCommitSha,
      to: newestCommitSha,
      folder: ".",
    });

    const affectedFilesPerCommit = yield* git.commits.filesChangesBetweenRefs(
      oldestCommitSha,
      newestCommitSha,
    );

    // Used for quick lookup of commit timestamps/cutoffs
    const commitTimestamps = new Map(
      allCommits.map((c) => [c.shortHash, new Date(c.date).getTime()]),
    );

    const packagePaths = new Set(packages.map((p) => p.path));
    const result = new Map<string, CommitParser.GitCommit[]>();

    for (const pkg of packages) {
      // Get the package's last release tag timestamp
      const lastTag = yield* git.tags.mostRecentForPackage(pkg.name);
      const cutoffTimestamp = lastTag ? commitTimestamps.get(lastTag) ?? 0 : 0;

      const globalCommits: CommitParser.GitCommit[] = [];

      // Filter commits that occurred after this package's last release
      for (const commit of allCommits) {
        const commitTimestamp = commitTimestamps.get(commit.shortHash);
        if (commitTimestamp == null || commitTimestamp <= cutoffTimestamp) {
          continue; // Skip commits at or before the package's last release
        }

        const files = affectedFilesPerCommit.get(commit.shortHash);
        if (!files) continue;

        // Check if this commit is a global commit
        if (isGlobalCommit(files, packagePaths)) {
          // Apply mode-specific filtering
          if (mode === "dependencies") {
            if (files.some((file) => isDependencyFile(file))) {
              globalCommits.push(commit);
            }
          } else {
            // mode === "all"
            globalCommits.push(commit);
          }
        }
      }

      result.set(pkg.name, globalCommits);
    }

    return yield* Effect.succeed(packages.map((pkg) => ({
      ...pkg,
      globalCommits: result.get(pkg.name) || [],
    })));
  });
}

/**
 * Determines if a commit is "global" (affects files outside any package directory).
 *
 * @param files - List of files changed in the commit
 * @param packagePaths - Set of package directory paths
 * @returns true if at least one file is outside all package directories
 */
export function isGlobalCommit(files: readonly string[], packagePaths: Set<string>): boolean {
  return files.some((file) => {
    const normalized = file.startsWith("./") ? file.slice(2) : file;

    // Check if file is under any package path
    for (const pkgPath of packagePaths) {
      if (normalized === pkgPath || normalized.startsWith(`${pkgPath}/`)) {
        return false; // File is inside a package, not global
      }
    }

    return true; // File is outside all packages, therefore global
  });
}

/**
 * Files that are considered dependency-related in a monorepo.
 */
const DEPENDENCY_FILES = new Set([
  "package.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "package-lock.json",
  "pnpm-workspace.yaml",
]);

/**
 * Determines if a file is dependency-related.
 *
 * @param file - File path to check
 * @returns true if the file is a dependency file (package.json, lock files, etc.)
 */
export function isDependencyFile(file: string): boolean {
  const normalized = file.startsWith("./") ? file.slice(2) : file;

  // Check if it's a root-level dependency file
  if (DEPENDENCY_FILES.has(normalized)) return true;

  // Check if it ends with a dependency file name (e.g., "packages/foo/package.json")
  return Array.from(DEPENDENCY_FILES).some((dep) => normalized.endsWith(`/${dep}`));
}

/**
 * Finds the oldest and newest commits across all packages.
 *
 * This establishes the overall time range we need to analyze for global commits.
 *
 * @param packages - Array of packages with their commits
 * @returns Tuple of [oldestCommitSha, newestCommitSha], or [null, null] if no commits found
 */
export function findCommitRange(packages: readonly WorkspacePackageWithCommits[]): [oldestCommit: string | null, newestCommit: string | null] {
  let oldestCommit: WorkspacePackageWithCommits["commits"][number] | null = null;
  let newestCommit: WorkspacePackageWithCommits["commits"][number] | null = null;

  for (const pkg of packages) {
    if (pkg.commits.length === 0) {
      continue;
    }

    const firstCommit = pkg.commits[0];
    if (!firstCommit) {
      throw new Error(`No commits found for package ${pkg.name}`);
    }

    const lastCommit = pkg.commits[pkg.commits.length - 1];
    if (!lastCommit) {
      throw new Error(`No commits found for package ${pkg.name}`);
    }

    // Update newest commit if this package has a more recent commit
    if (newestCommit == null || new Date(lastCommit.date) > new Date(newestCommit.date)) {
      newestCommit = lastCommit;
    }

    // Update oldest commit if this package has an older commit
    if (oldestCommit == null || new Date(firstCommit.date) < new Date(oldestCommit.date)) {
      oldestCommit = firstCommit;
    }
  }

  if (oldestCommit == null || newestCommit == null) {
    return [null, null];
  }

  return [oldestCommit.shortHash, newestCommit.shortHash];
}
