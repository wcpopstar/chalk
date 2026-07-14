// ── VOICE-MESSAGE TRANSCRIPTION ──────────────────────────────────────────────
// Sends a voice note's public URL to the backend (/api/transcribe), which runs
// it through a Whisper-compatible STT provider and returns the text. The button
// is only rendered on other people's voice notes when the feature is enabled
// (see message-render.js + the transcription.enabled flag).

function _trT(key, fallback) {
  if (window.T) { const v = window.T(key); if (v && v !== key) return v; }
  return fallback;
}

async function transcribeVoiceMsg(btn) {
  if (!btn || btn.disabled) return;
  const {url} = btn.dataset;
  if (!url) return;

  const voiceWrap = btn.closest('.msg-voice');
  const out = voiceWrap ? voiceWrap.querySelector('.msg-transcript') : null;

  const original = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = `⏳ ${_trT('transcribe_loading', 'Расшифровка…')}`;

  try {
    const data = await api('/api/transcribe', {
      method: 'POST',
      body: JSON.stringify({ mediaUrl: url }),
    });
    const text = (data && data.text) ? String(data.text).trim() : '';
    if (out) {
      out.textContent = text || _trT('transcribe_empty', '(не удалось распознать речь)');
      out.style.display = 'block';
    }
    // Success: the transcript replaces the button (one-shot).
    btn.remove();
  } catch (err) {
    btn.disabled = false;
    btn.innerHTML = original;
    if (err && err.status === 503) {
      if (window.showToast) window.showToast(_trT('transcribe_not_configured', 'Транскрипция не настроена на сервере'));
    } else if (err && err.status === 429) {
      if (window.showToast) window.showToast(_trT('transcribe_rate_limited', 'Слишком много запросов, подожди немного'));
    } else if (window.showToast) window.showToast(_trT('transcribe_failed', 'Не удалось расшифровать сообщение'));
  }
}

window.transcribeVoiceMsg = transcribeVoiceMsg;
