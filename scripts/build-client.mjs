// ─────────────────────────────────────────────────────────────────────────────
// Frontend production build — Phase 1 of the incremental modernization.
//
// The frontend today is ~52 order-dependent, GLOBAL-scoped classic scripts
// loaded via individual <script> tags (58 total files). Until they're converted
// to ES modules (a later phase), we cannot let a real bundler wrap them in
// module scope — every top-level `function foo(){}` is reachable as `window.foo`
// from ~520 inline on* handlers, and module-scoping would break all of them.
//
// So this step does the one transformation that is 100% behavior-preserving:
// concatenate the app scripts IN THE EXACT ORDER index.html loads them (the
// same shared global scope as sequential <script> tags), then minify with
// esbuild WITHOUT identifier renaming (whitespace + syntax only). The result is
// a single hashed, minified bundle that replaces 52 network requests with one.
//
// What is intentionally left alone:
//   - /js/theme-init.js  — must run in <head> before first paint (no FOUC).
//   - /vendor/*          — already-minified third-party (nacl).
//   - CDN scripts        — socket.io, Agora (external, CSP-pinned).
//   - /voice.js          — already an ES module (type="module").
//
// Dev (`npm run dev`) is untouched: Express serves public/ with the original
// 52 tags, so iteration stays instant. Production serves public/build/index.html
// (see src/index.ts) when it exists.
// ─────────────────────────────────────────────────────────────────────────────
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import esbuild from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = path.join(root, 'public');
const buildDir = path.join(publicDir, 'build');
const indexPath = path.join(publicDir, 'index.html');

// These load early / are external / are already modules — never bundle them.
const EXCLUDE = new Set(['/js/theme-init.js']);

async function main() {
  const html = await readFile(indexPath, 'utf8');

  // Collect the local app scripts in the exact order index.html lists them.
  const scriptRe = /<script src="(\/js\/[^"]+\.js)"><\/script>/g;
  const ordered = [...html.matchAll(scriptRe)].map((m) => m[1]).filter((p) => !EXCLUDE.has(p));
  if (ordered.length === 0) throw new Error('No /js/*.js scripts found to bundle — did index.html change?');

  // Concatenate in order. A leading `;` between files guards against ASI edge
  // cases at file boundaries (a file ending without a semicolon followed by one
  // starting with `(`/`[`), which separate <script> tags never hit.
  const parts = [];
  for (const p of ordered) {
    const code = await readFile(path.join(publicDir, p.replace(/^\//, '')), 'utf8');
    parts.push(`\n;// ===== ${p} =====\n${code}`);
  }
  const concatenated = parts.join('\n');

  // Minify WITHOUT renaming identifiers: top-level names are global API used by
  // inline handlers, so they must survive verbatim. Whitespace + syntax only.
  const { code: legacyCode } = await esbuild.transform(concatenated, {
    loader: 'js',
    minifyWhitespace: true,
    minifySyntax: true,
    minifyIdentifiers: false,
    legalComments: 'none',
    target: 'es2019',
  });

  // Compile the ES-module entry (web/entry.js + its import graph) to a self-
  // contained IIFE and PREPEND it, so the modules it bridges onto `window`
  // (escHtml/jsStr, and more as the migration grows) exist synchronously before
  // any legacy code runs. Modules ARE minified (incl. identifiers) — they're
  // properly scoped, so renaming is safe; only the window bridge is global.
  const moduleBuild = await esbuild.build({
    entryPoints: [path.join(publicDir, 'web', 'entry.js')],
    bundle: true,
    format: 'iife',
    minify: true,
    target: 'es2019',
    legalComments: 'none',
    write: false,
  });
  const moduleCode = moduleBuild.outputFiles[0].text;

  const code = `${moduleCode}\n${legacyCode}`;
  const hash = createHash('sha256').update(code).digest('hex').slice(0, 10);
  const bundleName = `app.${hash}.js`;

  // CSS: /css/style.css is an @import aggregator over the thematic modules in
  // /css/ — bundle (inlines the imports in order), minify, and hash it. The
  // Google-Fonts @import is external and survives at the top of the output.
  const cssBuild = await esbuild.build({
    entryPoints: [path.join(publicDir, 'css', 'style.css')],
    bundle: true,
    minify: true,
    external: ['https://*'],
    legalComments: 'none',
    write: false,
  });
  const cssCode = cssBuild.outputFiles[0].text;
  const cssHash = createHash('sha256').update(cssCode).digest('hex').slice(0, 10);
  const cssName = `style.${cssHash}.css`;

  await rm(buildDir, { recursive: true, force: true });
  await mkdir(buildDir, { recursive: true });
  await writeFile(path.join(buildDir, bundleName), code, 'utf8');
  await writeFile(path.join(buildDir, cssName), cssCode, 'utf8');

  // Rewrite index.html: swap the whole run of bundled tags for the one bundle.
  const bundleTag = `<script src="/build/${bundleName}"></script>`;
  let outHtml = html.replace(`<script src="${ordered[0]}"></script>`, bundleTag);
  for (const p of ordered.slice(1)) {
    outHtml = outHtml
      .replace(`<script src="${p}"></script>\n`, '')
      .replace(`<script src="${p}"></script>`, '');
  }
  // The native ES-module entry is compiled INTO the bundle above, so drop its
  // dev-only <script type="module"> tag from the built HTML.
  outHtml = outHtml
    .replace(/<script type="module" src="\/web\/entry\.js"><\/script>\n?/, '');
  // Point the stylesheet at the hashed CSS bundle.
  outHtml = outHtml.replace(
    '<link rel="stylesheet" href="/css/style.css">',
    `<link rel="stylesheet" href="/build/${cssName}">`
  );
  await writeFile(path.join(buildDir, 'index.html'), outHtml, 'utf8');

  const kb = (Buffer.byteLength(code) / 1024).toFixed(0);
  const rawKb = (Buffer.byteLength(concatenated) / 1024).toFixed(0);
  console.log(`✅ client build: ${ordered.length} scripts → build/${bundleName} (${kb} KB, from ${rawKb} KB raw)`);
  console.log(`   built HTML: build/index.html (1 bundle tag instead of ${ordered.length})`);
}

main().catch((err) => {
  console.error('❌ client build failed:', err);
  process.exit(1);
});
