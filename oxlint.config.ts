import { defineConfig } from "oxlint";

export default defineConfig({
  options: {
    typeAware: true,
    typeCheck: true,
  },
  plugins: ["unicorn", "typescript", "oxc"],
  categories: {
    correctness: "error",
    perf: "error",
    suspicious: "error",
  },
  rules: {
    "eslint/no-await-in-loop": "off",
    "no-console": ["error", { allow: ["error", "warn"] }],
    "no-shadow": "off",
    "typescript/no-unnecessary-boolean-literal-compare": "off",
    "typescript/no-unsafe-type-assertion": "off",
    curly: "off",
    "typescript/no-base-to-string": "off",
    "typescript/no-misused-spread": "off",
  },
  overrides: [
    {
      files: [".github/**/*", "scripts/**/*"],
      rules: {
        "no-console": "off",
      },
    },
    {
      files: ["test/**/*"],
      rules: {
        "typescript/unbound-method": "off",
        "typescript/no-unsafe-member-access": "off",
      },
    },
  ],
});
