// ── IN-CALL AUDIO: device switching, echo/noise/gain toggles, soundpad ───────
// UI layer on top of the low-level APIs in /voice.js:
//   listAudioDevices / setMicrophoneDevice / setSpeakerDevice
//   getMicProcessing / setMicProcessing
//   playSound / stopAllSounds

/* ---------------- AUDIO SETTINGS MENU (⚙️) ---------------- */

function _caEsc(s) { return (window.escHtml ? window.escHtml(s) : String(s == null ? '' : s)); }
function _caT(key, fallback) {
  if (window.T) { const v = window.T(key); if (v && v !== key) return v; }
  return fallback;
}

async function toggleCallAudioMenu(e) {
  if (e) e.stopPropagation();
  const menu = document.getElementById('callAudioMenu');
  if (!menu) return;
  if (menu.classList.contains('show')) { closeCallAudioMenu(); return; }

  closeSoundpad();
  menu.innerHTML = `<div class="ca-loading">${_caEsc(_caT('status_loading', 'Загрузка…'))}</div>`;
  menu.classList.add('show');
  positionCallPopover(menu, e && e.currentTarget);

  let devices = { microphones: [], speakers: [], currentMicId: null, currentSpeakerId: null };
  try { if (window.listAudioDevices) devices = await window.listAudioDevices(); } catch (_) {}
  const dsp = (window.getMicProcessing && window.getMicProcessing()) || { AEC: true, ANS: true, AGC: true };

  const micOptions = devices.microphones.map((d, i) =>
    `<option value="${_caEsc(d.deviceId)}"${d.deviceId === devices.currentMicId ? ' selected' : ''}>${_caEsc(d.label || (`${_caT('call_mic', 'Микрофон')  } ${  i + 1}`))}</option>`
  ).join('');
  const spkOptions = devices.speakers.map((d, i) =>
    `<option value="${_caEsc(d.deviceId)}"${d.deviceId === devices.currentSpeakerId ? ' selected' : ''}>${_caEsc(d.label || (`${_caT('call_speaker', 'Динамик')  } ${  i + 1}`))}</option>`
  ).join('');

  const speakerBlock = devices.speakers.length
    ? `<label class="ca-label">${_caEsc(_caT('call_output_device', 'Устройство вывода'))}</label>
       <select class="ca-select" id="caSpeakerSelect" onchange="onCallSpeakerChange(this.value)">${spkOptions}</select>`
    : '';

  const toggle = (id, on, label, hint) =>
    `<label class="ca-toggle">
       <input type="checkbox" id="${id}" ${on ? 'checked' : ''} onchange="onCallDspChange()">
       <span class="ca-toggle-text"><b>${_caEsc(label)}</b><small>${_caEsc(hint)}</small></span>
     </label>`;

  const currentFx = (window.getVoiceEffect && window.getVoiceEffect()) || 'none';
  const fxChip = (value, emoji, label) =>
    `<button type="button" class="ca-fx-chip${currentFx === value ? ' active' : ''}" data-fx="${value}" onclick="onVoiceFxChange('${value}')">${emoji} ${_caEsc(label)}</button>`;
  const fxBlock =
    `<label class="ca-label">${_caEsc(_caT('voicefx_title', 'Эффект голоса'))}</label>
     <div class="ca-fx-row">
       ${fxChip('none', '🎙', _caT('voicefx_none', 'Обычный'))}
       ${fxChip('robot', '🤖', _caT('voicefx_robot', 'Робот'))}
       ${fxChip('monster', '👹', _caT('voicefx_monster', 'Монстр'))}
       ${fxChip('girl', '👧', _caT('voicefx_girl', 'Девушка'))}
     </div>`;

  menu.innerHTML =
    `<div class="ca-title">${_caEsc(_caT('call_audio_settings_title', 'Настройки звука'))}</div>
     <label class="ca-label">${_caEsc(_caT('call_input_device', 'Микрофон'))}</label>
     <select class="ca-select" id="caMicSelect" onchange="onCallMicChange(this.value)">${micOptions || `<option>${_caEsc(_caT('call_no_devices', 'Устройства не найдены'))}</option>`}</select>
     ${speakerBlock}
     ${fxBlock}
     <div class="ca-dsp">
       ${toggle('caAEC', dsp.AEC, _caT('call_aec', 'Эхоподавление'), _caT('call_aec_hint', 'Убирает эхо от динамиков'))}
       ${toggle('caANS', dsp.ANS, _caT('call_ans', 'Шумоподавление'), _caT('call_ans_hint', 'Гасит фоновый шум'))}
       ${toggle('caAGC', dsp.AGC, _caT('call_agc', 'Автогромкость'), _caT('call_agc_hint', 'Выравнивает уровень голоса'))}
     </div>`;
  positionCallPopover(menu, e && e.currentTarget);
}

function closeCallAudioMenu() {
  const menu = document.getElementById('callAudioMenu');
  if (menu) menu.classList.remove('show');
}

async function onCallMicChange(deviceId) {
  if (window.setMicrophoneDevice) { try { await window.setMicrophoneDevice(deviceId); } catch (_) {} }
}

async function onVoiceFxChange(name) {
  if (!window.setVoiceEffect) return;
  let ok = false;
  try { ok = await window.setVoiceEffect(name); } catch (e) {
    if (typeof showToast === 'function') showToast(`❌ ${e.message}`);
    return;
  }
  if (!ok) return; // not in a call — voice:status already told the user
  // Repaint the chips to reflect the new selection.
  document.querySelectorAll('#callAudioMenu .ca-fx-chip').forEach((b) => {
    b.classList.toggle('active', b.dataset.fx === name);
  });
}
async function onCallSpeakerChange(deviceId) {
  if (window.setSpeakerDevice) { try { await window.setSpeakerDevice(deviceId); } catch (_) {} }
}
async function onCallDspChange() {
  const get = (id) => { const el = document.getElementById(id); return el ? el.checked : true; };
  if (window.setMicProcessing) {
    try { await window.setMicProcessing({ AEC: get('caAEC'), ANS: get('caANS'), AGC: get('caAGC') }); } catch (_) {}
  }
}

/* ---------------- SOUNDPAD (🎵) ---------------- */

// User-added sounds live only for the current page session: { name, source }.
var soundpadCustom = [];

function toggleSoundpad(e) {
  if (e) e.stopPropagation();
  const panel = document.getElementById('soundpadPanel');
  if (!panel) return;
  if (panel.classList.contains('show')) { closeSoundpad(); return; }

  closeCallAudioMenu();
  renderSoundpad();
  panel.classList.add('show');
  positionCallPopover(panel, e && e.currentTarget);
}

function closeSoundpad() {
  const panel = document.getElementById('soundpadPanel');
  if (panel) panel.classList.remove('show');
}

function renderSoundpad() {
  const panel = document.getElementById('soundpadPanel');
  if (!panel) return;

  const presetPads = SOUNDPAD_PRESETS.map((p) =>
    `<button class="sp-pad" title="${_caEsc(p.label)}" onclick="playPresetSound('${p.id}')">
       <span class="sp-emoji">${p.emoji}</span><span class="sp-name">${_caEsc(p.label)}</span>
     </button>`).join('');

  const customPads = soundpadCustom.map((s, i) =>
    `<button class="sp-pad sp-pad-custom" title="${_caEsc(s.name)}" onclick="playCustomSound(${i})">
       <span class="sp-emoji">🔊</span><span class="sp-name">${_caEsc(s.name)}</span>
     </button>`).join('');

  panel.innerHTML =
    `<div class="sp-head">
       <span class="sp-title">${_caEsc(_caT('soundpad_title', 'Звуки'))}</span>
       <button class="sp-stop" onclick="stopSoundpad()" title="${_caEsc(_caT('soundpad_stop', 'Остановить'))}">⏹</button>
     </div>
     <div class="sp-grid">${presetPads}${customPads}</div>
     <button class="sp-add" onclick="document.getElementById('soundpadFile').click()">＋ ${_caEsc(_caT('soundpad_add', 'Добавить свой звук'))}</button>
     <input type="file" id="soundpadFile" accept="audio/*" style="display:none" onchange="soundpadFileChosen(event)">`;
}

function soundpadFileChosen(ev) {
  const file = ev.target && ev.target.files && ev.target.files[0];
  if (!file) return;
  const name = file.name.replace(/\.[^.]+$/, '').slice(0, 18);
  soundpadCustom.push({ name, source: file });
  renderSoundpad();
}

async function playPresetSound(id) {
  const preset = SOUNDPAD_PRESETS.find((p) => p.id === id);
  if (!preset || !window.playSound) return;
  try {
    const buffer = await preset.make();
    await window.playSound(buffer, { loop: false });
  } catch (err) { console.warn('[soundpad] preset failed', err); }
}

async function playCustomSound(i) {
  const s = soundpadCustom[i];
  if (!s || !window.playSound) return;
  try { await window.playSound(s.source, { loop: false }); }
  catch (err) { console.warn('[soundpad] custom failed', err); }
}

function stopSoundpad() {
  if (window.stopAllSounds) window.stopAllSounds();
}

/* ---------------- SYNTHESIZED PRESET SOUNDS ---------------- */
// Rendered to AudioBuffers on demand (and cached) so we ship no audio assets
// and reproduce nothing copyrighted. Agora's BufferSourceAudioTrack accepts an
// AudioBuffer directly.

var _spCtx = null;
function _spContext() {
  if (!_spCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    _spCtx = new AC();
  }
  if (_spCtx.state === 'suspended') { try { _spCtx.resume(); } catch (_) {} }
  return _spCtx;
}

function _spBuffer(seconds) {
  const ctx = _spContext();
  const rate = ctx.sampleRate;
  const buf = ctx.createBuffer(1, Math.floor(seconds * rate), rate);
  return { buf, data: buf.getChannelData(0), rate };
}

const _spCache = {};
function _spMemo(id, fn) { return function () { if (!_spCache[id]) _spCache[id] = fn(); return _spCache[id]; }; }

const SOUNDPAD_PRESETS = [
  {
    id: 'beep', emoji: '🔔', label: 'Бип',
    make: _spMemo('beep', () => {
      const { buf, data, rate } = _spBuffer(0.35);
      for (let i = 0; i < data.length; i++) {
        const t = i / rate;
        data[i] = Math.sin(2 * Math.PI * 880 * t) * Math.exp(-6 * t) * 0.6;
      }
      return buf;
    })
  },
  {
    id: 'airhorn', emoji: '📢', label: 'Эйрхорн',
    make: _spMemo('airhorn', () => {
      const { buf, data, rate } = _spBuffer(0.9);
      for (let i = 0; i < data.length; i++) {
        const t = i / rate;
        const vib = 1 + 0.01 * Math.sin(2 * Math.PI * 6 * t);
        // Two detuned saws for a brassy horn timbre.
        const saw = (f) => 2 * ((t * f * vib) % 1) - 1;
        const env = Math.min(1, t * 20) * Math.min(1, (0.9 - t) * 8);
        data[i] = (saw(220) * 0.5 + saw(224) * 0.5) * env * 0.5;
      }
      return buf;
    })
  },
  {
    id: 'applause', emoji: '👏', label: 'Аплодисменты',
    make: _spMemo('applause', () => {
      const { buf, data, rate } = _spBuffer(1.6);
      let env = 0;
      for (let i = 0; i < data.length; i++) {
        const t = i / rate;
        // Random claps: bursts of shaped noise, swelling then fading.
        const swell = Math.min(1, t * 4) * Math.min(1, (1.6 - t) * 2);
        if (Math.random() < 0.006) env = 1;
        env *= 0.9;
        data[i] = (Math.random() * 2 - 1) * env * swell * 0.5;
      }
      return buf;
    })
  },
  {
    id: 'drumroll', emoji: '🥁', label: 'Барабаны',
    make: _spMemo('drumroll', () => {
      const { buf, data, rate } = _spBuffer(1.1);
      let env = 0;
      for (let i = 0; i < data.length; i++) {
        const t = i / rate;
        const rateHz = 12 + t * 28;              // accelerating roll
        if ((i % Math.floor(rate / rateHz)) === 0) env = 1;
        env *= 0.85;
        const tone = Math.sin(2 * Math.PI * 90 * t);
        data[i] = (tone * 0.5 + (Math.random() * 2 - 1) * 0.5) * env * 0.6;
      }
      return buf;
    })
  },
  {
    id: 'sadtrombone', emoji: '🎺', label: 'Провал',
    make: _spMemo('sadtrombone', () => {
      const { buf, data, rate } = _spBuffer(1.4);
      const notes = [233, 220, 196, 175];        // descending "wah-wah-wah-waah"
      const seg = 0.35;
      for (let i = 0; i < data.length; i++) {
        const t = i / rate;
        const idx = Math.min(notes.length - 1, Math.floor(t / seg));
        const f = notes[idx] * (1 - 0.03 * Math.sin(2 * Math.PI * 5 * t));
        const local = t - idx * seg;
        const env = Math.min(1, local * 12) * Math.min(1, (seg - local) * 6);
        const saw = 2 * ((t * f) % 1) - 1;
        data[i] = saw * env * 0.45;
      }
      return buf;
    })
  }
];

/* ---------------- POSITIONING + OUTSIDE-CLICK CLOSE ---------------- */

function positionCallPopover(el, anchor) {
  el.style.display = 'block';
  const w = el.offsetWidth || 240;
  const h = el.offsetHeight || 200;
  let left; let top;
  if (anchor && anchor.getBoundingClientRect) {
    const r = anchor.getBoundingClientRect();
    left = r.left + r.width / 2 - w / 2;
    top = r.top - h - 10;                          // above the control bar
    if (top < 8) top = r.bottom + 10;
  } else {
    left = (window.innerWidth - w) / 2;
    top = (window.innerHeight - h) / 2;
  }
  left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
  top = Math.max(8, Math.min(top, window.innerHeight - h - 8));
  el.style.left = `${left  }px`;
  el.style.top = `${top  }px`;
}

document.addEventListener('click', (e) => {
  const menu = document.getElementById('callAudioMenu');
  const panel = document.getElementById('soundpadPanel');
  const audioBtn = document.getElementById('fcAudioBtn');
  const soundBtn = document.getElementById('fcSoundpadBtn');
  if (menu && menu.classList.contains('show') && !menu.contains(e.target) && e.target !== audioBtn && !(audioBtn && audioBtn.contains(e.target))) {
    closeCallAudioMenu();
  }
  if (panel && panel.classList.contains('show') && !panel.contains(e.target) && e.target !== soundBtn && !(soundBtn && soundBtn.contains(e.target))) {
    closeSoundpad();
  }
});
