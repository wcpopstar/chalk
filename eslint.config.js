'use strict';

const js = require('@eslint/js');
const globals = require('globals');
const nodePlugin = require('eslint-plugin-n');
const promisePlugin = require('eslint-plugin-promise');
const prettierConfig = require('eslint-config-prettier');

// -----------------------------------------------------------------------
// Airbnb-inspired "best practice" ruleset, hand-picked so it works without
// pulling in eslint-config-airbnb-base (which still targets ESLint 8's
// eslintrc format and drags in a peer-dependency chain that isn't fully
// flat-config-ready on ESLint 9). This gives the same spirit — strict,
// opinionated, catches real bugs — while staying compatible with our
// ESLint 9 flat config setup.
//
// A few rules below (no-shadow, consistent-return, no-use-before-define,
// prefer-promise-reject-errors, ...) are exactly the kind of thing
// @typescript-eslint enforces by default; keeping them on gives us most of
// that "TypeScript strictness" even though this is a plain JS codebase.
// -----------------------------------------------------------------------
const airbnbStyleRules = {
  // Possible problems
  eqeqeq: ['error', 'always', { null: 'ignore' }],
  'no-var': 'error',
  'prefer-const': ['error', { destructuring: 'all' }],
  'no-shadow': 'error',
  'no-use-before-define': ['error', { functions: false, classes: true, variables: true }],
  'no-param-reassign': ['error', { props: true, ignorePropertyModificationsFor: ['req', 'res', 'acc', 'state'] }],
  'no-nested-ternary': 'error',
  'no-multi-assign': 'error',
  'no-return-await': 'error',
  'no-throw-literal': 'error',
  'prefer-promise-reject-errors': 'error',
  'no-async-promise-executor': 'error',
  'require-await': 'warn',
  'no-implicit-coercion': 'error',
  'no-plusplus': ['error', { allowForLoopAfterthoughts: true }],
  radix: 'error',
  'default-case': 'error',
  'default-case-last': 'error',
  'no-else-return': ['error', { allowElseIf: false }],
  'no-lonely-if': 'error',
  'consistent-return': 'error',

  // Stylistic / best practices (non-formatting; formatting is Prettier's job)
  'object-shorthand': ['error', 'always'],
  'prefer-template': 'error',
  'prefer-arrow-callback': 'error',
  'arrow-body-style': ['error', 'as-needed'],
  'no-useless-concat': 'error',
  'no-useless-return': 'error',
  'no-useless-rename': 'error',
  'one-var': ['error', 'never'],
  'prefer-destructuring': ['warn', { array: false, object: true }],
  yoda: 'error',

  // Complexity / maintainability guardrails
  complexity: ['warn', 20],
  'max-depth': ['warn', 4],
  'max-params': ['warn', 5],
};

module.exports = [
  {
    ignores: ['node_modules/**', 'supabase/migrations/**', 'public/css/**', 'public/vendor/**', 'coverage/**', 'dist/**'],
  },

  // Baseline recommended rules everywhere.
  js.configs.recommended,

  // Backend: plain Node.js, CommonJS (require/module.exports).
  {
    files: ['src/**/*.js', 'test/**/*.js', 'supabase/migrate.js', 'eslint.config.js'],
    plugins: {
      n: nodePlugin,
      promise: promisePlugin,
    },
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      ...airbnbStyleRules,

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

      // Node-specific correctness checks (typo'd requires, missing deps,
      // deprecated Node APIs, process.exit() misuse, etc.)
      'n/no-missing-require': 'error',
      'n/no-extraneous-require': 'error',
      'n/no-unpublished-require': 'off',
      'n/no-process-exit': 'warn',
      'n/no-deprecated-api': 'error',
      'n/handle-callback-err': 'warn',

      // Promise/async correctness — this codebase is async-heavy
      // (Express handlers, Socket.IO events, Supabase/Redis calls).
      'promise/param-names': 'error',
      'promise/no-return-wrap': 'error',
      'promise/always-return': 'off',
      'promise/catch-or-return': ['error', { allowFinally: true }],
      'promise/no-nesting': 'warn',
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
      ...airbnbStyleRules,
      'no-undef': 'off',
      'no-unused-vars': 'off',
      // Same deliberate-ignore idiom as the backend (see e.g.
      // public/js/auth.js's logout(), public/js/i18n.js's language
      // detection) — best-effort operations where failure is expected.
      'no-empty': ['error', { allowEmptyCatch: true }],

      // These files are classic pre-ES6-style <script> tags loaded
      // directly by public/index.html (no bundler/transpiler, no
      // module boundaries) — the airbnb-style "TypeScript strictness"
      // rules above don't fit that code and mostly flag style, not bugs:
      //  - var is used throughout for cross-<script> globals; switching
      //    piecemeal to let/const across ~20 interdependent files risks
      //    subtle scoping regressions for no real benefit here.
      //  - DOM helpers here commonly mutate the element/object they're
      //    passed (e.g. building up an `item`/`opts` object, tweaking a
      //    `btn`/`el` node) — that's the normal idiom for this style of
      //    UI code, not an accidental side effect.
      //  - Several handlers legitimately return early for validation
      //    failures and fall through to `undefined` on success — that's
      //    intentional control flow, not a missed return.
      //  - `no-use-before-define` false-positives here: these are global
      //    script-scope vars that exist by the time the callback actually
      //    runs, even though they're declared later in the file.
      'no-var': 'off',
      'no-param-reassign': 'off',
      'consistent-return': 'off',
      'no-plusplus': 'off',
      'no-nested-ternary': 'off',
      'no-use-before-define': 'off',
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
      ...airbnbStyleRules,
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },

  // Must be last: turns off any core ESLint stylistic rules that would
  // conflict with Prettier (indentation, quotes, spacing, etc.). Prettier
  // owns formatting; ESLint owns correctness/best-practices.
  prettierConfig,
];
