import type { NormalizedOptions } from "../utils/options.js";
import { Context, Effect, Layer } from "effect";

export class ConfigService extends Context.Tag("@ucdjs/release-scripts/ConfigService")<
  ConfigService,
  NormalizedOptions
>() {
  static layer(config: NormalizedOptions) {
    return Layer.effect(ConfigService, Effect.succeed(
      config,
    ));
  }
}
