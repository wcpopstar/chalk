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

function renderEqBands(prefs) {
  const wrap = document.getElementById('eqBands');
  if (!wrap) return;
  const freqs = (window.getEqBands && window.getEqBands()) || [80, 240, 1000, 4000, 12000];
  const labelFor = (f) => (f >= 1000 ? `${f / 1000}к` : `${f}`);
  wrap.innerHTML = freqs.map((f, i) => {
    const val = (prefs.eqGains && prefs.eqGains[i]) || 0;
    return `<div class="eq-band">
      <span class="eq-band-val" id="eqVal${i}">${val > 0 ? '+' : ''}${val}</span>
      <input type="range" class="eq-slider" orient="vertical" min="-12" max="12" step="1" value="${val}" oninput="onEqBand(${i}, this.value)">
      <span class="eq-band-freq">${labelFor(f)}<br>Гц</span>
    </div>`;
  }).join('');
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
}
window.onEqToggle = onEqToggle;

function onEqBand(i, v) {
  document.getElementById(`eqVal${i}`).textContent = `${v > 0 ? '+' : ''}${v}`;
  if (window.setEqBandGain) window.setEqBandGain(i, Number(v));
}
window.onEqBand = onEqBand;

function resetEqualizer() {
  const bands = (window.getEqBands && window.getEqBands()) || [0, 0, 0, 0, 0];
  bands.forEach((_, i) => {
    if (window.setEqBandGain) window.setEqBandGain(i, 0);
    const el = document.getElementById(`eqVal${i}`);
    if (el) el.textContent = '0';
  });
  document.querySelectorAll('#eqBands .eq-slider').forEach((s) => { s.value = 0; });
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
