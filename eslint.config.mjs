// Configuration ESLint 10 (flat config) du repo.
// Le plugin n'a aucune dépendance à l'exécution : ESLint ne sert qu'au développement et à la CI.
import js from "@eslint/js";
import globals from "globals";

const messageHtml =
  "Interdit dans viz/public/js : utiliser textContent ou createElement (risque XSS, voir ADR 0005).";

export default [
  {
    ignores: ["node_modules/**", "viz/public/vendor/**"],
  },
  js.configs.recommended,
  {
    files: ["**/*.cjs"],
    languageOptions: {
      sourceType: "commonjs",
      globals: globals.node,
    },
  },
  {
    files: ["tests/**/*.{js,mjs,cjs}"],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: ["viz/public/js/**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: globals.browser,
    },
    rules: {
      "no-restricted-properties": [
        "error",
        { property: "innerHTML", message: messageHtml },
        { property: "outerHTML", message: messageHtml },
      ],
    },
  },
];
