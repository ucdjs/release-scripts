import type { NormalizedReleaseScriptsOptions } from "./options";
import { publishWorkflow } from "#workflows/publish";

export async function publish(options: NormalizedReleaseScriptsOptions): Promise<void> {
  return publishWorkflow(options);
}
