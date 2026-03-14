# AGENTS.md - Release Scripts Architecture Guide

## Project Overview

**@ucdjs/release-scripts** is a monorepo release automation library for pnpm workspaces. It provides programmatic tools for automated version calculation, dependency graph resolution, changelog generation, and GitHub integration.

### Key Features

- **Automated Version Calculation**: Conventional commit analysis to determine version bumps (major, minor, patch)
- **Workspace Management**: Discovers and manages packages in pnpm workspaces
- **Dependency Graph Resolution**: Topological ordering for package releases based on workspace dependencies
- **GitHub Integration**: Creates/manages release PRs, sets commit statuses
- **Release Verification**: Validates release branches match expected artifacts
- **Dry-Run Support**: Test workflows without making changes

### Implemented Workflows

- `verify()` - Release branch verification
- `prepare()` - Release preparation with version updates, PR creation, changelog generation
- `publish()` - NPM publishing with provenance and tag creation

## Architecture

### Plain TypeScript with Result Pattern

The codebase uses plain TypeScript with a `Result<T, E>` pattern for error handling:

```typescript
type Result<T, E> = Ok<T> | Err<E>;
```

Functions that can fail return `Result` values instead of throwing. Callers check `result.ok` to determine success/failure.

### ReleaseError and Error Boundary

`exitWithError()` throws a `ReleaseError` instead of calling `process.exit(1)`. This makes error paths testable.

At the entry point (`src/index.ts`), a `withErrorBoundary` wrapper catches `ReleaseError`, prints formatted output via `printReleaseError`, and calls `process.exit(1)`.

```typescript
// In workflow code:
exitWithError("message", "hint", cause); // throws ReleaseError

// At entry boundary (src/index.ts):
withErrorBoundary(() => verify(options)); // catches ReleaseError → print → exit
```

### CLI Flags

CLI flags (`--dry`, `--verbose`, `--force`) are parsed lazily via `node:util parseArgs` through getter functions (`getIsDryRun()`, `getIsVerbose()`, `getIsForce()`, `getIsCI()`). This avoids module-level side effects and makes the code testable.

## Module Structure

```
src/
├── index.ts                    # Entry point, API surface, error boundary
├── options.ts                  # Configuration normalization
├── types.ts                    # Result<T,E>, ReleaseResult
├── core/
│   ├── git.ts                  # Git operations (branch, commit, tag, push)
│   ├── github.ts               # GitHub API client
│   ├── workspace.ts            # Package discovery via pnpm
│   ├── changelog.ts            # Changelog generation
│   └── prompts.ts              # Interactive prompts
├── operations/
│   ├── semver.ts               # Semver utilities (getNextVersion, calculateBumpType)
│   ├── version.ts              # Bump determination from commits
│   ├── branch.ts               # Release branch operations
│   ├── calculate.ts            # Update calculation orchestration
│   └── pr.ts                   # Pull request sync
├── shared/
│   ├── errors.ts               # ReleaseError, exitWithError, formatUnknownError, printReleaseError
│   ├── utils.ts                # CLI flags, logger, run/dryRun/runIfNotDry
│   └── types.ts                # PackageRelease, BumpKind, etc.
├── versioning/
│   ├── version.ts              # Version calculation, dependency range computation
│   ├── commits.ts              # Commit grouping, global commit filtering
│   └── package.ts              # Dependency graph, dependent updates
└── workflows/
    ├── prepare.ts              # Prepare workflow
    ├── publish.ts              # Publish workflow
    └── verify.ts               # Verify workflow
```

### Key Exported Pure Functions (testable)

- `resolveAutoVersion()` - Determines version bump from commits + overrides (no IO)
- `computeDependencyRange()` - Computes new dependency range string (no IO)
- `getDependencyUpdates()` - Finds which deps need updating (no IO)
- `filterGlobalCommits()` - Filters commits by global/dependency criteria (no IO)
- `fileMatchesPackageFolder()`, `isGlobalCommit()`, `findCommitRange()` - Commit classification helpers

## Error Types

- `GitError` - Git command failures (`src/core/git.ts`)
- `WorkspaceError` - Workspace discovery/validation (`src/core/workspace.ts`)
- `ReleaseError` - Workflow-level errors, thrown by `exitWithError` (`src/shared/errors.ts`)

## Technology Stack

- **Runtime**: Node.js with ESM
- **Build**: tsdown (Rolldown-based bundler)
- **Test**: Vitest
- **Git/Commits**: commit-parser for conventional commit parsing
- **Package Management**: pnpm workspace integration
- **Semver**: semver package
- **CLI**: node:util parseArgs (built-in)
- **Process execution**: tinyexec
- **Colors**: farver
- **Prompts**: prompts
- **Templates**: eta (changelog/PR body)

## Scripts

```bash
pnpm build      # Build production bundle
pnpm dev        # Watch mode
pnpm test       # Run Vitest tests
pnpm lint       # ESLint
pnpm typecheck  # TypeScript type checking
```

## Testing

Tests use Vitest. Test helpers in `test/_shared.ts` provide factory functions:
- `createCommit()` - Git commit fixture
- `createWorkspacePackage()` - Package fixture
- `createNormalizedReleaseOptions()` - Options fixture
- `createGitHubClientStub()` - GitHub client stub

Coverage areas: error formatting, CI detection, version resolution, dependency range computation, global commit filtering, commit classification helpers, changelog generation, semver operations.
