// ── SOUND EFFECTS ────────────────────────────────────────────────────────────
// Small synthesized UI sounds (no audio files to ship or fetch — CSP-safe):
//   • new message chime
//   • incoming-call ringtone (loops until answered/rejected)
//   • self mute / unmute
//   • partner (remote) mute / unmute
//
// All tones are generated with the Web Audio API. Muted via a localStorage
// flag (default ON) so the user can silence everything with toggleAppSounds().
// The AudioContext is created lazily and resumed on the first user gesture —
// browsers block audio until then, so early sounds (e.g. a ringtone before any
// click) may be silently dropped; that's an unavoidable browser rule.

(function () {
  var ctx = null;
  var MUTE_KEY = 'chalk_sound_muted';

  function soundsEnabled() {
    try { return localStorage.getItem(MUTE_KEY) !== '1'; } catch (_) { return true; }
  }

  function ensureCtx() {
    if (!soundsEnabled()) return null;
    try {
      if (!ctx) {
        var AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        ctx = new AC();
      }
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      return ctx;
    } catch (_) { return null; }
  }

  // One shaped note. `when` is an offset in seconds from now, so a call can
  // schedule a small melody in one go.
  function note(freq, startOffset, durationSec, type, peakGain) {
    var c = ensureCtx();
    if (!c) return;
    var t0 = c.currentTime + (startOffset || 0);
    var osc = c.createOscillator();
    var gain = c.createGain();
    osc.type = type || 'sine';
    osc.frequency.setValueAtTime(freq, t0);
    var peak = peakGain == null ? 0.08 : peakGain;
    // Quick attack, exponential-ish decay via linear ramps (cheap + click-free).
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.linearRampToValueAtTime(peak, t0 + 0.012);
    gain.gain.linearRampToValueAtTime(0.0001, t0 + durationSec);
    osc.connect(gain); gain.connect(c.destination);
    osc.start(t0);
    osc.stop(t0 + durationSec + 0.02);
  }

  function playMessage() { note(660, 0, 0.12, 'sine', 0.06); note(880, 0.09, 0.14, 'sine', 0.05); }
  function playSelfMute() { note(520, 0, 0.09, 'triangle', 0.09); note(320, 0.08, 0.12, 'triangle', 0.09); }
  function playSelfUnmute() { note(320, 0, 0.09, 'triangle', 0.09); note(520, 0.08, 0.12, 'triangle', 0.09); }
  function playPartnerMute() { note(400, 0, 0.14, 'sine', 0.05); }
  function playPartnerUnmute() { note(620, 0, 0.14, 'sine', 0.05); }

  // Ringtone: a two-note "bring-bring" motif repeated on an interval until
  // stopRingtone() is called. Guarded so a second start doesn't stack timers.
  var ringTimer = null;
  function ringPulse() {
    note(880, 0, 0.18, 'sine', 0.09);
    note(1100, 0.2, 0.22, 'sine', 0.09);
  }
  function startRingtone() {
    if (!soundsEnabled()) return;
    if (ringTimer) return;
    ringPulse();
    ringTimer = setInterval(ringPulse, 1600);
  }
  function stopRingtone() {
    if (ringTimer) { clearInterval(ringTimer); ringTimer = null; }
  }

  // Public toggle (default ON). Returns the new "enabled" state.
  window.toggleAppSounds = function () {
    var nowMuted = soundsEnabled(); // if currently enabled, we're muting
    try { localStorage.setItem(MUTE_KEY, nowMuted ? '1' : '0'); } catch (_) {}
    if (nowMuted) stopRingtone();
    return !nowMuted;
  };
  window.appSoundsEnabled = soundsEnabled;

  window.chalkSounds = {
    message: playMessage,
    selfMute: playSelfMute,
    selfUnmute: playSelfUnmute,
    partnerMute: playPartnerMute,
    partnerUnmute: playPartnerUnmute,
    startRingtone,
    stopRingtone,
  };
})();
