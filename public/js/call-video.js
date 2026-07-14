// ── IN-CALL VIDEO: webcam + screen share ─────────────────────────────────────
// UI layer on top of the low-level video APIs in /voice.js:
//   enableCamera / disableCamera / toggleCamera
//   startScreenShare / stopScreenShare / toggleScreenShare
//   playLocalVideo / playRemoteVideo / getVideoState
// Camera and screen are mutually exclusive on the outgoing side (see voice.js).

function _cvT(key, fallback) {
  if (window.T) { const v = window.T(key); if (v && v !== key) return v; }
  return fallback;
}
function _cvEsc(s) { return (window.escHtml ? window.escHtml(s) : String(s == null ? '' : s)); }
function _cvToast(msg) { if (window.showToast) window.showToast(msg); }

/* ---------------- CONTROL BUTTONS ---------------- */

async function toggleFCCamera() {
  if (!window.toggleCamera) return;
  const btn = document.getElementById('fcCamBtn');
  if (btn) btn.disabled = true;
  try {
    await window.toggleCamera();
  } catch (err) {
    console.warn('[call-video] camera toggle failed', err);
    _cvToast(_cvT('call_camera_failed', 'Не удалось включить камеру'));
  } finally {
    if (btn) btn.disabled = false;
    fcSyncVideo();
  }
}

async function toggleFCScreen() {
  if (!window.toggleScreenShare) return;
  const btn = document.getElementById('fcScreenBtn');
  if (btn) btn.disabled = true;
  try {
    await window.toggleScreenShare();
  } catch (err) {
    // A user cancelling the browser's screen-picker throws NotAllowedError —
    // that's not an error worth toasting.
    if (!(err && (err.name === 'NotAllowedError' || err.code === 'PERMISSION_DENIED'))) {
      console.warn('[call-video] screen toggle failed', err);
      _cvToast(_cvT('call_screen_failed', 'Не удалось начать демонстрацию экрана'));
    }
  } finally {
    if (btn) btn.disabled = false;
    fcSyncVideo();
  }
}

/* ---------------- TILE RENDERING ---------------- */

function fcVideoGrid() { return document.getElementById('fcVideoGrid'); }

function fcLocalLabel(state) {
  if (state.screen) return `🖥️ ${_cvT('call_your_screen', 'Ваш экран')}`;
  return `📷 ${_cvT('call_you', 'Вы')}`;
}

// Create a tile shell (id + label) if missing, returning its inner video holder.
function fcEnsureTile(id, label) {
  let tile = document.getElementById(id);
  if (!tile) {
    tile = document.createElement('div');
    tile.className = 'fc-vtile';
    tile.id = id;
    tile.innerHTML = `<div class="fc-vtile-video"></div><span class="fc-vtile-label"></span>`;
    fcVideoGrid().appendChild(tile);
  }
  const labelEl = tile.querySelector('.fc-vtile-label');
  if (labelEl) labelEl.innerHTML = label;
  return tile.querySelector('.fc-vtile-video');
}

function fcRemoveTile(id) {
  const tile = document.getElementById(id);
  if (tile) tile.remove();
}

// Reconcile the local tile + control buttons to the current video state. Safe to
// call repeatedly (idempotent) — used for every local video event.
function fcSyncVideo() {
  const st = window.getVideoState ? window.getVideoState() : { camera: false, screen: false, localActive: false };

  const camBtn = document.getElementById('fcCamBtn');
  const screenBtn = document.getElementById('fcScreenBtn');
  if (camBtn) camBtn.classList.toggle('active', Boolean(st.camera));
  if (screenBtn) screenBtn.classList.toggle('active', Boolean(st.screen));

  if (st.localActive) {
    const holder = fcEnsureTile('fcv-local', fcLocalLabel(st));
    if (window.playLocalVideo) window.playLocalVideo(holder);
  } else {
    fcRemoveTile('fcv-local');
  }

  fcUpdateGridVisibility();
}

function fcAddRemoteTile(uid) {
  const holder = fcEnsureTile(`fcv-remote-${uid}`, `👤 ${_cvEsc(_cvT('call_participant', 'Участник'))}`);
  if (window.playRemoteVideo) window.playRemoteVideo(uid, holder);
  fcUpdateGridVisibility();
}

function fcRemoveRemoteTile(uid) {
  fcRemoveTile(`fcv-remote-${uid}`);
  fcUpdateGridVisibility();
}

function fcUpdateGridVisibility() {
  const grid = fcVideoGrid();
  if (!grid) return;
  const hasTiles = grid.children.length > 0;
  grid.style.display = hasTiles ? 'grid' : 'none';
  // Space out tiles based on count (1 big, 2 side-by-side, 3+ wrap).
  grid.setAttribute('data-count', String(Math.min(grid.children.length, 4)));
}

// Reset everything at call start/end (mirrors fcResetCollab).
function fcResetVideo() {
  const grid = fcVideoGrid();
  if (grid) { grid.innerHTML = ''; grid.style.display = 'none'; }
  ['fcCamBtn', 'fcScreenBtn'].forEach((id) => {
    const b = document.getElementById(id);
    if (b) { b.classList.remove('active'); b.disabled = false; }
  });
}
window.fcResetVideo = fcResetVideo;

/* ---------------- EVENTS FROM voice.js ---------------- */

window.addEventListener('voice:video', (e) => {
  const d = (e && e.detail) || {};
  if (d.kind === 'remote') {
    if (d.action === 'add') fcAddRemoteTile(d.uid);
    else if (d.action === 'remove') fcRemoveRemoteTile(d.uid);
  } else {
    // Local camera/screen changed (including the browser's own "Stop sharing").
    fcSyncVideo();
  }
});
