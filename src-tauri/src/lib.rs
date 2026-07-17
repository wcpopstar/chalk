// Chalk desktop shell. This is a thin native wrapper around the Chalk web
// client: the window loads the Chalk server directly and the existing
// `public/` web app runs inside it. All app logic, auth and sockets live in
// the web client and talk to the same origin they are served from
// (`API = window.location.origin`), so nothing here bridges into the page.
//
// The window is created in `setup` (not from tauri.conf.json) so we can load
// the right server per build profile via `WebviewUrl::External`:
//   - debug   → the local dev server (paired with `beforeDevCommand`)
//   - release → the shipped production server
// Using `External` is the documented way to point a Tauri window at remote
// content, so the connection is immediate — no in-page redirect.

use tauri::{WebviewUrl, WebviewWindowBuilder};

/// Local dev server (started by `beforeDevCommand` in tauri.conf.json).
const DEV_URL: &str = "http://localhost:3000";
/// Production Chalk server this build ships with.
const PROD_URL: &str = "https://chalk-production-01b7.up.railway.app";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            // CHALK_SERVER_URL overrides the built-in target (handy for pointing
            // the app at a staging/self-hosted server without a rebuild).
            let default = if cfg!(debug_assertions) { DEV_URL } else { PROD_URL };
            let target = std::env::var("CHALK_SERVER_URL").unwrap_or_else(|_| default.to_string());
            let url = target.parse().expect("Chalk server URL must be valid");

            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
                .title("Chalk")
                .inner_size(1200.0, 820.0)
                .min_inner_size(940.0, 600.0)
                .center()
                .build()?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running the Chalk desktop application");
}
