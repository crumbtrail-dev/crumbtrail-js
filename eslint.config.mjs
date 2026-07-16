import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/build/**",
      "**/node_modules/**",
      "**/*.d.ts",
      "packages/tauri/rust/**",
      ".husky/**",
      "tmp/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Basic config spans both browser (react/core) and Node (node package, cli)
    // code, so combine both global sets rather than modeling per-package
    // environments.
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
        ...globals.es2022,
      },
    },
  },
  {
    files: ["**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}"],
    rules: {
      // Keep this config intentionally basic on introduction; tighten over time.
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "off",
      // Downgraded to warn: these rules flag a batch of pre-existing violations
      // across the codebase. Warn (non-blocking) for now instead of forcing an
      // unrelated cleanup pass; tighten to 'error' once the codebase is clean.
      "@typescript-eslint/no-unsafe-function-type": "warn",
      "@typescript-eslint/no-empty-object-type": "warn",
      "@typescript-eslint/ban-ts-comment": "warn",
      "no-useless-escape": "warn",
      "no-control-regex": "warn",
      "no-useless-assignment": "warn",
      "preserve-caught-error": "warn",
      "no-constant-condition": ["warn", { checkLoops: false }],
      "no-empty": "warn",
    },
  },
  {
    files: ["test-fixtures/installers/**/*.js"],
    rules: {
      // These installer fixtures intentionally exercise CommonJS projects.
      "@typescript-eslint/no-require-imports": "off",
    },
  },
);
