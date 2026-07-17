import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Chalk iOS (Capacitor) — thin native shell around the existing web client.
 *
 * There are two operating modes, toggled by the CHALK_MOBILE_SERVER env var
 * read at `npx cap sync` time:
 *
 *  • DEV (default) — `server.url` points the WKWebView straight at a running
 *    Chalk backend. In the iOS Simulator, `localhost` resolves to the host
 *    Mac, so `http://localhost:3000` "just works": window.location.origin is
 *    the backend, REST + Socket.io + Agora are all same-origin, no CORS and
 *    no code changes. `cleartext` is only needed because it's plain http.
 *
 *  • PROD (App Store) — leave CHALK_MOBILE_SERVER unset AND remove the
 *    `server` block (see the phase-2 notes in mobile/README). The app then
 *    loads the assets bundled from `webDir` locally (capacitor://localhost)
 *    and talks to the production API over https. That local-bundle behaviour
 *    is what keeps the app on the right side of App Store Guideline 4.2.
 */
const devServer = process.env.CHALK_MOBILE_SERVER || 'http://localhost:3000';

const config: CapacitorConfig = {
  appId: 'gg.chalk.app',
  appName: 'Chalk',
  webDir: 'public',
  ios: {
    // Chalk's UI already paints its own dark background; let the web content
    // extend under the status bar rather than showing a white inset.
    contentInset: 'never',
  },
  server: {
    // DEV ONLY — delete this whole `server` block for the App Store build.
    url: devServer,
    cleartext: devServer.startsWith('http://'),
  },
};

export default config;
