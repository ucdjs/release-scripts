import { defineConfig } from "oxfmt";

export default defineConfig({
  printWidth: 120,
  tabWidth: 2,
  useTabs: false,
  semi: true,
  singleQuote: false,
  trailingComma: "all",
  ignorePatterns: ["dist", "node_modules", "pnpm-lock.yaml"],
});
