# Simplified Architecture Diagrams

This directory contains diagrams showing the **target architecture** after removing Effect-TS.

## Key Differences from Original

| Aspect | Before (Effect) | After (Functional) |
|--------|-----------------|-------------------|
| Services | `Effect.Service` classes | Plain async functions |
| Dependencies | Effect Layer injection | Explicit function parameters |
| Error handling | `Effect.catchAll` | Standard try/catch |
| Async flow | `Effect.gen` + `yield*` | Standard async/await |
| Validation | `Effect.Schema` | TypeScript + Zod optional |
| Testing | Effect test utilities | Standard vitest mocks |

## Diagrams

1. **01-simplified-architecture.mmd** - Overall functional architecture
2. **02-verify-flow.mmd** - verify() workflow (simplified)
3. **03-prepare-flow.mmd** - prepare() workflow (simplified)
4. **04-publish-flow.mmd** - publish() workflow (simplified)
5. **05-data-models.mmd** - Simplified data models (no Effect types)
6. **06-comparison.mmd** - Side-by-side comparison
7. **07-benefits.mmd** - Code reduction and benefits

## Core Principles

1. **Pure Functions**: Business logic is pure, testable
2. **Explicit Dependencies**: No hidden state or magic injection
3. **Standard Patterns**: async/await, try/catch, plain functions
4. **Minimal Boilerplate**: ~50% less code
5. **Easy Testing**: Mock any function by passing different implementation

## Example Transformation

```typescript
// BEFORE: Effect approach
export class GitService extends Effect.Service<GitService>()("GitService", {
  effect: Effect.gen(function* () {
    const executor = yield* CommandExecutor.CommandExecutor;
    const config = yield* ReleaseScriptsOptions;
    
    const listBranches = Effect.gen(function* () {
      const output = yield* execGitCommand(["branch", "--list"]);
      return output.split("\n").map(b => b.trim());
    });
    
    return { branches: { list: listBranches } };
  }),
  dependencies: [NodeCommandExecutor.layer],
}) {}

// AFTER: Functional approach
export async function listBranches(options: { cwd: string }): Promise<string[]> {
  const output = await execGit(["branch", "--list"], options);
  return output.split("\n").map(b => b.trim());
}

// Usage
const branches = await listBranches({ cwd: "/project" });
```

## Testing Example

```typescript
// BEFORE: Complex Effect testing
it.effect("lists branches", () =>
  Effect.gen(function* () {
    const git = yield* GitService;
    const branches = yield* git.branches.list();
    expect(branches).toContain("main");
  }).pipe(Effect.provide(TestLayer))
);

// AFTER: Simple mocking
it("lists branches", async () => {
  const execGit = vi.fn().mockResolvedValue("* main\n  release\n");
  const branches = await listBranches({ cwd: "." }, { execGit });
  expect(branches).toContain("main");
});
```
