// First real ES module of the frontend (Phase 2 of the modernization — the
// strangler migration out of global-scoped classic scripts). Pure, dependency-
// free DOM/string helpers, so it's the safest possible thing to extract first.
//
// These are re-exposed on `window` (see web/entry.js) so the ~50 legacy global
// scripts that still call `escHtml(...)` / `jsStr(...)` keep working unchanged.
// As more code becomes modules, they'll `import` these instead, and the window
// bridge shrinks.

// HTML-escapes a value for a text node or a DOUBLE-quoted attribute. Does NOT
// touch the single-quote — see jsStr() for the inline-JS-string case, where
// HTML-entity escaping is the wrong tool (the browser HTML-decodes the handler
// attribute back to a raw ' before compiling it, so &#39; would still break out).
export function escHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Escapes a value for embedding inside a SINGLE-quoted JS string that lives in
// an inline on*="" handler — e.g. onclick="fn('${jsStr(name)}')". Backslash-
// escapes the JS-string metacharacters (\ and ') and neutralizes </script> /
// attribute-delimiter breakouts by HTML-escaping < and ", so the one helper is
// safe regardless of the surrounding attribute's quoting.
export function jsStr(str) {
  return String(str)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/</g, '&lt;')
    .replace(/"/g, '&quot;');
}

// Renders a user's avatar as an HTML string: an <img> for a photo URL, else the
// emoji fallback. escHtml on the url too — the backend restricts avatar_url to
// data:image / https shapes, but escaping here means a stray quote can never
// break out of the src="" attribute even if something slips past validation
// (defense in depth against stored XSS — this renders other users' avatars).
export function avatarHtml(emoji, url) {
  if (url) return `<img src="${escHtml(url)}" alt="">`;
  return escHtml(emoji || '🎮');
}
