// eslint.config.js — ESLint v9 "flat config" format
//
// ESLint v9 replaced .eslintrc.json with this file.
// Config is now an exported array of config objects that apply in order.
// Each object can target specific files, apply a parser, and enable rules.

import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';
import prettier from 'eslint-config-prettier';

export default [
  // ── 1. Files to ignore completely ───────────────────────────
  {
    ignores: ['dist/**', 'node_modules/**'],
  },

  // ── 2. TypeScript source files ──────────────────────────────
  {
    files: ['src/**/*.ts'],

    // The parser converts TypeScript syntax into an AST that ESLint can read.
    // Without this, ESLint would choke on type annotations.
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        project: './tsconfig.json', // enables type-aware rules
        tsconfigRootDir: import.meta.dirname,
      },
    },

    plugins: {
      '@typescript-eslint': tseslint,
    },

    rules: {
      // ── Inherit recommended rules from @typescript-eslint ────
      ...tseslint.configs['recommended'].rules,

      // ── Customisations ───────────────────────────────────────

      // Allow unused vars that start with _ (common pattern for ignored params)
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],

      // Warn on console.log — use a logger in production, but don't block during dev
      'no-console': 'warn',

      // Require explicit return types on functions — forces you to think about
      // what each function returns, catches mistakes early
      '@typescript-eslint/explicit-function-return-type': ['warn', {
        allowExpressions: true,        // allow arrow functions in callbacks
        allowTypedFunctionExpressions: true,
      }],

      // Disallow floating promises — unhandled async errors are hard to debug
      '@typescript-eslint/no-floating-promises': 'error',

      // Enforce awaiting promises before using their results
      '@typescript-eslint/await-thenable': 'error',
    },
  },

  // ── 3. Prettier last — disables all ESLint formatting rules ──
  // eslint-config-prettier turns off any ESLint rules that would conflict
  // with Prettier's formatting decisions. Prettier owns formatting; ESLint
  // owns code quality. They don't overlap.
  prettier,
];
