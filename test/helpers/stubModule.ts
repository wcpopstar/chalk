export {};
'use strict';

/**
 * Replaces a module's cached exports with a fake object, so any code that
 * later does `require(thatModule)` gets the fake instead of running the
 * real module. This is what lets us test src/routes/auth.js — which does
 * `require('../services/supabase')` internally — without a real Supabase
 * project, and without a mocking framework as a dependency.
 *
 * Must be called BEFORE anything requires the target module for the first
 * time in this process (i.e. at the top of a test file, before requiring
 * the route/service under test).
 *
 * @param {string} resolvedPath - absolute path from require.resolve(...)
 * @param {object} fakeExports - object to use as the module's exports
 * @returns {() => void} restore function that undoes the stub
 */
function stubModule(resolvedPath: any, fakeExports: any) {
  const previous = require.cache[resolvedPath];

  require.cache[resolvedPath] = {
    id: resolvedPath,
    filename: resolvedPath,
    loaded: true,
    exports: fakeExports,
  } as any;

  return function restore() {
    if (previous) {
      require.cache[resolvedPath] = previous;
    } else {
      delete require.cache[resolvedPath];
    }
  };
}

module.exports = { stubModule };
