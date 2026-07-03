'use strict';

const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  {
    ignores: ['node_modules/**', 'supabase/migrations/**', 'public/css/**'],
  },

  // Baseline recommended rules everywhere.
  js.configs.recommended,

  // Backend: plain Node.js, CommonJS (require/module.exports).
  {
    files: ['src/**/*.js', 'test/**/*.js', 'supabase/migrate.js', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      // Server deliberately logs to stdout/stderr (see src/index.js
      // unhandledRejection/uncaughtException handlers) — that's the point.
      'no-console': 'off',
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },

  // Frontend: classic <script> tags in public/index.html that all share
  // one global scope (e.g. auth.js defines functions that init.js and
  // inline onclick= handlers call). ESLint lints each file in isolation,
  // so it can't see those cross-file references — no-undef would just
  // produce constant false positives here, so it's turned off.
  {
    files: ['public/js/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'script',
      globals: {
        ...globals.browser,
      },
    },
    rules: {
      'no-undef': 'off',
      'no-unused-vars': 'off',
    },
  },

  // public/voice.js is the one frontend file loaded as a real ES module
  // (<script type="module" src="/voice.js">), so it gets normal
  // module-scoped linting.
  {
    files: ['public/voice.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        ...globals.browser,
      },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    },
  },
];
