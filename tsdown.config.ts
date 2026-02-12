import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["./src/index.ts"],
  format: ["esm"],
  clean: true,
  dts: true,
  treeshake: true,
  exports: true,
  outputOptions: {
    codeSplitting: {
      groups: [
        {
          name: "eta",
          test: /[\\/]node_modules[\\/]eta[\\/]/,
        },
      ],
    },
  },
  inlineOnly: false,
});
