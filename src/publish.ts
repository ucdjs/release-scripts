import type { NormalizedReleaseScriptsOptions } from "./options";
import { logger } from "#shared/utils";

export async function publish(options: NormalizedReleaseScriptsOptions): Promise<void> {
  logger.warn("Publish workflow is not implemented yet.");
  logger.verbose("Publish options:", options);
}
