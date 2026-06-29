const FALLBACK_APP_ID = "78a6c18e54f34fe5a13aa04b4a2d89f3";

let client = null;
let microphoneTrack = null;
let voiceState = { joined: false, channel: null, muted: false, appId: FALLBACK_APP_ID };

function ensureVoiceClient() {
  if (!client) {
    client = AgoraRTC.createClient({ mode: "rtc", codec: "opus" });
    client.on("user-published", async (user, mediaType) => {
      if (!client) return;
      await client.subscribe(user, mediaType);
      if (mediaType === "audio" && user.audioTrack) {
        user.audioTrack.play();
      }
    });
  }
  return client;
}

async function requestVoiceToken(channelName, uid) {
  const response = await fetch(`/api/agora/token?channel=${encodeURIComponent(channelName)}&uid=${encodeURIComponent(uid || 0)}`);
  if (!response.ok) {
    throw new Error("Voice token request failed");
  }
  return response.json();
}

window.joinVoice = async function (channelName = "chalk-default", uid = null) {
  const channel = String(channelName || "chalk-default");
  const userId = uid ? parseInt(uid) : parseInt(String(Date.now()).slice(-6));
  ensureVoiceClient();

  if (voiceState.joined && voiceState.channel === channel) {
    window.dispatchEvent(new CustomEvent("voice:status", { detail: { type: "info", message: "Вы уже в голосовом канале" } }));
    return { ok: true, channel, appId: voiceState.appId };
  }

  try {
    const data = await requestVoiceToken(channel, userId);
    const appId = data.appId || FALLBACK_APP_ID;

    await client.join(appId, channel, data.token || null, userId);
    microphoneTrack = await AgoraRTC.createMicrophoneAudioTrack();
    await client.publish(microphoneTrack);

    voiceState = { joined: true, channel, muted: false, appId };
    window.dispatchEvent(new CustomEvent("voice:status", {
      detail: { type: "success", message: `Подключились к голосовому чату: ${channel}` }
    }));

    return { ok: true, channel, appId };
  } catch (error) {
    console.error("[voice] join failed", error);
    window.dispatchEvent(new CustomEvent("voice:status", {
      detail: { type: "error", message: "Не удалось подключить голосовой чат" }
    }));
    throw error;
  }
};

window.leaveVoice = async function () {
  if (!voiceState.joined || !client) return;

  try {
    await client.leave();
  } catch (_) {}

  if (microphoneTrack) {
    microphoneTrack.stop();
    microphoneTrack.close();
    microphoneTrack = null;
  }

  voiceState = { joined: false, channel: null, muted: false, appId: FALLBACK_APP_ID };
  window.dispatchEvent(new CustomEvent("voice:status", { detail: { type: "info", message: "Голосовой чат отключён" } }));
};

window.toggleVoiceMute = async function () {
  if (!microphoneTrack) return;
  voiceState.muted = !voiceState.muted;
  microphoneTrack.setEnabled(!voiceState.muted);
  window.dispatchEvent(new CustomEvent("voice:status", {
    detail: { type: "info", message: voiceState.muted ? "Микрофон выключен" : "Микрофон включён" }
  }));
};