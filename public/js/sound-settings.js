// ── SOUND SETTINGS (settings → Звук) ─────────────────────────────────────────
// Device pickers, volume, voice mode (open vs push-to-talk) + key binding, and
// a mic equalizer. The low-level audio APIs live in /voice.js — this file is
// the settings UI on top of them, plus a local mic test meter.

var soundTestState = null; // { stream, ctx, analyser, raf }
var pttKey = null;         // e.g. "KeyV" — the push-to-talk key code
var pttCapturing = false;

try { pttKey = localStorage.getItem('chalk_ptt_key') || null; } catch (_) {}

function pttKeyLabel(code) {
  if (!code) return T('settings_ptt_none', 'не выбрана');
  return code.replace(/^Key/, '').replace(/^Digit/, '').replace(/^Arrow/, '↑↓←→ ').replace(/Space/, '␣ Пробел');
}

async function loadSoundSection() {
  const prefs = (window.getSoundPrefs && window.getSoundPrefs()) || { micGain: 1, outVolume: 100, eqEnabled: false, eqGains: [0, 0, 0, 0, 0], pttMode: false };

  // Devices
  let devices = { microphones: [], speakers: [], currentMicId: null, currentSpeakerId: null };
  try { if (window.listAudioDevices) devices = await window.listAudioDevices(); } catch (_) {}
  const micSel = document.getElementById('soundMicSelect');
  const spkSel = document.getElementById('soundSpeakerSelect');
  if (micSel) {
    micSel.innerHTML = devices.microphones.length
      ? devices.microphones.map((d, i) => `<option value="${escHtml(d.deviceId)}"${d.deviceId === devices.currentMicId ? ' selected' : ''}>${escHtml(d.label || (`${T('call_mic', 'Микрофон')  } ${  i + 1}`))}</option>`).join('')
      : `<option>${T('call_no_devices', 'Устройства не найдены — разреши доступ к микрофону')}</option>`;
    micSel.onchange = () => { if (window.setMicrophoneDevice) window.setMicrophoneDevice(micSel.value); };
  }
  if (spkSel) {
    spkSel.innerHTML = devices.speakers.length
      ? devices.speakers.map((d, i) => `<option value="${escHtml(d.deviceId)}"${d.deviceId === devices.currentSpeakerId ? ' selected' : ''}>${escHtml(d.label || (`${T('call_speaker', 'Динамик')  } ${  i + 1}`))}</option>`).join('')
      : `<option>${T('call_no_devices', 'Устройства не найдены')}</option>`;
    spkSel.onchange = () => { if (window.setSpeakerDevice) window.setSpeakerDevice(spkSel.value); };
  }

  // Volume sliders
  const outVol = document.getElementById('soundOutVol');
  if (outVol) { outVol.value = prefs.outVolume; document.getElementById('soundOutVolLabel').textContent = `${prefs.outVolume}%`; }
  const micGain = document.getElementById('soundMicGain');
  if (micGain) { micGain.value = Math.round(prefs.micGain * 100); document.getElementById('soundMicGainLabel').textContent = `${Math.round(prefs.micGain * 100)}%`; }

  // Voice mode
  const mode = prefs.pttMode ? 'ptt' : 'open';
  document.querySelectorAll('input[name="voiceMode"]').forEach((r) => { r.checked = r.value === mode; });
  document.getElementById('pttKeyRow').style.display = prefs.pttMode ? 'block' : 'none';
  const pttBtn = document.getElementById('pttKeyBtn');
  if (pttBtn) pttBtn.textContent = pttKeyLabel(pttKey);

  // Equalizer
  document.getElementById('eqEnabled').checked = prefs.eqEnabled;
  renderEqBands(prefs);
}
window.loadSoundSection = loadSoundSection;

// ── GRAPHICAL EQ ─────────────────────────────────────────────────────────────
// A parametric-EQ-style canvas: log frequency axis, the combined frequency-
// response curve of the five biquad bands (same math as the Web Audio filters
// in /voice.js), and a draggable point per band. Drag a point vertically to
// change that band's gain; double-click a point to reset it. While the mic
// test is running, the live input spectrum is drawn behind the curve.
var eqUi = null; // { canvas, ctx, freqs, gains, drag, raf, dirty }

var EQ_MIN_DB = -12; var EQ_MAX_DB = 12;
var EQ_FMIN = 40; var EQ_FMAX = 18000;
var EQ_SAMPLE_RATE = 48000;

function eqXForFreq(f, w) {
  return ((Math.log(f / EQ_FMIN)) / Math.log(EQ_FMAX / EQ_FMIN)) * w;
}
function eqYForDb(db, h) {
  const pad = 14;
  return pad + (1 - (db - EQ_MIN_DB) / (EQ_MAX_DB - EQ_MIN_DB)) * (h - pad * 2);
}
function eqDbForY(y, h) {
  const pad = 14;
  const t = 1 - (y - pad) / (h - pad * 2);
  return EQ_MIN_DB + t * (EQ_MAX_DB - EQ_MIN_DB);
}

// Magnitude (in dB) of one band's biquad at frequency f — RBJ cookbook
// coefficients, the same formulas the Web Audio BiquadFilterNode uses, so the
// drawn curve is exactly what the mic actually gets. Types match voice.js:
// band 0 lowshelf, 1..3 peaking (Q=1, the Web Audio default), 4 highshelf.
function eqBandDbAt(f, f0, gainDb, type) {
  if (!gainDb) return 0;
  const A = Math.pow(10, gainDb / 40);
  const w0 = 2 * Math.PI * (f0 / EQ_SAMPLE_RATE);
  const cw = Math.cos(w0); const sw = Math.sin(w0);
  let b0; let b1; let b2; let a0; let a1; let a2;
  if (type === 'peaking') {
    const alpha = sw / 2; // Q = 1
    b0 = 1 + alpha * A; b1 = -2 * cw; b2 = 1 - alpha * A;
    a0 = 1 + alpha / A; a1 = -2 * cw; a2 = 1 - alpha / A;
  } else {
    const alpha = (sw / 2) * Math.sqrt((A + 1 / A) * (1 / 1 - 1) + 2); // S = 1
    const two = 2 * Math.sqrt(A) * alpha;
    if (type === 'lowshelf') {
      b0 = A * ((A + 1) - (A - 1) * cw + two);
      b1 = 2 * A * ((A - 1) - (A + 1) * cw);
      b2 = A * ((A + 1) - (A - 1) * cw - two);
      a0 = (A + 1) + (A - 1) * cw + two;
      a1 = -2 * ((A - 1) + (A + 1) * cw);
      a2 = (A + 1) + (A - 1) * cw - two;
    } else {
      b0 = A * ((A + 1) + (A - 1) * cw + two);
      b1 = -2 * A * ((A - 1) + (A + 1) * cw);
      b2 = A * ((A + 1) + (A - 1) * cw - two);
      a0 = (A + 1) - (A - 1) * cw + two;
      a1 = 2 * ((A - 1) - (A + 1) * cw);
      a2 = (A + 1) - (A - 1) * cw - two;
    }
  }
  const w = 2 * Math.PI * (f / EQ_SAMPLE_RATE);
  const c1 = Math.cos(w); const s1 = Math.sin(w); const c2 = Math.cos(2 * w); const s2 = Math.sin(2 * w);
  const num = Math.pow(b0 + b1 * c1 + b2 * c2, 2) + Math.pow(b1 * s1 + b2 * s2, 2);
  const den = Math.pow(a0 + a1 * c1 + a2 * c2, 2) + Math.pow(a1 * s1 + a2 * s2, 2);
  return 10 * Math.log10(num / den);
}

function eqBandType(i, count) {
  if (i === 0) return 'lowshelf';
  if (i === count - 1) return 'highshelf';
  return 'peaking';
}

function eqTotalDbAt(f) {
  let total = 0;
  for (let i = 0; i < eqUi.freqs.length; i++) {
    total += eqBandDbAt(f, eqUi.freqs[i], eqUi.gains[i], eqBandType(i, eqUi.freqs.length));
  }
  return total;
}

function eqCssVar(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

function drawEq() {
  const { canvas, ctx } = eqUi;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth; const h = canvas.clientHeight;
  if (!w || !h) return;
  if (canvas.width !== Math.round(w * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const muted = eqCssVar('--muted', '#4a5568');
  const accent = eqCssVar('--accent', '#c8ff00');
  const accentText = eqCssVar('--accent-text', '#c8ff00');
  const border = eqCssVar('--border', '#1c2030');
  const enabled = Boolean((document.getElementById('eqEnabled') || {}).checked);

  // Live mic spectrum behind everything (only while the mic test runs).
  if (soundTestState && soundTestState.analyser) {
    const an = soundTestState.analyser;
    const bins = new Uint8Array(an.frequencyBinCount);
    an.getByteFrequencyData(bins);
    const nyquist = (soundTestState.ctx && soundTestState.ctx.sampleRate || EQ_SAMPLE_RATE) / 2;
    ctx.beginPath();
    ctx.moveTo(0, h);
    for (let x = 0; x <= w; x += 3) {
      const f = EQ_FMIN * Math.pow(EQ_FMAX / EQ_FMIN, x / w);
      const bin = Math.min(bins.length - 1, Math.round((f / nyquist) * bins.length));
      const v = bins[bin] / 255;
      ctx.lineTo(x, h - v * (h * 0.9));
    }
    ctx.lineTo(w, h);
    ctx.closePath();
    ctx.fillStyle = accent;
    ctx.globalAlpha = 0.12;
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  // Grid: dB lines at -12/-6/0/+6/+12, frequency ticks at decades.
  ctx.strokeStyle = border;
  ctx.fillStyle = muted;
  ctx.font = '9px Inter, sans-serif';
  ctx.lineWidth = 1;
  [-12, -6, 0, 6, 12].forEach((db) => {
    const y = eqYForDb(db, h);
    ctx.globalAlpha = db === 0 ? 0.9 : 0.45;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    ctx.globalAlpha = 0.9;
    ctx.fillText(`${db > 0 ? '+' : ''}${db}`, 3, y - 3);
  });
  [100, 1000, 10000].forEach((f) => {
    const x = eqXForFreq(f, w);
    ctx.globalAlpha = 0.35;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
    ctx.globalAlpha = 0.9;
    ctx.fillText(f >= 1000 ? `${f / 1000}к` : String(f), x + 3, h - 4);
  });
  ctx.globalAlpha = 1;

  // The combined response curve.
  ctx.beginPath();
  for (let x = 0; x <= w; x += 2) {
    const f = EQ_FMIN * Math.pow(EQ_FMAX / EQ_FMIN, x / w);
    const y = eqYForDb(Math.max(EQ_MIN_DB - 2, Math.min(EQ_MAX_DB + 2, eqTotalDbAt(f))), h);
    if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.strokeStyle = accent;
  ctx.lineWidth = 2;
  ctx.globalAlpha = enabled ? 1 : 0.35;
  ctx.stroke();

  // Soft fill under the curve down to the 0 dB line.
  ctx.lineTo(w, eqYForDb(0, h));
  ctx.lineTo(0, eqYForDb(0, h));
  ctx.closePath();
  ctx.fillStyle = accent;
  ctx.globalAlpha = enabled ? 0.08 : 0.03;
  ctx.fill();
  ctx.globalAlpha = 1;

  // Band handles.
  const labelFor = (f) => (f >= 1000 ? `${f / 1000}к` : `${f}`);
  eqUi.freqs.forEach((f, i) => {
    const x = eqXForFreq(f, w);
    const y = eqYForDb(eqUi.gains[i], h);
    const active = eqUi.drag === i;
    ctx.beginPath();
    ctx.arc(x, y, active ? 8 : 6, 0, Math.PI * 2);
    ctx.fillStyle = eqCssVar('--surface', '#0f1117');
    ctx.fill();
    ctx.strokeStyle = accent;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = accentText;
    ctx.font = '700 10px Inter, sans-serif';
    const g = eqUi.gains[i];
    ctx.fillText(`${g > 0 ? '+' : ''}${g}`, x - 8, y - 12);
    ctx.fillStyle = muted;
    ctx.font = '9px Inter, sans-serif';
    ctx.fillText(`${labelFor(f)}Гц`, x - 10, h - 4 - (eqXForFreq(100, w) - 20 < x && x < eqXForFreq(100, w) + 20 ? 10 : 0));
  });

  eqUi.dirty = false;
}

function eqLoop() {
  if (!eqUi || !eqUi.canvas.isConnected) { eqUi = null; return; }
  if (eqUi.dirty || soundTestState || eqUi.drag !== null) drawEq();
  eqUi.raf = requestAnimationFrame(eqLoop);
}

function eqPointAt(ev) {
  const rect = eqUi.canvas.getBoundingClientRect();
  const x = ev.clientX - rect.left; const y = ev.clientY - rect.top;
  let best = -1; let bestDist = 24;
  eqUi.freqs.forEach((f, i) => {
    const px = eqXForFreq(f, rect.width);
    const py = eqYForDb(eqUi.gains[i], rect.height);
    const d = Math.hypot(px - x, py - y);
    if (d < bestDist) { best = i; bestDist = d; }
  });
  return best;
}

function eqSetGain(i, db) {
  const v = Math.max(EQ_MIN_DB, Math.min(EQ_MAX_DB, Math.round(db)));
  if (eqUi.gains[i] === v) return;
  eqUi.gains[i] = v;
  eqUi.dirty = true;
  if (window.setEqBandGain) window.setEqBandGain(i, v);
}

function renderEqBands(prefs) {
  const wrap = document.getElementById('eqBands');
  if (!wrap) return;
  const freqs = (window.getEqBands && window.getEqBands()) || [80, 240, 1000, 4000, 12000];
  const gains = freqs.map((_, i) => (prefs.eqGains && prefs.eqGains[i]) || 0);
  wrap.innerHTML = `<canvas class="eq-canvas" id="eqCanvas"></canvas>
    <div class="eq-canvas-hint"><span data-i18n="settings_eq_canvas_hint">Тяни точки мышкой • двойной клик — сброс полосы</span></div>`;
  const canvas = document.getElementById('eqCanvas');
  if (eqUi && eqUi.raf) cancelAnimationFrame(eqUi.raf);
  eqUi = { canvas, ctx: canvas.getContext('2d'), freqs, gains, drag: null, raf: 0, dirty: true };

  canvas.addEventListener('pointerdown', (ev) => {
    const i = eqPointAt(ev);
    if (i < 0) return;
    eqUi.drag = i;
    canvas.setPointerCapture(ev.pointerId);
    eqUi.dirty = true;
  });
  canvas.addEventListener('pointermove', (ev) => {
    if (eqUi.drag === null) {
      canvas.style.cursor = eqPointAt(ev) >= 0 ? 'grab' : 'default';
      return;
    }
    ev.preventDefault();
    const rect = canvas.getBoundingClientRect();
    eqSetGain(eqUi.drag, eqDbForY(ev.clientY - rect.top, rect.height));
  });
  const endDrag = () => { if (eqUi) { eqUi.drag = null; eqUi.dirty = true; } };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('dblclick', (ev) => {
    const i = eqPointAt(ev);
    if (i >= 0) eqSetGain(i, 0);
  });

  eqLoop();
}

function onOutVolInput(v) {
  document.getElementById('soundOutVolLabel').textContent = `${v}%`;
  if (window.setMasterOutputVolume) window.setMasterOutputVolume(v);
}
window.onOutVolInput = onOutVolInput;

function onMicGainInput(v) {
  document.getElementById('soundMicGainLabel').textContent = `${v}%`;
  if (window.setMicGain) window.setMicGain(Number(v) / 100);
}
window.onMicGainInput = onMicGainInput;

function onVoiceModeChange(mode) {
  const ptt = mode === 'ptt';
  document.getElementById('pttKeyRow').style.display = ptt ? 'block' : 'none';
  if (window.setPttMode) window.setPttMode(ptt);
  if (ptt && !pttKey) showToast(T('settings_ptt_pick_key', 'Выбери клавишу для push-to-talk'));
}
window.onVoiceModeChange = onVoiceModeChange;

function onEqToggle(el) {
  if (window.setEqEnabled) window.setEqEnabled(el.checked);
  if (eqUi) eqUi.dirty = true; // the curve dims when the EQ is off
}
window.onEqToggle = onEqToggle;

function resetEqualizer() {
  const bands = (window.getEqBands && window.getEqBands()) || [0, 0, 0, 0, 0];
  bands.forEach((_, i) => {
    if (window.setEqBandGain) window.setEqBandGain(i, 0);
    if (eqUi) eqUi.gains[i] = 0;
  });
  if (eqUi) eqUi.dirty = true;
}
window.resetEqualizer = resetEqualizer;

// ── PUSH-TO-TALK KEY BINDING ─────────────────────────────────────────────────
function startPttKeyCapture() {
  pttCapturing = true;
  const btn = document.getElementById('pttKeyBtn');
  if (btn) btn.textContent = T('settings_ptt_press', 'Нажми любую клавишу…');
}
window.startPttKeyCapture = startPttKeyCapture;

// One global keydown listener does double duty: capturing a new PTT binding,
// and — while a call is running in PTT mode — opening the mic on key-down.
document.addEventListener('keydown', (e) => {
  if (pttCapturing) {
    e.preventDefault();
    pttKey = e.code;
    try { localStorage.setItem('chalk_ptt_key', pttKey); } catch (_) {}
    pttCapturing = false;
    const btn = document.getElementById('pttKeyBtn');
    if (btn) btn.textContent = pttKeyLabel(pttKey);
    showToast(`${T('settings_ptt_bound', 'Клавиша назначена')}: ${pttKeyLabel(pttKey)}`);
    return;
  }
  // Don't hijack typing in inputs.
  const tag = (e.target && e.target.tagName) || '';
  if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target && e.target.isContentEditable)) return;
  const prefs = window.getSoundPrefs && window.getSoundPrefs();
  if (prefs && prefs.pttMode && pttKey && e.code === pttKey) {
    if (window.setPttHeld) window.setPttHeld(true);
  }
});
document.addEventListener('keyup', (e) => {
  const prefs = window.getSoundPrefs && window.getSoundPrefs();
  if (prefs && prefs.pttMode && pttKey && e.code === pttKey) {
    if (window.setPttHeld) window.setPttHeld(false);
  }
});

// ── LOCAL MIC TEST (level meter) ─────────────────────────────────────────────
async function soundTestMic() {
  if (soundTestState) { stopSoundTest(); return; }
  const btn = event && event.currentTarget;
  try {
    const micSel = document.getElementById('soundMicSelect');
    const deviceId = micSel && micSel.value;
    const constraints = { audio: deviceId ? { deviceId: { exact: deviceId } } : true };
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = new AC();
    const src = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    src.connect(analyser);
    const buf = new Uint8Array(analyser.frequencyBinCount);
    const meter = document.getElementById('soundMicMeter');
    const tick = () => {
      analyser.getByteTimeDomainData(buf);
      let peak = 0;
      for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i] - 128));
      const level = Math.min(100, Math.round((peak / 128) * 140));
      if (meter) meter.style.width = `${level}%`;
      soundTestState.raf = requestAnimationFrame(tick);
    };
    soundTestState = { stream, ctx, analyser, raf: 0 };
    if (btn) btn.textContent = `⏹ ${T('settings_stop_test', 'Остановить проверку')}`;
    tick();
  } catch (e) {
    showToast(`${T('err_generic', 'Ошибка')} ${e.message}`);
  }
}
window.soundTestMic = soundTestMic;

function stopSoundTest() {
  if (!soundTestState) return;
  cancelAnimationFrame(soundTestState.raf);
  try { soundTestState.stream.getTracks().forEach((t) => t.stop()); } catch (_) {}
  try { soundTestState.ctx.close(); } catch (_) {}
  soundTestState = null;
  const meter = document.getElementById('soundMicMeter');
  if (meter) meter.style.width = '0%';
  const btns = document.querySelectorAll('#settings-sound .edit-profile-btn');
  btns.forEach((b) => { if (b.textContent.indexOf('Останов') !== -1 || b.textContent.indexOf('⏹') !== -1) b.innerHTML = `🎧 <span data-i18n="settings_test_mic">Проверить микрофон</span>`; });
}
window.stopSoundTest = stopSoundTest;

// Leaving the Звук section stops the test so the mic light goes off.
document.addEventListener('click', (e) => {
  if (soundTestState) {
    const inSound = e.target.closest && e.target.closest('#settings-sound');
    const navBtn = e.target.closest && e.target.closest('.settings-nav-item, .nav-tab');
    if (!inSound && navBtn) stopSoundTest();
  }
});
