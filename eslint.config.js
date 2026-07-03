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
      'no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        // `catch (_) { ... }` is used throughout for deliberately-ignored
        // errors (e.g. best-effort cleanup where failure isn't actionable).
        caughtErrorsIgnorePattern: '^_',
        // `const { password_hash, ...safeUser } = user;` — the destructured
        // property is unused on purpose, it exists only to exclude it from
        // the ...rest object. This is the standard idiom for that.
        ignoreRestSiblings: true,
      }],
      // `try { ... } catch (_) { /* ignore */ }` is a deliberate, common
      // idiom in this codebase for best-effort operations where failure is
      // expected and not actionable (see e.g. socket/presence.js,
      // socket/state.js, utils/links.js). Empty *non-catch* blocks are
      // still flagged.
      'no-empty': ['error', { allowEmptyCatch: true }],
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
      // Same deliberate-ignore idiom as the backend (see e.g.
      // public/js/auth.js's logout(), public/js/i18n.js's language
      // detection) — best-effort operations where failure is expected.
      'no-empty': ['error', { allowEmptyCatch: true }],
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
        // Loaded via <script src="https://download.agora.io/sdk/release/...">
        // in public/index.html, before voice.js runs.
        AgoraRTC: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
];
