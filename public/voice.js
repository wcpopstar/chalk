let client = null;
let microphoneTrack = null;
const remoteAudioTracks = new Map();
// Remote uids we've seen go muted (audio unpublished), so we can chime on
// their *un*mute without also chiming on their initial join publish.
const mutedRemotes = new Set();

// Per-user volume overrides, keyed by the numeric Agora uid (string).
// Values are 0-200, where 100 is the normal/default volume.
const userVolumes = new Map();

let voiceState = {
  joined: false,
  channel: null,
  muted: false,
  deafened: false,
  appId: null
};

// Selected input/output devices + mic DSP toggles (echo / noise / gain).
// AEC = acoustic echo cancellation, ANS = automatic noise suppression,
// AGC = automatic gain control. All on by default for a clean voice call.
let selectedMicId = null;
let selectedSpeakerId = null;
const micProcessing = { AEC: true, ANS: true, AGC: true };
// "high_quality" = 48 kHz mono ~128 kbps — noticeably clearer than the SDK's
// default "music_standard" (~40 kbps) at a modest bandwidth cost.
const micEncoderConfig = "high_quality";
// Soundpad: currently-published sound-effect tracks, kept so we can stop them.
const soundpadTracks = new Set();

// Video: local camera / screen-share tracks and remote participants' video,
// keyed by numeric Agora uid (string). Camera and screen are mutually
// exclusive on the outgoing side (one local video track at a time) to avoid
// the multi-video-track complexity of publishing two at once.
let cameraTrack = null;
let screenTrack = null;
let screenAudioTrack = null;   // optional audio when sharing a tab/screen with sound
const remoteVideoTracks = new Map();

// Voice effects (robot / monster / girl): a Web Audio processor (js/voice-effects.js)
// sits between a raw getUserMedia stream and a custom Agora track that replaces
// the plain microphone track while an effect is active.
let voiceFx = null;        // VoiceFx processor instance
let voiceFxTrack = null;   // published custom Agora track carrying the processed audio
let voiceFxStream = null;  // raw mic stream feeding the processor
let voiceFxName = "none";

// Build the option bag for createMicrophoneAudioTrack from the current DSP
// toggles + selected input device. AEC/ANS/AGC are baked in at track creation,
// so changing them requires recreating the track (see setMicProcessing).
function buildMicConfig() {
  const cfg = {
    AEC: micProcessing.AEC,
    ANS: micProcessing.ANS,
    AGC: micProcessing.AGC,
    encoderConfig: micEncoderConfig
  };
  if (selectedMicId) cfg.microphoneId = selectedMicId;
  return cfg;
}

// Route a remote audio track to the chosen speaker (Chrome/Edge only; other
// browsers silently ignore setPlaybackDevice, which is fine).
function applySpeakerToTrack(track) {
  if (!track || !selectedSpeakerId || typeof track.setPlaybackDevice !== "function") return;
  try {
    const r = track.setPlaybackDevice(selectedSpeakerId);
    if (r && typeof r.catch === "function") r.catch(() => {});
  } catch (_) {}
}

/**
 * Agora numeric UIDs must be 32-bit unsigned integers. Our app uses
 * Supabase UUID strings as user ids, so we deterministically hash any
 * non-numeric uid into a stable positive integer. The server (src/routes/agora.js)
 * uses the EXACT same algorithm so the uid embedded in the token always
 * matches the uid used to join the channel.
 */
function toNumericUid(rawUid) {
  if (rawUid === null || rawUid === undefined || rawUid === "") {
    return Math.floor(Math.random() * 1000000) + 1;
  }

  if (typeof rawUid === "number" && Number.isFinite(rawUid)) {
    return Math.abs(Math.floor(rawUid)) % 2147483647 || 1;
  }

  const str = String(rawUid);

  // Pure numeric string -> use directly
  if (/^\d+$/.test(str)) {
    const n = parseInt(str, 10) % 2147483647;
    return n || 1;
  }

  // Deterministic djb2 hash for non-numeric ids (e.g. UUIDs)
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) >>> 0;
  }
  return (hash % 2147483647) || 1;
}

function getStoredVolume(uidKey) {
  return userVolumes.has(uidKey) ? userVolumes.get(uidKey) : 100;
}

function getEffectiveVolume(uidKey) {
  if (voiceState.deafened) return 0;
  return getStoredVolume(uidKey);
}

function setRemoteTrackAudioState(track, volume) {
  if (!track) return;
  const enabled = volume > 0;

  if (typeof track.setEnabled === "function") {
    try {
      const r = track.setEnabled(enabled);
      if (r && typeof r.catch === "function") r.catch(() => {});
    } catch (_) {}
  }

  if (typeof track.setVolume === "function") {
    try {
      const r = track.setVolume(enabled ? volume : 0);
      if (r && typeof r.catch === "function") r.catch(() => {});
    } catch (_) {}
  }

  if (enabled && typeof track.play === "function") {
    try {
      const r = track.play();
      if (r && typeof r.catch === "function") r.catch(() => {});
    } catch (_) {}
  }
}

function applyRemoteAudioState() {
  remoteAudioTracks.forEach((track, uidKey) => {
    setRemoteTrackAudioState(track, getEffectiveVolume(uidKey));
  });
}

function ensureVoiceClient() {
  if (!client) {
    client = AgoraRTC.createClient({
      mode: "rtc",
      codec: "vp8"
    });

    client.on("user-published", async (user, mediaType) => {
      try {
        await client.subscribe(user, mediaType);
        const uidKey = String(user.uid);

        if (mediaType === "audio" && user.audioTrack) {
          remoteAudioTracks.set(uidKey, user.audioTrack);
          applySpeakerToTrack(user.audioTrack);
          setRemoteTrackAudioState(user.audioTrack, getEffectiveVolume(uidKey));
          // Re-publishing audio after a mute = they unmuted. Skip the chime on
          // their very first publish (join), only play it if they were muted.
          if (mutedRemotes.has(uidKey)) {
            mutedRemotes.delete(uidKey);
            if (window.chalkSounds) window.chalkSounds.partnerUnmute();
          }
        }

        if (mediaType === "video" && user.videoTrack) {
          remoteVideoTracks.set(uidKey, user.videoTrack);
          // Tell the UI a remote video appeared so it can create a tile and
          // ask us to play the track into it (see playRemoteVideo).
          window.dispatchEvent(new CustomEvent("voice:video", {
            detail: { action: "add", uid: uidKey, kind: "remote" }
          }));
        }
      } catch (err) {
        console.error("[voice] subscribe error", err);
      }
    });

    client.on("user-unpublished", (user, mediaType) => {
      if (!user || !user.uid) return;
      const uidKey = String(user.uid);

      if (mediaType === "audio" || mediaType === undefined) {
        remoteAudioTracks.delete(uidKey);
        mutedRemotes.add(uidKey);
        if (window.chalkSounds) window.chalkSounds.partnerMute();
      }

      if (mediaType === "video" || mediaType === undefined) {
        if (remoteVideoTracks.has(uidKey)) {
          remoteVideoTracks.delete(uidKey);
          window.dispatchEvent(new CustomEvent("voice:video", {
            detail: { action: "remove", uid: uidKey, kind: "remote" }
          }));
        }
      }
    });

    client.on("user-left", (user) => {
      if (!user || !user.uid) return;
      const uidKey = String(user.uid);
      remoteAudioTracks.delete(uidKey);
      mutedRemotes.delete(uidKey);
      if (remoteVideoTracks.has(uidKey)) {
        remoteVideoTracks.delete(uidKey);
        window.dispatchEvent(new CustomEvent("voice:video", {
          detail: { action: "remove", uid: uidKey, kind: "remote" }
        }));
      }
    });
  }

  return client;
}

/* ---------------- TOKEN ---------------- */

async function requestVoiceToken(channelName, uid) {
  const authToken = localStorage.getItem("chalk_token");
  const headers = {};
  if (authToken) headers["Authorization"] = `Bearer ${  authToken}`;

  const response = await fetch(
    `/api/agora/token?channel=${encodeURIComponent(channelName)}&uid=${encodeURIComponent(uid || 0)}`,
    { headers }
  );

  if (!response.ok) {
    let detail = "";
    try {
      const body = await response.json();
      detail = body && body.error ? body.error : "";
    } catch (_) {}
    throw new Error(`Voice token request failed${  detail ? `: ${detail}` : ""}`);
  }

  return response.json();
}

/* ---------------- JOIN ---------------- */

window.joinVoice = async function (channelName = "chalk-default", uid = null) {
  const channel = String(channelName || "chalk-default");
  const userId = toNumericUid(uid);

  const c = ensureVoiceClient();

  if (voiceState.joined && voiceState.channel === channel) {
    window.dispatchEvent(
      new CustomEvent("voice:status", {
        detail: { type: "info", message: "Вы уже в голосовом канале" }
      })
    );
    return { ok: true, channel };
  }

  try {
    const data = await requestVoiceToken(channel, userId);
    // requestVoiceToken() already throws on a non-OK response (see above),
    // and the server (src/routes/agora.ts) always includes appId in every
    // 200 response — including the no-certificate dev-fallback branch — so
    // there's nothing to fall back to here. If it's ever missing, fail
    // loudly instead of silently joining with a stale hardcoded App ID.
    if (!data.appId) {
      throw new Error("Сервер не вернул Agora App ID");
    }
    const { appId } = data;
    const joinUid = (data.uid !== undefined && data.uid !== null) ? data.uid : userId;

    await c.join(appId, channel, data.token || null, joinUid);

    voiceState = {
      joined: true,
      channel,
      muted: false,
      deafened: false,
      appId
    };

    window.dispatchEvent(
      new CustomEvent("voice:status", {
        detail: {
          type: "success",
          message: `Подключились к голосовому чату: ${channel}`
        }
      })
    );

    return { ok: true, channel, appId };
  } catch (error) {
    console.error("[voice] join failed", error);

    window.dispatchEvent(
      new CustomEvent("voice:status", {
        detail: {
          type: "error",
          message: `Не удалось подключиться к голосовому чату${ 
            error && error.message ? ` (${error.message})` : ""}`
        }
      })
    );

    throw error;
  }
};

/* ---------------- PER-USER VOLUME ---------------- */

/**
 * Set the playback volume for a single remote participant during a call.
 * @param {string|number} rawUid - the app-level user id (e.g. Supabase UUID)
 * @param {number} volume - 0 (mute) to 200 (boosted), 100 is normal
 */
window.setUserVolume = function (rawUid, volume) {
  const uidKey = String(toNumericUid(rawUid));
  let v = Number(volume);
  if (!Number.isFinite(v)) v = 100;
  v = Math.max(0, Math.min(200, Math.round(v)));

  userVolumes.set(uidKey, v);

  const track = remoteAudioTracks.get(uidKey);
  if (track) {
    setRemoteTrackAudioState(track, getEffectiveVolume(uidKey));
  }

  window.dispatchEvent(
    new CustomEvent("voice:user-volume", {
      detail: { uid: rawUid, volume: v }
    })
  );

  return v;
};

window.getUserVolume = function (rawUid) {
  const uidKey = String(toNumericUid(rawUid));
  return getStoredVolume(uidKey);
};

/* ---------------- MIC CONTROL ---------------- */

window.enableMicrophone = async function () {
  if (!voiceState.joined || !client) {
    await window.joinVoice(voiceState.channel || "chalk-default", null);
  }

  if (!voiceState.joined || !client) throw new Error("Not connected to voice");

  if (voiceFxTrack || microphoneTrack) {
    await (voiceFxTrack || microphoneTrack).setEnabled(true);
    voiceState.muted = false;
    window.dispatchEvent(
      new CustomEvent("voice:status", {
        detail: { type: "info", message: "Микрофон включён" }
      })
    );
    return;
  }

  microphoneTrack = await AgoraRTC.createMicrophoneAudioTrack(buildMicConfig());
  await client.publish(microphoneTrack);

  voiceState.muted = false;
  window.dispatchEvent(
    new CustomEvent("voice:status", {
      detail: { type: "info", message: "Микрофон включён" }
    })
  );
};

window.joinVoiceAndEnableMic = async function (channelName = "chalk-default", uid = null) {
  const result = await window.joinVoice(channelName, uid);
  await window.enableMicrophone();
  return result;
};

window.toggleVoiceMute = async function () {
  if (!voiceState.joined || !client) {
    await window.joinVoice(voiceState.channel || "chalk-default", null);
  }

  if (!microphoneTrack) {
    await window.enableMicrophone();
  }

  voiceState.muted = !voiceState.muted;
  // While a voice effect is active the processed custom track is what the
  // others hear — mute/unmute must hit that one, not the idle mic track.
  await (voiceFxTrack || microphoneTrack).setEnabled(!voiceState.muted);

  window.dispatchEvent(
    new CustomEvent("voice:status", {
      detail: {
        type: "info",
        message: voiceState.muted
          ? "Микрофон выключен"
          : "Микрофон включён"
      }
    })
  );
};

/* ---------------- VOICE EFFECTS ---------------- */

window.getVoiceEffect = function () { return voiceFxName; };

// 'none' | 'robot' | 'monster' | 'girl'. Only meaningful inside a call.
// Switching between effects rewires the Web Audio chain in place (the
// published custom track never changes); only entering/leaving 'none'
// republishes tracks.
window.setVoiceEffect = async function (name) {
  if (name === voiceFxName) return true;
  if (!voiceState.joined || !client || (!microphoneTrack && !voiceFxTrack)) {
    window.dispatchEvent(new CustomEvent("voice:status", {
      detail: { type: "warning", message: "Эффекты голоса работают только в звонке" }
    }));
    return false;
  }

  if (name === "none") {
    voiceFxName = "none";
    if (voiceFxTrack) {
      try { await client.unpublish(voiceFxTrack); } catch (_) {}
      try { voiceFxTrack.close(); } catch (_) {}
      voiceFxTrack = null;
    }
    if (voiceFx) { voiceFx.dispose(); voiceFx = null; }
    if (voiceFxStream) { voiceFxStream.getTracks().forEach((t) => t.stop()); voiceFxStream = null; }
    if (microphoneTrack) {
      try { await client.publish(microphoneTrack); } catch (_) {}
      await microphoneTrack.setEnabled(!voiceState.muted);
    }
    return true;
  }

  if (!window.VoiceFx) return false;
  if (!voiceFx) {
    const constraints = selectedMicId ? { audio: { deviceId: { exact: selectedMicId } } } : { audio: true };
    voiceFxStream = await navigator.mediaDevices.getUserMedia(constraints);
    voiceFx = window.VoiceFx.createProcessor(voiceFxStream);
    voiceFxTrack = AgoraRTC.createCustomAudioTrack({
      mediaStreamTrack: voiceFx.outputStream.getAudioTracks()[0]
    });
    if (microphoneTrack) { try { await client.unpublish(microphoneTrack); } catch (_) {} }
    await client.publish(voiceFxTrack);
    await voiceFxTrack.setEnabled(!voiceState.muted);
  }
  voiceFx.setEffect(name);
  voiceFxName = name;
  return true;
};

// Tear down the effect pipeline without touching the mic track — used by
// leaveVoice() where everything is being closed anyway.
function disposeVoiceFx() {
  if (voiceFxTrack) { try { voiceFxTrack.close(); } catch (_) {} voiceFxTrack = null; }
  if (voiceFx) { try { voiceFx.dispose(); } catch (_) {} voiceFx = null; }
  if (voiceFxStream) { voiceFxStream.getTracks().forEach((t) => t.stop()); voiceFxStream = null; }
  voiceFxName = "none";
}

window.toggleVoiceDeafen = async function () {
  if (!voiceState.joined || !client) {
    try {
      await window.joinVoice(voiceState.channel || "chalk-default", null);
    } catch (_err) {
      return;
    }
  }

  voiceState.deafened = !voiceState.deafened;
  applyRemoteAudioState();

  window.dispatchEvent(
    new CustomEvent("voice:status", {
      detail: {
        type: "info",
        message: voiceState.deafened
          ? "Слушать других отключено"
          : "Слушать других включено"
      }
    })
  );
};

/* ---------------- DEVICES (switch mic / speaker mid-call) ---------------- */

/**
 * Enumerate available audio input (microphones) and output (speakers) devices.
 * Requires mic permission for labels to be populated (already granted once a
 * call starts). Returns { microphones, speakers, currentMicId, currentSpeakerId }.
 */
// Race a promise against a timeout so a pending/blocked permission prompt can't
// hang the settings menu forever — fall back to an empty list instead.
function withTimeout(promise, ms, fallback) {
  return Promise.race([
    Promise.resolve(promise).catch(() => fallback),
    new Promise((resolve) => setTimeout(() => resolve(fallback), ms))
  ]);
}

window.listAudioDevices = async function () {
  let microphones = [];
  let speakers = [];
  try { microphones = await withTimeout(AgoraRTC.getMicrophones(), 3000, []); } catch (_) {}
  try { speakers = await withTimeout(AgoraRTC.getPlaybackDevices(), 3000, []); } catch (_) {}
  microphones = microphones || [];
  speakers = speakers || [];

  // Resolve the *effective* current mic id: if none was explicitly picked,
  // it's whatever the live track is using, else the first device.
  let currentMicId = selectedMicId;
  if (!currentMicId && microphoneTrack) {
    try {
      const s = microphoneTrack.getTrackLabel && microphoneTrack.getTrackLabel();
      const match = microphones.find((d) => d.label === s);
      if (match) currentMicId = match.deviceId;
    } catch (_) {}
  }
  if (!currentMicId && microphones[0]) currentMicId = microphones[0].deviceId;

  const currentSpeakerId = selectedSpeakerId || (speakers[0] && speakers[0].deviceId) || null;
  return { microphones, speakers, currentMicId, currentSpeakerId };
};

/** Switch the microphone input device live (no reconnect needed). */
window.setMicrophoneDevice = async function (deviceId) {
  if (!deviceId) return;
  selectedMicId = deviceId;
  if (microphoneTrack && typeof microphoneTrack.setDevice === "function") {
    try { await microphoneTrack.setDevice(deviceId); } catch (err) { console.warn("[voice] setMicrophoneDevice", err); }
  }
  window.dispatchEvent(new CustomEvent("voice:status", {
    detail: { type: "info", message: "Микрофон переключён" }
  }));
};

/** Switch the speaker/output device live for every remote participant. */
window.setSpeakerDevice = async function (deviceId) {
  if (!deviceId) return;
  selectedSpeakerId = deviceId;
  remoteAudioTracks.forEach((track) => applySpeakerToTrack(track));
  window.dispatchEvent(new CustomEvent("voice:status", {
    detail: { type: "info", message: "Устройство вывода переключено" }
  }));
};

/** Read the current echo/noise/gain toggles. */
window.getMicProcessing = function () {
  return { AEC: micProcessing.AEC, ANS: micProcessing.ANS, AGC: micProcessing.AGC };
};

/**
 * Update echo cancellation / noise suppression / gain control. These are fixed
 * at track-creation time, so the live mic track is recreated (preserving the
 * muted state) when a call is in progress.
 */
window.setMicProcessing = async function (partial) {
  if (partial && typeof partial === "object") {
    if ("AEC" in partial) micProcessing.AEC = Boolean(partial.AEC);
    if ("ANS" in partial) micProcessing.ANS = Boolean(partial.ANS);
    if ("AGC" in partial) micProcessing.AGC = Boolean(partial.AGC);
  }

  // Recreate the live track so the new DSP settings take effect.
  if (client && microphoneTrack) {
    const wasMuted = voiceState.muted;
    try {
      await client.unpublish(microphoneTrack);
      microphoneTrack.stop();
      microphoneTrack.close();
    } catch (_) {}
    microphoneTrack = await AgoraRTC.createMicrophoneAudioTrack(buildMicConfig());
    if (wasMuted) { try { await microphoneTrack.setEnabled(false); } catch (_) {} }
    await client.publish(microphoneTrack);
  }

  window.dispatchEvent(new CustomEvent("voice:status", {
    detail: { type: "info", message: "Настройки звука обновлены" }
  }));
  return window.getMicProcessing();
};

/* ---------------- SOUNDPAD (play SFX into the call) ---------------- */

/**
 * Play a sound effect so BOTH the local user and everyone in the call hears it.
 * `source` may be a URL string, a File/Blob, or an AudioBuffer. Publishes a
 * short-lived BufferSourceAudioTrack alongside the mic and auto-cleans on end.
 * Returns a stop() handle. No-op (returns null) if not in a call.
 */
window.playSound = async function (source, options) {
  if (!source) return null;
  if (!voiceState.joined || !client) {
    try { await window.joinVoiceAndEnableMic(voiceState.channel || "chalk-default", null); } catch (_) { return null; }
  }
  const loop = Boolean(options && options.loop);

  let sfxTrack;
  try {
    sfxTrack = await AgoraRTC.createBufferSourceAudioTrack({ source });
  } catch (err) {
    console.warn("[voice] soundpad createBufferSourceAudioTrack failed", err);
    return null;
  }

  const cleanup = async () => {
    if (!soundpadTracks.has(sfxTrack)) return;
    soundpadTracks.delete(sfxTrack);
    try { sfxTrack.stopProcessAudioBuffer(); } catch (_) {}
    try { await client.unpublish(sfxTrack); } catch (_) {}
    try { sfxTrack.stop(); sfxTrack.close(); } catch (_) {}
    window.dispatchEvent(new CustomEvent("voice:soundpad", { detail: { playing: soundpadTracks.size > 0 } }));
  };

  // Fires when a non-looping buffer reaches its end.
  try {
    sfxTrack.on("source-state-change", (state) => { if (state === "stopped" && !loop) cleanup(); });
  } catch (_) {}

  try {
    soundpadTracks.add(sfxTrack);
    sfxTrack.startProcessAudioBuffer({ loop });
    if (typeof sfxTrack.play === "function") sfxTrack.play();   // local monitoring
    await client.publish(sfxTrack);
    window.dispatchEvent(new CustomEvent("voice:soundpad", { detail: { playing: true } }));
  } catch (err) {
    console.warn("[voice] soundpad play failed", err);
    await cleanup();
    return null;
  }

  return { stop: cleanup };
};

/** Stop every currently-playing soundpad effect. */
window.stopAllSounds = async function () {
  const tracks = Array.from(soundpadTracks);
  soundpadTracks.clear();
  for (const t of tracks) {
    try { t.stopProcessAudioBuffer(); } catch (_) {}
    try { await client.unpublish(t); } catch (_) {}
    try { t.stop(); t.close(); } catch (_) {}
  }
  window.dispatchEvent(new CustomEvent("voice:soundpad", { detail: { playing: false } }));
};

/* ---------------- VIDEO (camera + screen share) ---------------- */

async function ensureJoinedForMedia() {
  if (!voiceState.joined || !client) {
    await window.joinVoiceAndEnableMic(voiceState.channel || "chalk-default", null);
  }
  return Boolean(voiceState.joined && client);
}

function emitVideo(action, kind) {
  window.dispatchEvent(new CustomEvent("voice:video", { detail: { action, kind, local: true } }));
}

/** Turn on the webcam and publish it to the call. Stops screen share first. */
window.enableCamera = async function () {
  if (!(await ensureJoinedForMedia())) throw new Error("Not connected to voice");
  if (screenTrack) await window.stopScreenShare();
  if (cameraTrack) return { ok: true };

  cameraTrack = await AgoraRTC.createCameraVideoTrack({ encoderConfig: "720p_1" });
  await client.publish(cameraTrack);
  emitVideo("add", "camera");
  return { ok: true };
};

/** Stop and unpublish the webcam. */
window.disableCamera = async function () {
  if (!cameraTrack) return;
  try { await client.unpublish(cameraTrack); } catch (_) {}
  try { cameraTrack.stop(); cameraTrack.close(); } catch (_) {}
  cameraTrack = null;
  emitVideo("remove", "camera");
};

window.toggleCamera = async function () {
  if (cameraTrack) { await window.disableCamera(); return { on: false }; }
  await window.enableCamera();
  return { on: true };
};

/** Start sharing the screen (video only). */
window.startScreenShare = async function () {
  if (!(await ensureJoinedForMedia())) throw new Error("Not connected to voice");
  if (cameraTrack) await window.disableCamera();
  if (screenTrack) return { ok: true };

  // Video only ("disable"). We deliberately don't capture screen audio: a
  // single Agora client/uid can't reliably publish a second audio track
  // alongside the mic without disrupting the remote's mute/volume handling.
  screenTrack = await AgoraRTC.createScreenVideoTrack(
    { encoderConfig: "1080p_1", optimizationMode: "detail" },
    "disable"
  );
  screenAudioTrack = null;

  // The browser's own "Stop sharing" bar fires "track-ended".
  try { screenTrack.on("track-ended", () => { window.stopScreenShare(); }); } catch (_) {}

  await client.publish(screenTrack);
  emitVideo("add", "screen");
  return { ok: true };
};

window.stopScreenShare = async function () {
  if (!screenTrack) return;
  const tracks = [screenTrack, screenAudioTrack].filter(Boolean);
  screenTrack = null;
  screenAudioTrack = null;
  for (const t of tracks) {
    try { await client.unpublish(t); } catch (_) {}
    try { t.stop(); t.close(); } catch (_) {}
  }
  emitVideo("remove", "screen");
};

window.toggleScreenShare = async function () {
  if (screenTrack) { await window.stopScreenShare(); return { on: false }; }
  await window.startScreenShare();
  return { on: true };
};

/** Play the local video (camera or screen) into a DOM element. */
window.playLocalVideo = function (el) {
  const track = cameraTrack || screenTrack;
  if (track && el && typeof track.play === "function") {
    try { track.play(el, { fit: "contain", mirror: Boolean(cameraTrack) }); } catch (err) { console.warn("[voice] playLocalVideo", err); }
  }
};

/** Play a remote participant's video into a DOM element. */
window.playRemoteVideo = function (uid, el) {
  const track = remoteVideoTracks.get(String(uid));
  if (track && el && typeof track.play === "function") {
    try { track.play(el, { fit: "contain" }); } catch (err) { console.warn("[voice] playRemoteVideo", err); }
  }
};

window.getVideoState = function () {
  return {
    camera: Boolean(cameraTrack),
    screen: Boolean(screenTrack),
    localActive: Boolean(cameraTrack || screenTrack),
    remotes: Array.from(remoteVideoTracks.keys())
  };
};

/* ---------------- LEAVE ---------------- */

window.leaveVoice = async function () {
  if (!voiceState.joined || !client) return;

  try {
    // Stop any soundpad effects still playing before we tear down the client.
    for (const t of Array.from(soundpadTracks)) {
      try { t.stopProcessAudioBuffer(); } catch (_) {}
      try { await client.unpublish(t); } catch (_) {}
      try { t.stop(); t.close(); } catch (_) {}
    }
    soundpadTracks.clear();

    // Tear down any local video (camera / screen) so the camera light goes off.
    for (const t of [cameraTrack, screenTrack, screenAudioTrack].filter(Boolean)) {
      try { await client.unpublish(t); } catch (_) {}
      try { t.stop(); t.close(); } catch (_) {}
    }
    cameraTrack = null;
    screenTrack = null;
    screenAudioTrack = null;

    if (voiceFxTrack) {
      try { await client.unpublish(voiceFxTrack); } catch (_) {}
    }
    disposeVoiceFx();

    if (microphoneTrack) {
      await client.unpublish(microphoneTrack);
      microphoneTrack.stop();
      microphoneTrack.close();
      microphoneTrack = null;
    }

    await client.leave();
  } catch (err) {
    console.warn("[voice] leave error", err);
  }

  remoteAudioTracks.clear();
  remoteVideoTracks.clear();
  voiceState = {
    joined: false,
    channel: null,
    muted: false,
    deafened: false,
    appId: null
  };

  window.dispatchEvent(
    new CustomEvent("voice:status", {
      detail: { type: "info", message: "Голосовой чат отключён" }
    })
  );
};

/* ---------------- DEBUG ---------------- */

Object.defineProperty(window, '__voiceState', {
  get() {
    return voiceState;
  },
  configurable: true
});