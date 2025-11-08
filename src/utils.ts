import type {
  Options as TinyExecOptions,
  Result as TinyExecResult,
} from "tinyexec";
import { exec } from "tinyexec";

export async function run(
  bin: string,
  args: string[],
  opts: Partial<TinyExecOptions> = {},
): Promise<TinyExecResult> {
  return exec(bin, args, {
    throwOnError: true,
    ...opts,
    nodeOptions: {
      stdio: "inherit",
      ...opts.nodeOptions,
    },
  });
}
