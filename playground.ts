import { NodeCommandExecutor, NodeFileSystem } from "@effect/platform-node";
import { Effect } from "effect";
import { ConfigOptions } from "./src/services/config.service.ts";
import { GitService } from "./src/services/git.service.ts";

const program = Effect.gen(function* () {
  const git = yield* GitService;

  yield* git.commit.stage(["."]);
  yield* git.commit.write("refactor: change git & github services");
  yield* git.commit.push("effect-rewrite");

  yield* git.branches.checkout("main");

  return void 0;
});

const runnable = program.pipe(
  Effect.provide(GitService.Default),
  Effect.provide(NodeCommandExecutor.layer),
  Effect.provide(NodeFileSystem.layer),
  Effect.provide(ConfigOptions.layer({
    workspaceRoot: ".",
  })),
);

Effect.runPromise(runnable);
