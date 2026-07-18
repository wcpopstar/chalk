// ── "Call" with the Chalk AI bot ─────────────────────────────────────────────
// Not a real Agora call: the browser transcribes the user's speech with the
// Web Speech API (SpeechRecognition), sends the text to POST /api/ai/reply,
// and speaks the reply with speechSynthesis. Free, no audio ever leaves the
// device — only the transcribed text goes to the server. The transcript is
// ephemeral (kept in memory for context, never saved to the conversation).
//
// startFriendCall() (trial-call.js) routes here when the DM partner is a bot.
// Browsers without SpeechRecognition (Firefox) still get the call UI with a
// text input — the bot answers out loud either way if TTS is available.

var aiCall = {
  active: false,
  muted: false,
  speaking: false,
  thinking: false,
  history: [],   // [{role:'user'|'assistant', content}] — rolling context
  rec: null,
  partner: null,
};

function aiSpeechSupported() {
  return Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);
}

function aiCallLang() {
  const map = { ru: 'ru-RU', en: 'en-US', nl: 'nl-NL', uk: 'uk-UA' };
  return map[typeof currentLang !== 'undefined' ? currentLang : 'ru'] || 'ru-RU';
}

// ── UI ───────────────────────────────────────────────────────────────────────
function buildAiCallOverlay(partner) {
  const old = document.getElementById('aiCallOverlay');
  if (old) old.remove();
  const wrap = document.createElement('div');
  wrap.id = 'aiCallOverlay';
  wrap.className = 'ai-call-overlay';
  const micHint = aiSpeechSupported()
    ? ''
    : `<div class="ai-call-nomic">${T('ai_call_no_stt', 'Браузер не поддерживает распознавание речи — пиши текстом, отвечу голосом')}</div>`;
  wrap.innerHTML =
    `<div class="ai-call-card">` +
      `<div class="ai-call-ava" id="aiCallAva">✨</div>` +
      `<div class="ai-call-name">${escHtml((partner && partner.username) || 'Chalk AI')}</div>` +
      `<div class="ai-call-status" id="aiCallStatus"></div>` +
      micHint +
      `<div class="ai-call-transcript" id="aiCallTranscript"></div>` +
      `<div class="ai-call-textrow">` +
        `<input type="text" id="aiCallTextInput" placeholder="${T('ai_call_type_ph', 'Можно и текстом…')}" onkeydown="if(event.key==='Enter')aiCallSendTyped()">` +
        `<button type="button" onclick="aiCallSendTyped()">➤</button>` +
      `</div>` +
      `<div class="ai-call-controls">` +
        `<button type="button" class="ai-call-btn" id="aiCallMuteBtn" onclick="aiCallToggleMute()" title="${T('ai_call_mute', 'Микрофон')}">🎙️</button>` +
        `<button type="button" class="ai-call-btn ai-call-end" onclick="endAiCall()" title="${T('ai_call_end', 'Завершить')}">📞</button>` +
      `</div>` +
    `</div>`;
  document.body.appendChild(wrap);
}

function aiCallSetStatus(kind) {
  const el = document.getElementById('aiCallStatus');
  const ava = document.getElementById('aiCallAva');
  if (!el) return;
  const texts = {
    listening: T('ai_call_listening', 'Слушаю…'),
    thinking: T('ai_call_thinking', 'Думаю…'),
    speaking: T('ai_call_speaking', 'Говорю…'),
    muted: T('ai_call_muted', 'Микрофон выключен'),
  };
  el.textContent = texts[kind] || '';
  if (ava) ava.className = `ai-call-ava${kind === 'speaking' ? ' speaking' : ''}${kind === 'thinking' ? ' thinking' : ''}`;
}

function aiCallPushLine(role, text, cssId) {
  const box = document.getElementById('aiCallTranscript');
  if (!box) return;
  const line = document.createElement('div');
  line.className = `ai-call-line ${role === 'user' ? 'me' : 'bot'}`;
  if (cssId) line.id = cssId;
  line.textContent = text;
  box.appendChild(line);
  box.scrollTop = box.scrollHeight;
}

// ── Speech synthesis (the bot's voice) ───────────────────────────────────────
function aiSpeak(text, onDone) {
  if (!('speechSynthesis' in window)) { if (onDone) onDone(); return; }
  try { speechSynthesis.cancel(); } catch (_) {}
  const utter = new SpeechSynthesisUtterance(text);
  const lang = aiCallLang();
  utter.lang = lang;
  // Prefer a matching-language voice if the browser exposes one.
  const voices = speechSynthesis.getVoices() || [];
  const voice = voices.find((v) => v.lang === lang) || voices.find((v) => v.lang && v.lang.slice(0, 2) === lang.slice(0, 2));
  if (voice) utter.voice = voice;
  utter.rate = 1.05;
  aiCall.speaking = true;
  aiCallSetStatus('speaking');
  const finish = () => {
    aiCall.speaking = false;
    if (onDone) onDone();
  };
  utter.onend = finish;
  utter.onerror = finish;
  speechSynthesis.speak(utter);
}

// ── Speech recognition (the user's voice) ────────────────────────────────────
function aiListen() {
  if (!aiCall.active || aiCall.muted || aiCall.speaking || aiCall.thinking) return;
  if (!aiSpeechSupported()) { aiCallSetStatus('listening'); return; }
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const rec = new SR();
  aiCall.rec = rec;
  rec.lang = aiCallLang();
  rec.interimResults = false;
  rec.maxAlternatives = 1;
  rec.onresult = (e) => {
    const text = (e.results[0] && e.results[0][0] && e.results[0][0].transcript || '').trim();
    if (text) aiCallHandleUtterance(text);
  };
  rec.onerror = (e) => {
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
      showToast(T('ai_call_mic_denied', 'Нет доступа к микрофону — можно писать текстом'));
      aiCall.muted = true;
      const btn = document.getElementById('aiCallMuteBtn');
      if (btn) btn.classList.add('muted');
      aiCallSetStatus('muted');
    }
    // 'no-speech'/'aborted'/network → onend fires next and restarts the loop.
  };
  rec.onend = () => {
    if (aiCall.rec === rec) aiCall.rec = null;
    // Keep listening between utterances (recognition sessions are short-lived).
    if (aiCall.active && !aiCall.muted && !aiCall.speaking && !aiCall.thinking) {
      setTimeout(aiListen, 250);
    }
  };
  try { rec.start(); aiCallSetStatus('listening'); } catch (_) { /* already started */ }
}

function aiStopListening() {
  if (aiCall.rec) { try { aiCall.rec.abort(); } catch (_) {} aiCall.rec = null; }
}

// ── One conversational turn ──────────────────────────────────────────────────
async function aiCallHandleUtterance(text) {
  if (!aiCall.active) return;
  aiStopListening();
  aiCall.thinking = true;
  aiCallPushLine('user', text);
  aiCall.history.push({ role: 'user', content: text });
  if (aiCall.history.length > 12) aiCall.history = aiCall.history.slice(-12);
  aiCallSetStatus('thinking');
  try {
    const data = await api('/api/ai/reply', { method: 'POST', body: JSON.stringify({ messages: aiCall.history }) });
    if (!aiCall.active) return;
    aiCall.thinking = false;
    aiCall.history.push({ role: 'assistant', content: data.text });
    aiCallPushLine('assistant', data.text);
    aiSpeak(data.text, aiListen);
  } catch (e) {
    aiCall.thinking = false;
    if (aiCall.active) {
      showToast(`${T('err_generic')} ${e.message}`);
      aiListen();
    }
  }
}

function aiCallSendTyped() {
  const input = document.getElementById('aiCallTextInput');
  const text = input && input.value.trim();
  if (!text || aiCall.thinking) return;
  input.value = '';
  aiCallHandleUtterance(text);
}

function aiCallToggleMute() {
  aiCall.muted = !aiCall.muted;
  const btn = document.getElementById('aiCallMuteBtn');
  if (btn) btn.classList.toggle('muted', aiCall.muted);
  if (aiCall.muted) { aiStopListening(); aiCallSetStatus('muted'); }
  else aiListen();
}

// ── Entry / exit ─────────────────────────────────────────────────────────────
function startAiCall(partner) {
  if (aiCall.active) return;
  aiCall = { active: true, muted: false, speaking: false, thinking: false, history: [], rec: null, partner: partner || null };
  buildAiCallOverlay(partner);
  // Chrome loads voices async; poke the list so aiSpeak() finds a match later.
  if ('speechSynthesis' in window) try { speechSynthesis.getVoices(); } catch (_) {}
  const greeting = T('ai_call_greeting', 'Привет! Я слушаю — спрашивай про Chalk или просто поболтаем.');
  aiCall.history.push({ role: 'assistant', content: greeting });
  aiCallPushLine('assistant', greeting);
  aiSpeak(greeting, aiListen);
}

function endAiCall() {
  aiCall.active = false;
  aiStopListening();
  if ('speechSynthesis' in window) try { speechSynthesis.cancel(); } catch (_) {}
  const el = document.getElementById('aiCallOverlay');
  if (el) el.remove();
}
