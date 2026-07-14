// ── VOICE EFFECTS — pure Web Audio DSP, no Agora coupling ────────────────────
// Turns a mic MediaStream into a processed MediaStream that voice.js publishes
// to the call as a custom Agora track (see setVoiceEffect there).
//
// Effects:
//   robot   — ring modulation (voice × 35 Hz sine) + band-limiting: the
//             classic "Dalek" metallic voice.
//   monster — pitch shifted DOWN (~-6 semitones) + low-pass: deep growl.
//   girl    — pitch shifted UP (~+5 semitones) + high-pass: higher voice.
//
// The pitch shifter is the classic dual-delay-line trick: a delay whose
// delayTime ramps at rate d' plays back at pitch ratio (1 − d'). One ramping
// line alone clicks when its ramp resets, so two lines run half a period
// apart and equal-power crossfade — each is audible only mid-ramp.
(function () {
  const PERIOD = 0.2;   // s — full modulation cycle per delay line
  const FADE = 0.03;    // s — crossfade width
  const ACTIVE = PERIOD / 2 + FADE; // audible window per line

  function makeCurves(ctx, ratio) {
    const sr = ctx.sampleRate;
    const len = Math.round(PERIOD * sr);
    const delayBuf = ctx.createBuffer(1, len, sr);
    const fadeBuf = ctx.createBuffer(1, len, sr);
    const d = delayBuf.getChannelData(0);
    const f = fadeBuf.getChannelData(0);
    // Delay sweeps by (1 − ratio)·ACTIVE over the active window: ramps up for
    // a downshift, down for an upshift (delay can't go negative, so the
    // upshift starts high and falls to ~0).
    const sweep = (1 - ratio) * ACTIVE;
    const start = sweep >= 0 ? 0 : -sweep;
    const end = sweep >= 0 ? sweep : 0;
    for (let i = 0; i < len; i++) {
      const t = i / sr;
      if (t < ACTIVE) {
        const ph = t / ACTIVE;
        d[i] = start + (end - start) * ph;
        if (t < FADE) f[i] = Math.sin((Math.PI / 2) * (t / FADE));
        else if (t > ACTIVE - FADE) f[i] = Math.cos((Math.PI / 2) * ((t - (ACTIVE - FADE)) / FADE));
        else f[i] = 1;
      } else {
        d[i] = end;
        f[i] = 0;
      }
    }
    return { delayBuf, fadeBuf };
  }

  // input → [delayA×fadeA + delayB×fadeB] → output, modulators offset P/2.
  function buildPitchShift(ctx, input, output, ratio) {
    const { delayBuf, fadeBuf } = makeCurves(ctx, ratio);
    const nodes = [];
    const now = ctx.currentTime + 0.02;
    for (const offset of [0, PERIOD / 2]) {
      const delay = ctx.createDelay(1);
      delay.delayTime.value = 0;
      const fade = ctx.createGain();
      fade.gain.value = 0;

      const dMod = ctx.createBufferSource();
      dMod.buffer = delayBuf; dMod.loop = true;
      dMod.connect(delay.delayTime);
      const fMod = ctx.createBufferSource();
      fMod.buffer = fadeBuf; fMod.loop = true;
      fMod.connect(fade.gain);
      dMod.start(now, offset);
      fMod.start(now, offset);

      input.connect(delay);
      delay.connect(fade);
      fade.connect(output);
      nodes.push(delay, fade, dMod, fMod);
    }
    return nodes;
  }

  function buildRobot(ctx, input, output) {
    // True ring mod: carrier straight into the gain param (base 0) → voice × sin.
    const ring = ctx.createGain();
    ring.gain.value = 0;
    const carrier = ctx.createOscillator();
    carrier.type = 'sine';
    carrier.frequency.value = 35;
    carrier.connect(ring.gain);
    carrier.start();
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 2600;
    input.connect(ring);
    ring.connect(lp);
    lp.connect(output);
    return [ring, carrier, lp];
  }

  function buildMonster(ctx, input, output) {
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 3800;
    const boost = ctx.createGain();
    boost.gain.value = 1.25;
    const nodes = buildPitchShift(ctx, input, lp, 0.68);
    lp.connect(boost);
    boost.connect(output);
    return nodes.concat([lp, boost]);
  }

  function buildGirl(ctx, input, output) {
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 220;
    const nodes = buildPitchShift(ctx, input, hp, 1.35);
    hp.connect(output);
    return nodes.concat([hp]);
  }

  const BUILDERS = { robot: buildRobot, monster: buildMonster, girl: buildGirl };

  /**
   * createProcessor(input) — input is the mic MediaStream, or null for tests
   * (connect any same-context source to .inputNode instead). Returns
   * { ctx, inputNode, outputNode, outputStream, setEffect, dispose }.
   * setEffect('none'|'robot'|'monster'|'girl') rewires live — the output
   * MediaStream stays the same, so the published track never changes.
   */
  function createProcessor(input) {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const inGain = ctx.createGain();
    const outGain = ctx.createGain();
    const dest = ctx.createMediaStreamDestination();
    if (input instanceof MediaStream) ctx.createMediaStreamSource(input).connect(inGain);
    outGain.connect(dest);

    let chain = [];
    let current = 'none';

    function clearChain() {
      try { inGain.disconnect(); } catch (_) {}
      for (const n of chain) {
        try { if (typeof n.stop === 'function') n.stop(); } catch (_) {}
        try { n.disconnect(); } catch (_) {}
      }
      chain = [];
    }

    function setEffect(name) {
      clearChain();
      const build = BUILDERS[name];
      if (build) chain = build(ctx, inGain, outGain);
      else inGain.connect(outGain); // 'none' → dry passthrough
      current = build ? name : 'none';
    }

    setEffect('none');
    if (ctx.state === 'suspended') { try { ctx.resume(); } catch (_) {} }

    return {
      ctx,
      inputNode: inGain,
      outputNode: outGain,
      outputStream: dest.stream,
      get currentEffect() { return current; },
      setEffect,
      dispose() {
        clearChain();
        try { ctx.close(); } catch (_) {}
      },
    };
  }

  window.VoiceFx = { createProcessor };
})();
