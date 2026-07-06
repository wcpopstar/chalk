var lastMsgSentAt = 0;
function sendMsg(e) { if (e.key === 'Enter') sendMsgBtn(); }
function sendMsgBtn() {
  var input = document.getElementById('chatInput');
  var text = input.value.trim();
  if (!text || !currentConvId || !socket) return;
  var now = Date.now();
  if (now - lastMsgSentAt < 300) return; // guards against Enter-key/double-click spam
  lastMsgSentAt = now;
  socket.emit('chat:message', { conversationId: currentConvId, text: text }, function(res) {
    if (res && res.error) showToast('❌ ' + res.error);
  });
  input.value = '';
}
