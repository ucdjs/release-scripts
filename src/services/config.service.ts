import type { NormalizedOptions } from "../utils/options.js";
import { Context, Effect, Layer } from "effect";

export class ConfigOptions extends Context.Tag("@ucdjs/release-scripts/ConfigOptions")<
  ConfigOptions,
  NormalizedOptions
>() {
  static layer(config: NormalizedOptions) {
    return Layer.effect(ConfigOptions, Effect.succeed(
      config,
    ));
  }
}
