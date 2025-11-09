import type {
  Options as TinyExecOptions,
  Result as TinyExecResult,
} from "tinyexec";
import process from "node:process";
import farver from "farver";
import { exec } from "tinyexec";

export const globalOptions = {
  /**
   * If true, commands will be logged instead of executed
   */
  dryRun: false,
};

export const isCI = typeof process.env.CI === "string" && process.env.CI !== "" && process.env.CI.toLowerCase() !== "false";

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

export async function dryRun(
  bin: string,
  args: string[],
  opts?: Partial<TinyExecOptions>,
): Promise<void> {
  return console.log(
    farver.blue(`[dryrun] ${bin} ${args.join(" ")}`),
    opts || "",
  );
}

export const runIfNotDry = globalOptions.dryRun ? dryRun : run;
