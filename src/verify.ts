import type { NormalizedReleaseScriptsOptions } from "./options";
import { verifyWorkflow } from "#workflows/verify";

export async function verify(options: NormalizedReleaseScriptsOptions): Promise<void> {
  return verifyWorkflow(options);
}
