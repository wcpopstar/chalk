// ── IN-CALL COLLABORATION: shared clipboard + collaborative whiteboard ──────
// Both relay over Socket.io to everyone in the current call room (see
// src/socket/calls.ts). The panel lives inside the full-call overlay and is
// toggled with the 📋 button. currentRoomId (global, set in call flow) is the
// room these events target.

// ── Panel open/close + tab switching ────────────────────────────────────────
function fcToggleCollab() {
  const panel = document.getElementById('fcCollab');
  if (!panel) return;
  const open = panel.style.display === 'none' || !panel.style.display;
  panel.style.display = open ? 'block' : 'none';
  if (open) { fcShowCollab('clip'); fcResizeBoard(); }
}
function fcCloseCollab() {
  const panel = document.getElementById('fcCollab');
  if (panel) panel.style.display = 'none';
}
function fcShowCollab(which) {
  document.getElementById('fcClipPane').style.display = which === 'clip' ? '' : 'none';
  document.getElementById('fcBoardPane').style.display = which === 'board' ? '' : 'none';
  document.getElementById('fcTabClip').classList.toggle('active', which === 'clip');
  document.getElementById('fcTabBoard').classList.toggle('active', which === 'board');
  if (which === 'board') fcResizeBoard();
}

// Resets both surfaces — called when a call starts so nothing leaks between
// calls.
function fcResetCollab() {
  const list = document.getElementById('fcClipList');
  if (list) list.innerHTML = `<div class="fc-clip-empty">${  T('collab_clip_empty', 'Делитесь ссылками, текстом, кодом и фото')  }</div>`;
  fcClearBoardLocal();
  fcCloseCollab();
}

// ── Shared clipboard ────────────────────────────────────────────────────────
function fcGuessKind(text) {
  if (/^https?:\/\/\S+$/i.test(text.trim())) return 'link';
  // Heuristic: multi-line or code-ish punctuation density → treat as code.
  if (text.indexOf('\n') !== -1 && /[{};()=<>]/.test(text)) return 'code';
  return 'text';
}

function fcSendClip() {
  const input = document.getElementById('fcClipInput');
  const text = (input.value || '').trim();
  if (!text || !socket || !currentRoomId) return;
  const kind = fcGuessKind(text);
  socket.emit('call:clipboard', { roomId: currentRoomId, kind, content: text });
  fcRenderClip({ from: currentUser.id, fromName: T('status_you', 'Ты'), kind, content: text, at: Date.now() }, true);
  input.value = '';
}

function fcPickClipImage() {
  const f = document.getElementById('fcClipFile');
  if (f) f.click();
}

function fcClipFileChosen(event) {
  const file = event.target.files && event.target.files[0];
  event.target.value = '';
  if (!file || !file.type.startsWith('image/')) return;
  const reader = new FileReader();
  reader.onload = function () {
    const img = new Image();
    img.onload = function () {
      // Resize so the shared data URL stays within the socket payload cap.
      const maxSide = 900;
      let w = img.width; let h = img.height;
      if (w > h && w > maxSide) { h = Math.round(h * maxSide / w); w = maxSide; }
      else if (h >= w && h > maxSide) { w = Math.round(w * maxSide / h); h = maxSide; }
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
      if (!socket || !currentRoomId) return;
      socket.emit('call:clipboard', { roomId: currentRoomId, kind: 'image', content: dataUrl });
      fcRenderClip({ from: currentUser.id, fromName: T('status_you', 'Ты'), kind: 'image', content: dataUrl, at: Date.now() }, true);
    };
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
}

// Renders one shared item. `mine` styles it as sent by me.
function fcRenderClip(item, mine) {
  const list = document.getElementById('fcClipList');
  if (!list) return;
  const empty = list.querySelector('.fc-clip-empty');
  if (empty) list.innerHTML = '';
  const who = escHtml(item.fromName || '');
  let body;
  if (item.kind === 'image') {
    body = `<img class="fc-clip-img" src="${  escHtml(item.content)  }" alt="" onclick="window.open(this.src,'_blank')">`;
  } else if (item.kind === 'link') {
    const safe = escHtml(item.content);
    body = `<a class="fc-clip-link" href="${  safe  }" target="_blank" rel="noopener noreferrer">${  safe  }</a>` +
      `<button class="fc-clip-copy" onclick="fcCopyText(this,'${  encodeURIComponent(item.content)  }')">📋</button>`;
  } else if (item.kind === 'code') {
    body = `<pre class="fc-clip-code">${  escHtml(item.content)  }</pre>` +
      `<button class="fc-clip-copy" onclick="fcCopyText(this,'${  encodeURIComponent(item.content)  }')">📋</button>`;
  } else {
    body = `<span class="fc-clip-text">${  escHtml(item.content)  }</span>` +
      `<button class="fc-clip-copy" onclick="fcCopyText(this,'${  encodeURIComponent(item.content)  }')">📋</button>`;
  }
  const div = document.createElement('div');
  div.className = `fc-clip-item${  mine ? ' mine' : ''}`;
  div.innerHTML = `<div class="fc-clip-from">${  who  }</div><div class="fc-clip-body">${  body  }</div>`;
  list.appendChild(div);
  list.scrollTop = list.scrollHeight;
}

function fcCopyText(btn, encoded) {
  const text = decodeURIComponent(encoded);
  const done = () => { if (btn) { const o = btn.textContent; btn.textContent = '✓'; setTimeout(() => { btn.textContent = o; }, 1200); } };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => {});
  } else {
    const ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch (_) {}
    document.body.removeChild(ta); done();
  }
}

// ── Collaborative whiteboard ────────────────────────────────────────────────
var _fcBoardDrawing = false;
var _fcLastX = 0;
var _fcLastY = 0;
var _fcSegBuffer = [];   // pending normalized [x0,y0,x1,y1] segments to flush
var _fcFlushTimer = null;

function fcBoardCtx() {
  const canvas = document.getElementById('fcBoardCanvas');
  return canvas ? canvas.getContext('2d') : null;
}

// Match the canvas's backing pixels to its displayed size (once visible) so
// strokes aren't stretched. Normalized coords keep existing content aligned.
function fcResizeBoard() {
  const canvas = document.getElementById('fcBoardCanvas');
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  if (canvas.width !== Math.round(rect.width) || canvas.height !== Math.round(rect.height)) {
    canvas.width = Math.round(rect.width);
    canvas.height = Math.round(rect.height);
  }
}

function fcBoardPos(e) {
  const canvas = document.getElementById('fcBoardCanvas');
  const rect = canvas.getBoundingClientRect();
  const p = (e.touches && e.touches[0]) ? e.touches[0] : e;
  return { x: (p.clientX - rect.left) / rect.width, y: (p.clientY - rect.top) / rect.height };
}

// Draw a normalized segment onto the local canvas.
function fcDrawSegment(x0, y0, x1, y1, color, width) {
  const ctx = fcBoardCtx();
  const canvas = document.getElementById('fcBoardCanvas');
  if (!ctx || !canvas) return;
  ctx.strokeStyle = color || '#c8ff00';
  ctx.lineWidth = width || 3;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(x0 * canvas.width, y0 * canvas.height);
  ctx.lineTo(x1 * canvas.width, y1 * canvas.height);
  ctx.stroke();
}

function fcBoardDown(e) {
  e.preventDefault();
  fcResizeBoard();
  _fcBoardDrawing = true;
  const p = fcBoardPos(e);
  _fcLastX = p.x; _fcLastY = p.y;
}

function fcBoardMove(e) {
  if (!_fcBoardDrawing) return;
  e.preventDefault();
  const p = fcBoardPos(e);
  const color = document.getElementById('fcBoardColor').value;
  const width = parseInt(document.getElementById('fcBoardWidth').value, 10) || 3;
  fcDrawSegment(_fcLastX, _fcLastY, p.x, p.y, color, width);
  _fcSegBuffer.push([_fcLastX, _fcLastY, p.x, p.y]);
  _fcLastX = p.x; _fcLastY = p.y;
  // Throttle network sends: flush the buffered segments at ~30fps.
  if (!_fcFlushTimer) _fcFlushTimer = setTimeout(fcFlushSegments, 33);
}

function fcBoardUp() {
  if (!_fcBoardDrawing) return;
  _fcBoardDrawing = false;
  fcFlushSegments();
}

function fcFlushSegments() {
  _fcFlushTimer = null;
  if (!_fcSegBuffer.length || !socket || !currentRoomId) { _fcSegBuffer = []; return; }
  const color = document.getElementById('fcBoardColor').value;
  const width = parseInt(document.getElementById('fcBoardWidth').value, 10) || 3;
  // The schema caps a batch at 200 segments — chunk if a burst exceeds it.
  const batch = _fcSegBuffer.splice(0, 200);
  socket.emit('call:draw', { roomId: currentRoomId, color, width, segments: batch });
  if (_fcSegBuffer.length) _fcFlushTimer = setTimeout(fcFlushSegments, 33);
}

function fcClearBoardLocal() {
  const ctx = fcBoardCtx();
  const canvas = document.getElementById('fcBoardCanvas');
  if (ctx && canvas) ctx.clearRect(0, 0, canvas.width, canvas.height);
}

function fcClearBoard() {
  fcClearBoardLocal();
  if (socket && currentRoomId) socket.emit('call:draw_clear', { roomId: currentRoomId });
}

// Attach canvas listeners once the DOM is ready.
function fcInitBoardListeners() {
  const canvas = document.getElementById('fcBoardCanvas');
  if (!canvas || canvas._fcBound) return;
  canvas._fcBound = true;
  canvas.addEventListener('mousedown', fcBoardDown);
  canvas.addEventListener('mousemove', fcBoardMove);
  window.addEventListener('mouseup', fcBoardUp);
  canvas.addEventListener('touchstart', fcBoardDown, { passive: false });
  canvas.addEventListener('touchmove', fcBoardMove, { passive: false });
  canvas.addEventListener('touchend', fcBoardUp);
}

// ── Incoming socket events (wired from socket.js) ───────────────────────────
function onCallClipboard(data) {
  // Show the collab panel (clipboard tab) so a share isn't missed.
  const panel = document.getElementById('fcCollab');
  if (panel && (panel.style.display === 'none' || !panel.style.display)) { /* leave closed; badge could go here */ }
  fcRenderClip(data, false);
}
function onCallDraw(data) {
  const segs = data.segments || [];
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    fcDrawSegment(s[0], s[1], s[2], s[3], data.color, data.width);
  }
}
function onCallDrawClear() { fcClearBoardLocal(); }

document.addEventListener('DOMContentLoaded', fcInitBoardListeners);
