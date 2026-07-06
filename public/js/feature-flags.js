// ── FEATURE FLAGS ────────────────────────────────────────────────────────────
// Fetched once per session in bootApp(). Server is always the source of
// truth (routes still 404 if a flag is off), so this only ever needs to
// hide UI that would otherwise lead to a dead end — never gate anything
// security-sensitive on the client side.
var featureFlags = {};

async function loadFeatureFlags() {
  try {
    var data = await api('/api/flags');
    featureFlags = data.flags || {};
  } catch (e) {
    // If this fails, leave every feature visible — the server-side
    // kill-switch still applies if a route is actually disabled, so failing
    // open here just means someone might tap a hidden feature's button
    // that then reports "not found", rather than losing UI they should see.
    console.error(e);
  }
  applyFeatureFlagsToUI();
}

function isFeatureEnabled(key) {
  return featureFlags[key] !== false;
}

function applyFeatureFlagsToUI() {
  var discoverTab = document.getElementById('navTabDiscover');
  if (discoverTab) discoverTab.style.display = isFeatureEnabled('discovery.enabled') ? '' : 'none';

  var tetrisBtn = document.getElementById('tetrisLaunchBtn');
  if (tetrisBtn) tetrisBtn.style.display = isFeatureEnabled('games.tetris.enabled') ? '' : 'none';
}
