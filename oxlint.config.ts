import { defineConfig } from "oxlint";

export default defineConfig({
  categories: {
    correctness: "error",
    suspicious: "warn",
    pedantic: "off",
    nursery: "off",
  },
  rules: {
    "eslint/no-unused-vars": [
      "error",
      {
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
        caughtErrors: "none",
      },
    ],
    "eslint/no-shadow": "off",
    "typescript/no-explicit-any": "warn",
    "typescript/no-non-null-assertion": "off",
  },
  plugins: ["typescript", "vitest", "eslint"],
  overrides: [
    {
      files: ["test/**/*.ts"],
      rules: {
        "typescript/no-explicit-any": "off",
      },
    },
  ],
  ignorePatterns: ["dist", "node_modules", "*.d.ts", "*.d.mts"],
});
