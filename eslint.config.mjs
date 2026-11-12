import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  // Never lint build output or deps
  {
    ignores: ['lib/**', 'node_modules/**', 'dist/**'],
  },

  // Base rules for all TS/TSX
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // The @getflywheel/local APIs are largely typed `any` — flagging every
      // use would drown out real findings.
      '@typescript-eslint/no-explicit-any': 'off',
      // Allow intentionally-unused args/vars when prefixed with `_`.
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      // Swallowing an error in a catch is a deliberate pattern here (best-effort
      // cleanup, optional probes) — only flag empty blocks elsewhere.
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },

  // Node config files (webpack, eslint, etc.)
  {
    files: ['*.js', '*.cjs', '*.mjs'],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },

  // Main process (Node)
  {
    files: ['src/main/**/*.ts'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },

  // Renderer (React, browser)
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    ...react.configs.flat.recommended,
    plugins: {
      react,
      'react-hooks': reactHooks,
    },
    languageOptions: {
      globals: { ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    settings: {
      react: { version: 'detect' },
    },
    rules: {
      ...react.configs.flat.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      // We use the automatic JSX runtime / Local's React — no need to import React in scope.
      'react/react-in-jsx-scope': 'off',
      'react/prop-types': 'off',
      // Apostrophes/quotes in copy are fine — they render correctly in Local's UI.
      'react/no-unescaped-entities': 'off',
    },
  },

  // Test files (vitest globals)
  {
    files: ['**/*.test.ts'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },

  // Turn off ESLint rules that would conflict with Prettier — MUST be last.
  prettier,
);
