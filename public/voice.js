import AgoraRTC from "agora-rtc-sdk-ng";

const APP_ID = "YOUR_APP_ID";

const client = AgoraRTC.createClient({ mode: "rtc", codec: "vp8" });

let audioTrack;

window.joinVoice = async function () {
  // 1. берём токен с твоего backend
  const res = await fetch("/api/agora/token?channel=test");
  const data = await res.json();

  const token = data.token;

  // 2. подключаемся к Agora
  await client.join(APP_ID, "test", token, null);

  // 3. включаем микрофон
  audioTrack = await AgoraRTC.createMicrophoneAudioTrack();

  // 4. отправляем голос
  await client.publish([audioTrack]);

  console.log("🎤 joined voice");
};

// слушаем других пользователей
client.on("user-published", async (user, mediaType) => {
  await client.subscribe(user, mediaType);

  if (mediaType === "audio") {
    user.audioTrack.play();
  }
});