const FALLBACK_APP_ID = "78a6c18e54f34fe5a13aa04b4a2d89f3";

let client = null;
let microphoneTrack = null;

let voiceState = {
  joined: false,
  channel: null,
  muted: false,
  appId: FALLBACK_APP_ID
};

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
          user.audioTrack.play();
        }
      } catch (err) {
        console.error("[voice] subscribe error", err);
      }
    });
  }

  return client;
}

/* ---------------- TOKEN ---------------- */

async function requestVoiceToken(channelName, uid) {
  const response = await fetch(
    `/api/agora/token?channel=${encodeURIComponent(channelName)}&uid=${encodeURIComponent(uid || 0)}`
  );

  if (!response.ok) {
    throw new Error("Voice token request failed");
  }

  return response.json();
}

/* ---------------- JOIN ---------------- */

window.joinVoice = async function (channelName = "chalk-default", uid = null) {
  const channel = String(channelName || "chalk-default");
  const userId = uid ?? Math.floor(Math.random() * 1000000);

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
    const appId = data.appId || FALLBACK_APP_ID;

    await c.join(appId, channel, data.token || null, userId);

    voiceState = {
      joined: true,
      channel,
      muted: false,
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
          message: "Не удалось подключиться к голосовому чату"
        }
      })
    );

    throw error;
  }
};

/* ---------------- MIC CONTROL ---------------- */

window.enableMicrophone = async function () {
  if (!client) throw new Error("Not connected to voice");

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
  if (!microphoneTrack) return;

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

  voiceState = {
    joined: false,
    channel: null,
    muted: false,
    appId: FALLBACK_APP_ID
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