// ── PER-CONVERSATION CHAT BACKGROUND ────────────────────────────────────────
// Each member picks their own wallpaper for a conversation; the choice is
// stored server-side (PATCH /api/chats/:id/background) so it follows the user
// across devices, and loaded back with the message history (GET
// /:id/messages -> chat_background). We persist a short preset KEY, not raw
// CSS, so the server never stores arbitrary style blobs.
var CHAT_BG_PRESETS = {
  none: '',
  aurora: 'linear-gradient(160deg,#0f2027,#203a43,#2c5364)',
  plum: 'linear-gradient(160deg,#42275a,#734b6d)',
  sunset: 'linear-gradient(160deg,#3a1c71,#d76d77,#ffaf7b)',
  forest: 'linear-gradient(160deg,#134e5e,#71b280)',
  night: 'linear-gradient(160deg,#0f0c29,#302b63,#24243e)',
  rose: 'linear-gradient(160deg,#ee9ca7,#ffdde1)',
  ocean: 'linear-gradient(160deg,#2193b0,#6dd5ed)',
  graphite: 'linear-gradient(160deg,#232526,#414345)',
};

var currentChatBg = 'none'; // preset key for the open conversation

// Apply a preset key to the open conversation's message list (no persistence).
function applyChatBackground(key) {
  const el = document.getElementById('chatMessages');
  if (!el) return;
  const css = Object.prototype.hasOwnProperty.call(CHAT_BG_PRESETS, key) ? CHAT_BG_PRESETS[key] : '';
  if (css) {
    el.style.backgroundImage = css;
    el.style.backgroundSize = 'cover';
    el.style.backgroundAttachment = 'local';
    el.classList.add('has-custom-bg');
  } else {
    el.style.backgroundImage = '';
    el.classList.remove('has-custom-bg');
  }
}

// Called from openConv() with whatever the server returned for this member.
function setChatBackgroundForConv(key) {
  currentChatBg = key && Object.prototype.hasOwnProperty.call(CHAT_BG_PRESETS, key) ? key : 'none';
  applyChatBackground(currentChatBg);
}

function toggleChatBgPicker(event) {
  if (event) event.stopPropagation();
  let picker = document.getElementById('chatBgPicker');
  if (picker && picker.classList.contains('show')) { picker.classList.remove('show'); return; }
  if (!picker) {
    picker = document.createElement('div');
    picker.id = 'chatBgPicker';
    picker.className = 'chat-bg-picker';
    picker.onclick = (e) => e.stopPropagation();
    document.body.appendChild(picker);
  }
  picker.innerHTML =
    `<div class="chat-bg-picker-title">${  escHtml(T('chat_bg_title'))  }</div>` +
    `<div class="chat-bg-swatches">${
      Object.keys(CHAT_BG_PRESETS).map((key) => {
        const css = CHAT_BG_PRESETS[key];
        const sel = key === currentChatBg ? ' selected' : '';
        const style = css ? `background-image:${  css}` : '';
        const label = key === 'none' ? `<span class="chat-bg-none-label">${  escHtml(T('chat_bg_none'))  }</span>` : '';
        return `<div class="chat-bg-swatch${  sel  }" style="${  style  }" title="${  key === 'none' ? escHtml(T('chat_bg_none')) : key  }" onclick="selectChatBg('${  key  }')">${  label  }</div>`;
      }).join('')
    }</div>`;
  // Anchor under the header button.
  const btn = document.getElementById('chatBgBtn');
  if (btn) {
    const r = btn.getBoundingClientRect();
    picker.style.top = `${r.bottom + 6  }px`;
    picker.style.right = `${Math.max(8, window.innerWidth - r.right)  }px`;
  }
  picker.classList.add('show');
}

function selectChatBg(key) {
  currentChatBg = key;
  applyChatBackground(key);
  const picker = document.getElementById('chatBgPicker');
  if (picker) picker.classList.remove('show');
  // Persist for this member (fire-and-forget; a failure just means it won't
  // sync to other devices — the local view already updated).
  if (currentConvId && typeof api === 'function') {
    api(`/api/chats/${  currentConvId  }/background`, {
      method: 'PATCH',
      body: JSON.stringify({ background: key === 'none' ? '' : key }),
    }).catch(() => {});
  }
}

// Close the picker when clicking elsewhere.
document.addEventListener('click', (e) => {
  const picker = document.getElementById('chatBgPicker');
  if (!picker || !picker.classList.contains('show')) return;
  if (e.target.closest && (e.target.closest('#chatBgPicker') || e.target.closest('#chatBgBtn'))) return;
  picker.classList.remove('show');
});
