import { NodeCommandExecutor, NodeFileSystem } from "@effect/platform-node";
import { Effect } from "effect";
import { ConfigOptions } from "./src/services/config.service.ts";
import { GitService } from "./src/services/git.service.ts";

const program = Effect.gen(function* () {
  const git = yield* GitService;

  yield* git.commit.stage(["."]);
  yield* git.commit.write("refactor: change git & github services");
  yield* git.commit.push("release-scripts-testing");

  console.log("Committed and pushed changes to release-scripts-testing branch.");
  const a = yield* git.branches.checkout("release-scripts-testing").pipe(Effect.catchAll((err) => {
    console.error(`Error checking out release-scripts-testing branch: ${err.message}`);
    return Effect.fail(err);
  }));

  console.log(a);

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
