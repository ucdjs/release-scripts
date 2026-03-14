# @ucdjs/release-scripts

[![npm version][npm-version-src]][npm-version-href]
[![npm downloads][npm-downloads-src]][npm-downloads-href]

Monorepo release automation for pnpm workspaces. Handles version calculation, dependency graph resolution, changelog generation, and GitHub integration.

## Installation

```bash
npm install @ucdjs/release-scripts
```

## Usage

```typescript
import { createReleaseScripts } from "@ucdjs/release-scripts";

const release = await createReleaseScripts({
  repo: "owner/repo",
  githubToken: process.env.GITHUB_TOKEN,
});

// Prepare a release (calculate versions, update package.json files, create PR)
const result = await release.prepare();

// Verify a release branch matches expected state
await release.verify();

// Publish packages to npm
await release.publish();
```

### Configuration

```typescript
const release = await createReleaseScripts({
  repo: "owner/repo",
  githubToken: "...",
  workspaceRoot: process.cwd(),
  dryRun: false,
  safeguards: true,
  globalCommitMode: "dependencies",
  packages: {
    include: ["@scope/pkg-a", "@scope/pkg-b"],
    exclude: ["@scope/internal"],
    excludePrivate: true,
  },
  branch: {
    release: "release/next",
    default: "main",
  },
  npm: {
    provenance: true,
    access: "public",
  },
  changelog: {
    enabled: true,
    emojis: true,
  },
});
```

### Package Discovery

```typescript
// List all workspace packages
const packages = await release.packages.list();

// Get a specific package
const pkg = await release.packages.get("@scope/pkg-a");
```

### Workflows

#### `prepare()`

Calculates version bumps from conventional commits, updates `package.json` files, generates changelogs, and creates/updates a release pull request.

#### `verify()`

Validates that a release branch matches expected release artifacts. Compares expected vs actual versions and dependency ranges, then sets a GitHub commit status.

#### `publish()`

Publishes packages to npm in topological order with provenance support, creates git tags, and pushes them to the remote.

## CLI Flags

When used in a script, the following flags are supported:

- `--dry` / `-d` - Dry-run mode, no changes are made
- `--verbose` / `-v` - Enable verbose logging

## 📄 License

Published under [MIT License](./LICENSE).

[npm-version-src]: https://img.shields.io/npm/v/@ucdjs/release-scripts?style=flat&colorA=18181B&colorB=4169E1
[npm-version-href]: https://npmjs.com/package/@ucdjs/release-scripts
[npm-downloads-src]: https://img.shields.io/npm/dm/@ucdjs/release-scripts?style=flat&colorA=18181B&colorB=4169E1
[npm-downloads-href]: https://npmjs.com/package/@ucdjs/release-scripts
