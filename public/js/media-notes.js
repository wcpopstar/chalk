// ── VOICE NOTES (record with MediaRecorder, upload over the socket) ─────────
var voiceRecorders = {}; // scope -> { mediaRecorder, chunks, stream, startedAt, timerEl, timerInterval }

function voiceMimeType() {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'];
  for (let i = 0; i < candidates.length; i++) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(candidates[i])) return candidates[i];
  }
  return '';
}

async function toggleVoiceRecording(scope) {
  if (voiceRecorders[scope] && voiceRecorders[scope].mediaRecorder && voiceRecorders[scope].mediaRecorder.state === 'recording') {
    stopVoiceRecording(scope, true);
    return;
  }
  if (scope === 'conv' && !currentConvId) { showToast(T('voice_choose_dialog_first')); return; }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showToast(T('voice_browser_not_supported'));
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mime = voiceMimeType();
    const mediaRecorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
    const chunks = [];
    mediaRecorder.ondataavailable = function(e) { if (e.data && e.data.size) chunks.push(e.data); };
    mediaRecorder.onstop = function() { stream.getTracks().forEach((t) =>{ t.stop(); }); };
    mediaRecorder.start();

    voiceRecorders[scope] = { mediaRecorder, chunks, stream, startedAt: Date.now(), mime: mime || 'audio/webm' };

    const micBtn = document.getElementById(`voiceBtn-${  scope}`);
    if (micBtn) micBtn.classList.add('recording');
    showVoiceRecordingBar(scope);
  } catch (e) {
    showToast(T('voice_no_mic_access'));
  }
}

function showVoiceRecordingBar(scope) {
  if (scope === 'conv' && typeof chatActivityStart === 'function') chatActivityStart('voice');
  const inputRow = document.getElementById(scope === 'global' ? 'globalChatInput' : 'chatInput');
  if (!inputRow) return;
  const container = inputRow.closest('.chat-input-row, .gc-input-row');
  if (!container) return;
  const bar = document.createElement('div');
  bar.className = 'voice-recording-bar';
  bar.id = `voiceBar-${  scope}`;
  bar.innerHTML = `<span class="voice-recording-dot"></span><span id="voiceTimer-${  scope  }">0:00</span><span><span data-i18n="voice_recording_label">Запись голосового...</span></span><button class="voice-recording-cancel" onclick="cancelVoiceRecording('${  scope  }')"><span data-i18n="status_cancel">Отмена</span></button>`;
  container.appendChild(bar);
  const timerEl = bar.querySelector(`#voiceTimer-${  scope}`);
  const rec = voiceRecorders[scope];
  rec.timerInterval = setInterval(() => {
    const secs = Math.floor((Date.now() - rec.startedAt) / 1000);
    const m = Math.floor(secs / 60); const s = secs % 60;
    timerEl.textContent = `${m  }:${  s < 10 ? '0' : ''  }${s}`;
    if (secs >= 120) stopVoiceRecording(scope, true); // hard cap ~2 minutes
  }, 250);
}

function removeVoiceRecordingBar(scope) {
  if (scope === 'conv' && typeof chatActivityStop === 'function') chatActivityStop();
  const bar = document.getElementById(`voiceBar-${  scope}`);
  if (bar) bar.remove();
  const rec = voiceRecorders[scope];
  if (rec && rec.timerInterval) clearInterval(rec.timerInterval);
  const micBtn = document.getElementById(`voiceBtn-${  scope}`);
  if (micBtn) micBtn.classList.remove('recording');
}

function cancelVoiceRecording(scope) {
  const rec = voiceRecorders[scope];
  if (!rec) return;
  if (rec.mediaRecorder && rec.mediaRecorder.state !== 'inactive') {
    rec.mediaRecorder.onstop = function() { rec.stream.getTracks().forEach((t) =>{ t.stop(); }); };
    rec.mediaRecorder.stop();
  }
  removeVoiceRecordingBar(scope);
  delete voiceRecorders[scope];
}

function stopVoiceRecording(scope, send) {
  const rec = voiceRecorders[scope];
  if (!rec || !rec.mediaRecorder) return;
  const duration = (Date.now() - rec.startedAt) / 1000;
  removeVoiceRecordingBar(scope);

  rec.mediaRecorder.onstop = function() {
    rec.stream.getTracks().forEach((t) =>{ t.stop(); });
    if (!send || duration < 0.6) { delete voiceRecorders[scope]; return; }
    const blob = new Blob(rec.chunks, { type: rec.mime });
    blob.arrayBuffer().then((buf) => {
      if (scope === 'global') {
        socket.emit('global:voice', { audio: buf, mime: rec.mime, duration }, handleVoiceAck);
      } else {
        socket.emit('chat:voice', { conversationId: currentConvId, audio: buf, mime: rec.mime, duration }, handleVoiceAck);
      }
    });
    delete voiceRecorders[scope];
  };
  if (rec.mediaRecorder.state !== 'inactive') rec.mediaRecorder.stop();
}

function handleVoiceAck(res) {
  if (res && res.error) showToast(`❌ ${  res.error}`);
}

// ── MESSAGE SEARCH (search inside the currently open chat) ─────────────────
var msgSearchState = {}; // scope -> { query, matches: [els], index }

function msgSearchContainer(scope) {
  return document.getElementById(scope === 'global' ? 'globalChatMessages' : 'chatMessages');
}

function toggleMsgSearch(scope) {
  const bar = document.getElementById(`msgSearchBar-${  scope}`);
  if (!bar) return;
  const opening = !bar.classList.contains('show');
  bar.classList.toggle('show', opening);
  clearMsgSearch(scope);
  if (opening) {
    const input = document.getElementById(`msgSearchInput-${  scope}`);
    if (input) { input.value = ''; input.focus(); }
  }
}

function clearMsgSearch(scope) {
  const container = msgSearchContainer(scope);
  if (container) {
    container.querySelectorAll('.msg-text, .gc-msg-text').forEach((el) => { resetMessageTextHtml(el); });
  }
  msgSearchState[scope] = { query: '', matches: [], index: -1 };
  updateMsgSearchCount(scope);
}

function resetMessageTextHtml(el) {
  const raw = el.getAttribute('data-rawtext');
  if (raw === null) return; // not a searchable text bubble (voice/gif/video/deleted)
  const editedTag = el.getAttribute('data-editedtag') || '';
  el.innerHTML = escHtml(raw) + editedTag;
}

var msgSearchTimer = null;
function msgSearchInput(scope, query) {
  clearTimeout(msgSearchTimer);
  msgSearchTimer = setTimeout(() => { performMsgSearch(scope, query); }, 150);
}

function msgSearchKeydown(e, scope) {
  if (e.key === 'Enter') { e.preventDefault(); msgSearchStep(scope, e.shiftKey ? -1 : 1); }
  if (e.key === 'Escape') toggleMsgSearch(scope);
}

function performMsgSearch(scope, query) {
  const container = msgSearchContainer(scope);
  if (!container) return;
  container.querySelectorAll('.msg-text, .gc-msg-text').forEach((el) => { resetMessageTextHtml(el); });

  query = (query || '').trim();
  if (!query) { msgSearchState[scope] = { query: '', matches: [], index: -1 }; updateMsgSearchCount(scope); return; }

  const q = query.toLowerCase();
  const matches = [];
  container.querySelectorAll('.msg-text[data-rawtext], .gc-msg-text[data-rawtext]').forEach((el) => {
    const raw = el.getAttribute('data-rawtext') || '';
    const lower = raw.toLowerCase();
    if (lower.indexOf(q) === -1) return;
    // Remember whether an "(edited)" tag was rendered so we can restore it after highlighting.
    const editedTag = el.querySelector('.msg-edited-tag');
    el.setAttribute('data-editedtag', editedTag ? editedTag.outerHTML : '');
    let html = ''; let pos = 0; let i;
    while ((i = lower.indexOf(q, pos)) !== -1) {
      html += `${escHtml(raw.slice(pos, i))  }<mark class="msg-search-hit">${  escHtml(raw.slice(i, i + q.length))  }</mark>`;
      pos = i + q.length;
      matches.push(el); // one entry per occurrence within this element is overkill; track element-level matches below
    }
    html += escHtml(raw.slice(pos)) + (editedTag ? editedTag.outerHTML : '');
    el.innerHTML = html;
  });

  // De-dupe to one match-target per message element (first hit within it), in document order.
  const seen = new Set();
  const els = [];
  container.querySelectorAll('.msg-text mark.msg-search-hit, .gc-msg-text mark.msg-search-hit').forEach((mk) => {
    const host = mk.closest('.msg-text, .gc-msg-text');
    if (host && !seen.has(host)) { seen.add(host); els.push(host); }
  });

  msgSearchState[scope] = { query: q, matches: els, index: els.length ? 0 : -1 };
  updateMsgSearchCount(scope);
  if (els.length) focusMsgSearchMatch(scope);
}

function msgSearchStep(scope, dir) {
  const st = msgSearchState[scope];
  if (!st || !st.matches.length) return;
  st.index = (st.index + dir + st.matches.length) % st.matches.length;
  updateMsgSearchCount(scope);
  focusMsgSearchMatch(scope);
}

function focusMsgSearchMatch(scope) {
  const st = msgSearchState[scope];
  if (!st || st.index < 0) return;
  const container = msgSearchContainer(scope);
  if (container) container.querySelectorAll('mark.msg-search-hit.active').forEach((m) => { m.classList.remove('active'); });
  const el = st.matches[st.index];
  if (!el) return;
  const mark = el.querySelector('mark.msg-search-hit');
  if (mark) mark.classList.add('active');
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

function updateMsgSearchCount(scope) {
  const countEl = document.getElementById(`msgSearchCount-${  scope}`);
  if (!countEl) return;
  const st = msgSearchState[scope];
  if (!st || !st.query) { countEl.textContent = ''; return; }
  countEl.textContent = st.matches.length ? `${st.index + 1  }/${  st.matches.length}` : '0/0';
}

// ── VIDEO NOTES ("video kruzhki" — circular video messages, like Telegram) ──
var videoNoteRecorders = {}; // scope -> { mediaRecorder, chunks, stream, startedAt, mime, timerInterval }
var MAX_VIDEO_NOTE_SECONDS = 30;

function videoNoteMimeType() {
  const candidates = ['video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'];
  for (let i = 0; i < candidates.length; i++) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(candidates[i])) return candidates[i];
  }
  return '';
}

async function toggleVideoNoteRecording(scope) {
  if (videoNoteRecorders[scope] && videoNoteRecorders[scope].mediaRecorder && videoNoteRecorders[scope].mediaRecorder.state === 'recording') {
    stopVideoNoteRecording(scope);
    return;
  }
  if (scope === 'conv' && !currentConvId) { showToast(T('voice_choose_dialog_first')); return; }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showToast(T('voice_browser_not_supported'));
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 320 }, height: { ideal: 320 }, aspectRatio: 1, facingMode: 'user' },
      audio: true
    });
    const mime = videoNoteMimeType();
    const opts = { videoBitsPerSecond: 300000 };
    if (mime) opts.mimeType = mime;
    const mediaRecorder = new MediaRecorder(stream, opts);
    const chunks = [];
    mediaRecorder.ondataavailable = function(e) { if (e.data && e.data.size) chunks.push(e.data); };
    mediaRecorder.start();

    videoNoteRecorders[scope] = { mediaRecorder, chunks, stream, startedAt: Date.now(), mime: mime || 'video/webm' };
    const btn = document.getElementById(`videoBtn-${  scope}`);
    if (btn) btn.classList.add('recording');
    showVideoNoteOverlay(scope, stream);
  } catch (e) {
    showToast(T('voice_no_mic_access'));
  }
}

function showVideoNoteOverlay(scope, stream) {
  if (scope === 'conv' && typeof chatActivityStart === 'function') chatActivityStart('video');
  const anchorInput = document.getElementById(scope === 'global' ? 'globalChatInput' : 'chatInput');
  const container = anchorInput && anchorInput.closest('.chat-input-row, .gc-input-row');
  if (!container) return;
  const overlay = document.createElement('div');
  overlay.className = 'video-note-overlay';
  overlay.id = `videoNoteOverlay-${  scope}`;
  overlay.innerHTML =
    `<div class="video-note-preview-wrap" id="videoNoteWrap-${  scope  }">` +
      `<video class="video-note-preview" id="videoNotePreview-${  scope  }" autoplay muted playsinline></video>` +
      `<span class="video-note-rec-dot"></span>` +
      `<span class="video-note-timer" id="videoNoteTimer-${  scope  }">0:00</span>` +
    `</div>` +
    `<div class="video-note-actions">` +
      `<button class="video-note-btn secondary" onclick="cancelVideoNoteRecording('${  scope  }')">✕ Отмена</button>` +
      `<button class="video-note-btn" onclick="toggleVideoNoteRecording('${  scope  }')">⏹ Стоп</button>` +
    `</div>`;
  container.appendChild(overlay);
  const previewEl = overlay.querySelector(`#videoNotePreview-${  scope}`);
  previewEl.srcObject = stream;

  const timerEl = overlay.querySelector(`#videoNoteTimer-${  scope}`);
  const rec = videoNoteRecorders[scope];
  rec.timerInterval = setInterval(() => {
    const secs = Math.floor((Date.now() - rec.startedAt) / 1000);
    const m = Math.floor(secs / 60); const s = secs % 60;
    timerEl.textContent = `${m  }:${  s < 10 ? '0' : ''  }${s}`;
    if (secs >= MAX_VIDEO_NOTE_SECONDS) stopVideoNoteRecording(scope);
  }, 250);
}

function removeVideoNoteOverlay(scope) {
  if (scope === 'conv' && typeof chatActivityStop === 'function') chatActivityStop();
  const overlay = document.getElementById(`videoNoteOverlay-${  scope}`);
  if (overlay) overlay.remove();
  const rec = videoNoteRecorders[scope];
  if (rec && rec.timerInterval) clearInterval(rec.timerInterval);
  const btn = document.getElementById(`videoBtn-${  scope}`);
  if (btn) btn.classList.remove('recording');
}

function cancelVideoNoteRecording(scope) {
  const rec = videoNoteRecorders[scope];
  if (!rec) return;
  if (rec.mediaRecorder && rec.mediaRecorder.state !== 'inactive') {
    rec.mediaRecorder.onstop = function() { rec.stream.getTracks().forEach((t) =>{ t.stop(); }); };
    rec.mediaRecorder.stop();
  } else {
    rec.stream.getTracks().forEach((t) =>{ t.stop(); });
  }
  removeVideoNoteOverlay(scope);
  delete videoNoteRecorders[scope];
}

function stopVideoNoteRecording(scope) {
  const rec = videoNoteRecorders[scope];
  if (!rec || !rec.mediaRecorder) return;
  const duration = (Date.now() - rec.startedAt) / 1000;
  removeVideoNoteOverlay(scope);

  rec.mediaRecorder.onstop = function() {
    rec.stream.getTracks().forEach((t) =>{ t.stop(); });
    if (duration < 0.6) { delete videoNoteRecorders[scope]; return; }
    const blob = new Blob(rec.chunks, { type: rec.mime });
    blob.arrayBuffer().then((buf) => {
      if (scope === 'global') {
        socket.emit('global:video_note', { video: buf, mime: rec.mime, duration }, handleVoiceAck);
      } else {
        socket.emit('chat:video_note', { conversationId: currentConvId, video: buf, mime: rec.mime, duration }, handleVoiceAck);
      }
    });
    delete videoNoteRecorders[scope];
  };
  if (rec.mediaRecorder.state !== 'inactive') rec.mediaRecorder.stop();
}

