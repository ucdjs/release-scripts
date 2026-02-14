import type { NormalizedReleaseScriptsOptions } from "./options";
import type { ReleaseResult } from "#types/release";
import { prepareWorkflow } from "#workflows/prepare";

export async function release(
  options: NormalizedReleaseScriptsOptions,
): Promise<ReleaseResult | null> {
  return prepareWorkflow(options);
}
