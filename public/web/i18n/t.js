// i18n adapter (transitional seam). The i18n layer itself (T, currentLang,
// applyI18n, the 69KB I18N_DATA) still lives in the legacy global script
// public/js/i18n.js — it can't move into a deferred ES module yet because
// init.js calls applyI18n()/checkAuth() synchronously at load, before deferred
// modules run (that's a separate bootstrap change).
//
// This module lets NEW module code import a clean `T()` / `getCurrentLang()`
// instead of reaching for the global directly, so those callers don't need to
// change again once i18n becomes a real module — only THIS file's internals
// will (it'll re-export from the i18n module rather than read `window`).

// Translate a key. Mirrors the legacy T(key, fallback) contract.
export function T(key, fallback) {
  if (typeof window !== 'undefined' && typeof window.T === 'function') return window.T(key, fallback);
  return fallback !== undefined ? fallback : key;
}

// Current UI language code (e.g. 'ru', 'en'); defaults to 'ru' before i18n boots.
export function getCurrentLang() {
  return (typeof window !== 'undefined' && window.currentLang) ? window.currentLang : 'ru';
}
