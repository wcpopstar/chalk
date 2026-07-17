# Chalk iOS (Capacitor)

A thin native iOS shell around the existing Chalk web client (`public/`), the
mobile counterpart to the Tauri desktop app in `src-tauri/`. It does **not**
re-implement the UI — the WKWebView runs the same web app.

## Prerequisites

- **Full Xcode** from the Mac App Store (~7 GB) — *not* just Command Line
  Tools. Then point the toolchain at it once:
  ```bash
  sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
  sudo xcodebuild -license accept
  ```
- **CocoaPods**: `sudo gem install cocoapods` (or `brew install cocoapods`).
- Node ≥ 22 (already required by the backend).
- To publish (later): an **Apple Developer Program** membership ($99/yr).

## Phase 1 — run in the iOS Simulator (no Apple account needed)

The WKWebView loads the backend directly (`server.url` in
`capacitor.config.ts`). In the Simulator, `localhost` is the host Mac, so the
default `http://localhost:3000` works with **zero code changes**.

```bash
npm run dev          # terminal 1: start the Chalk backend on :3000
npm run ios:add      # one time: scaffold the native ios/ project
npm run ios:sync     # copy web assets + config into the native project
npm run ios:open     # open in Xcode → pick a simulator → Run
```

Point at a different backend without editing files:

```bash
CHALK_MOBILE_SERVER=https://staging.example.com npm run ios:sync
```

## Phase 2 — App Store build (do this once an Apple account exists)

A pure remote-URL webview gets rejected under **App Store Guideline 4.2
(Minimum Functionality)**. Before submitting, this app must:

1. **Bundle assets locally.** Delete the entire `server` block from
   `capacitor.config.ts` so the app loads `webDir` (`public/`) from
   `capacitor://localhost` instead of a remote URL.
2. **Point the web client at the API explicitly.** With local assets,
   `window.location.origin` becomes `capacitor://localhost`, which breaks
   every `API`/`io(API)` call. Override `API` in `public/js/config-api.js` to
   the production https URL when running natively (detect via
   `window.Capacitor`).
3. **Allow the native origin on the backend.** Add `capacitor://localhost` to
   `CLIENT_URL` / CORS + Socket.io `origin`.
4. **Add native push (APNs)** via `@capacitor/push-notifications` — required
   for a messenger to feel real and to satisfy review.
5. **Declare permissions** (`NSMicrophoneUsageDescription`,
   `NSCameraUsageDescription`) in `ios/App/App/Info.plist` for Agora voice.
6. Set the signing team, real bundle id, app icons, and launch screen in
   Xcode; archive and upload to App Store Connect.
