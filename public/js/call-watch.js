// ── WATCH TOGETHER — synced YouTube video / Twitch stream inside a call ─────
// One participant pastes a link, everyone's embedded player loads it; play /
// pause / seek are relayed through the 'call:watch' socket event (server is a
// dumb relay, see src/socket/calls.ts). Twitch live streams are inherently
// "live-synced", so for Twitch only start/stop are relayed.
//
// TikTok has no controllable embed API (no play/pause/seek from JS), so it
// can't be synced — share TikTok links via the call clipboard instead.

let watchState = { provider: null, videoId: null };
let ytPlayer = null;        // YT.Player instance
let ytApiLoading = false;
let ytApplyingRemote = false; // guard: don't re-broadcast events we just applied
let watchLastSentSeek = 0;

// ── URL parsing ─────────────────────────────────────────────────────────────
// Returns { provider, videoId } or null. videoId is a bare id — the server
// schema rejects anything with URL metacharacters.
function parseWatchUrl(raw) {
  let url;
  try { url = new URL(raw.trim()); } catch (_) { return null; }
  const host = url.hostname.replace(/^www\./, '');

  if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'youtube-nocookie.com') {
    if (url.pathname.startsWith('/shorts/') || url.pathname.startsWith('/embed/') || url.pathname.startsWith('/live/')) {
      const id = url.pathname.split('/')[2];
      if (id && /^[\w-]{6,20}$/.test(id)) return { provider: 'youtube', videoId: id };
    }
    const v = url.searchParams.get('v');
    if (v && /^[\w-]{6,20}$/.test(v)) return { provider: 'youtube', videoId: v };
    return null;
  }
  if (host === 'youtu.be') {
    const id = url.pathname.slice(1).split('/')[0];
    if (id && /^[\w-]{6,20}$/.test(id)) return { provider: 'youtube', videoId: id };
    return null;
  }
  if (host === 'twitch.tv' || host === 'm.twitch.tv') {
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] === 'videos' && /^\d+$/.test(parts[1] || '')) return { provider: 'twitch', videoId: `v${parts[1]}` };
    if (parts[0] && /^[\w]{2,30}$/.test(parts[0])) return { provider: 'twitch', videoId: parts[0] };
    return null;
  }
  return null;
}

// ── Panel open/close ────────────────────────────────────────────────────────
function fcToggleWatch() {
  const panel = document.getElementById('fcWatch');
  if (!panel) return;
  const visible = panel.style.display !== 'none';
  panel.style.display = visible ? 'none' : 'flex';
  // Closing the panel while a video plays keeps it playing (audio continues) —
  // stopping for everyone is the explicit ⏹ button.
}

function fcCloseWatch() {
  const panel = document.getElementById('fcWatch');
  if (panel) panel.style.display = 'none';
}

// ── Start: parse the pasted link, load locally, broadcast ───────────────────
function fcStartWatch() {
  const input = document.getElementById('fcWatchInput');
  const parsed = parseWatchUrl(input.value || '');
  if (!parsed) {
    showToast(T('watch_bad_url', 'Не понял ссылку — поддерживаются YouTube и Twitch'));
    return;
  }
  input.value = '';
  applyWatchStart(parsed.provider, parsed.videoId, 0);
  if (socket && currentRoomId) {
    socket.emit('call:watch', { roomId: currentRoomId, action: 'start', provider: parsed.provider, videoId: parsed.videoId, t: 0 });
  }
}

function fcStopWatch() {
  destroyWatchPlayer();
  watchState = { provider: null, videoId: null };
  const hint = document.getElementById('fcWatchHint');
  if (hint) hint.style.display = '';
  if (socket && currentRoomId) socket.emit('call:watch', { roomId: currentRoomId, action: 'stop' });
}

function destroyWatchPlayer() {
  if (ytPlayer && typeof ytPlayer.destroy === 'function') { try { ytPlayer.destroy(); } catch (_) {} }
  ytPlayer = null;
  const box = document.getElementById('fcWatchPlayer');
  if (box) box.innerHTML = '';
}

// ── Load a video/stream into the local player ───────────────────────────────
function applyWatchStart(provider, videoId, t) {
  const panel = document.getElementById('fcWatch');
  const hint = document.getElementById('fcWatchHint');
  if (panel) panel.style.display = 'flex';
  if (hint) hint.style.display = 'none';
  destroyWatchPlayer();
  watchState = { provider, videoId };

  if (provider === 'twitch') {
    const box = document.getElementById('fcWatchPlayer');
    const isVod = /^v\d+$/.test(videoId);
    const parent = location.hostname;
    const src = isVod
      ? `https://player.twitch.tv/?video=${videoId}&parent=${encodeURIComponent(parent)}&autoplay=true`
      : `https://player.twitch.tv/?channel=${encodeURIComponent(videoId)}&parent=${encodeURIComponent(parent)}&autoplay=true`;
    box.innerHTML = `<iframe src="${src}" allowfullscreen allow="autoplay; fullscreen" style="width:100%;height:100%;border:0"></iframe>`;
    return;
  }

  // YouTube: load the IFrame API once, then create a controllable player.
  const create = () => {
    ytPlayer = new YT.Player('fcWatchPlayer', {
      videoId,
      playerVars: { autoplay: 1, start: Math.floor(t || 0), playsinline: 1 },
      events: {
        onStateChange: (e) => {
          if (ytApplyingRemote || !socket || !currentRoomId) return;
          const pos = (ytPlayer && ytPlayer.getCurrentTime && ytPlayer.getCurrentTime()) || 0;
          if (e.data === YT.PlayerState.PLAYING) {
            socket.emit('call:watch', { roomId: currentRoomId, action: 'play', t: pos });
          } else if (e.data === YT.PlayerState.PAUSED) {
            socket.emit('call:watch', { roomId: currentRoomId, action: 'pause', t: pos });
          }
        },
      },
    });
  };
  if (window.YT && YT.Player) return create();
  if (!ytApiLoading) {
    ytApiLoading = true;
    const tag = document.createElement('script');
    tag.src = 'https://www.youtube.com/iframe_api';
    document.head.appendChild(tag);
  }
  const prev = window.onYouTubeIframeAPIReady;
  window.onYouTubeIframeAPIReady = () => { if (typeof prev === 'function') prev(); create(); };
}

// ── Remote events from the other participants ───────────────────────────────
function onCallWatch(data) {
  if (data.action === 'start' && data.provider && data.videoId) {
    applyWatchStart(data.provider, data.videoId, data.t || 0);
    showToast(`📺 ${escHtml(data.fromName || '')} ${T('watch_started', 'включил(а) просмотр')}`);
    return;
  }
  if (data.action === 'stop') {
    destroyWatchPlayer();
    watchState = { provider: null, videoId: null };
    const hint = document.getElementById('fcWatchHint');
    if (hint) hint.style.display = '';
    return;
  }
  // play/pause/seek only make sense for the controllable YouTube player.
  if (!ytPlayer || watchState.provider !== 'youtube') return;
  ytApplyingRemote = true;
  try {
    const t = typeof data.t === 'number' ? data.t : null;
    if (data.action === 'play') {
      if (t != null && Math.abs((ytPlayer.getCurrentTime() || 0) - t) > 1.5) ytPlayer.seekTo(t, true);
      ytPlayer.playVideo();
    } else if (data.action === 'pause') {
      if (t != null && Math.abs((ytPlayer.getCurrentTime() || 0) - t) > 1.5) ytPlayer.seekTo(t, true);
      ytPlayer.pauseVideo();
    } else if (data.action === 'seek' && t != null) {
      ytPlayer.seekTo(t, true);
    }
  } catch (_) {}
  // Player callbacks fire async after our calls — release the guard next tick(s).
  setTimeout(() => { ytApplyingRemote = false; }, 500);
}

// Called from voice.js when the call actually ends, so a video never keeps
// playing (with sound) behind a closed call screen.
function resetWatchOnCallEnd() {
  destroyWatchPlayer();
  watchState = { provider: null, videoId: null };
  fcCloseWatch();
}
