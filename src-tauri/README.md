# Chalk Desktop (Tauri)

A thin native desktop shell around the existing Chalk web client. It does **not**
re-implement anything — the window simply loads the Chalk server and the same
`public/` web app runs inside a native window (macOS `.app` / `.dmg`,
Windows `.exe` / `.msi`, Linux `.deb` / `.AppImage`).

## How it works

The web client uses `API = window.location.origin` (see
`public/js/config-api.js`), so it always talks to whatever origin it was served
from. The native window loads the Chalk server **directly** via
`WebviewUrl::External` (see `src/lib.rs`), chosen by build profile:

- **Dev** (`npm run desktop:dev`) — Tauri starts the backend (`npm run dev`),
  waits for `http://localhost:3000`, and the window loads it. `window.location.origin`
  is the local server, so REST + Socket.io + Agora all work unchanged.
- **Release** (`npm run desktop:build`) — the window loads the production server
  baked into `src/lib.rs` (`PROD_URL`). No prompt, connects on launch.

Override the target without rebuilding by setting `CHALK_SERVER_URL`, e.g.
`CHALK_SERVER_URL=https://staging.example.com open Chalk.app`.

Nothing is bundled from `public/` into the app — doing so would change the
origin and break every API/socket call. The desktop app is a client that points
at a running Chalk server. To ship against a different server, edit `PROD_URL`
in `src/lib.rs` and rebuild.

## Prerequisites

- Node ≥ 22 (already required by the backend)
- **Rust toolchain** — Tauri compiles a native binary. Install once:
  ```bash
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
  source "$HOME/.cargo/env"
  ```
  On macOS you also need Xcode Command Line Tools (`xcode-select --install`) —
  already present on this machine.

## Commands

Run from the **repo root** (not `src-tauri/`):

```bash
npm run desktop:dev     # start backend + open the native window (hot reload)
npm run desktop:build   # produce installers in src-tauri/target/release/bundle/
```

## Files

| File | Purpose |
|------|---------|
| `tauri.conf.json` | Identifier, bundle targets, build hooks (window is built in Rust) |
| `src/lib.rs` | Native entry point — builds the window and loads the server URL |
| `src/main.rs` | Thin `main()` that calls `lib::run()` |
| `Cargo.toml`, `build.rs` | Rust crate + Tauri build hook |
| `capabilities/default.json` | Window permissions (core defaults only) |
| `frontend/index.html` | Bundled fallback page (not shown in normal operation) |
| `icons/` | App icons (generated via `npx tauri icon`) |

## Changing the app icon

```bash
npx tauri icon path/to/1024x1024.png
```
