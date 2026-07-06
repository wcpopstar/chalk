let client = null;
let microphoneTrack = null;
const remoteAudioTracks = new Map();

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

        if (mediaType === "audio" && user.audioTrack) {
          const uidKey = String(user.uid);
          remoteAudioTracks.set(uidKey, user.audioTrack);
          setRemoteTrackAudioState(user.audioTrack, getEffectiveVolume(uidKey));
        }
      } catch (err) {
        console.error("[voice] subscribe error", err);
      }
    });

    client.on("user-unpublished", async (user) => {
      if (user && user.uid) remoteAudioTracks.delete(String(user.uid));
    });

    client.on("user-left", async (user) => {
      if (user && user.uid) remoteAudioTracks.delete(String(user.uid));
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
    const appId = data.appId;
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

  if (microphoneTrack) {
    await microphoneTrack.setEnabled(true);
    voiceState.muted = false;
    window.dispatchEvent(
      new CustomEvent("voice:status", {
        detail: { type: "info", message: "Микрофон включён" }
      })
    );
    return;
  }

  microphoneTrack = await AgoraRTC.createMicrophoneAudioTrack();
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
  await microphoneTrack.setEnabled(!voiceState.muted);

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

/* ---------------- LEAVE ---------------- */

window.leaveVoice = async function () {
  if (!voiceState.joined || !client) return;

  try {
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