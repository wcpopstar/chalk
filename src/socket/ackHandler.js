// Every chat.js / globalChat.js mutation handler (message, gif, voice,
// video_note, edit, delete) repeats the exact same shape:
//
//   const ack = typeof callback === 'function' ? callback : () => {};
//   try {
//     ...handler-specific logic...
//   } catch (err) {
//     console.error('[some:tag]', err.message);
//     ack({ error: err.message || 'Some fallback message' });
//   }
//
// withAckHandler() centralizes that boilerplate. The handler-specific logic
// (validation order, membership/block checks, messages, event names) stays
// exactly where it was in each file — only the ack/try/catch/log shell moves
// here, so behavior is unchanged and each file stays easy to read on its own.
function withAckHandler(tag, fallbackMessage, fn) {
  return async (payload, callback) => {
    const ack = typeof callback === 'function' ? callback : () => {};
    try {
      await fn(payload || {}, ack);
    } catch (err) {
      console.error(`[${tag}]`, err.message);
      ack({ error: err.message || fallbackMessage });
    }
  };
}

module.exports = { withAckHandler };
