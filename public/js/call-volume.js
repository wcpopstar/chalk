// ── PER-PARTICIPANT VOLUME (in-call) ───────────────────────────────────────
var uvmTarget = null;

function callParticipantVolumeOf(userId) {
  if (window.getUserVolume) {
    try { return window.getUserVolume(userId); } catch (_) { return 100; }
  }
  return 100;
}

function openUserVolumeMenu(e, userId, username) {
  e.stopPropagation();
  if (!userId) return;
  uvmTarget = { id: userId, username: username || T('games_player') };

  const current = callParticipantVolumeOf(userId);
  const menu = document.getElementById('userVolumeMenu');
  if (!menu) return;

  menu.innerHTML =
    `<div class="uvm-name">🔊 ${  escHtml(uvmTarget.username)  }</div>` +
    `<div class="uvm-row">` +
      `<span class="uvm-icon" onclick="uvmSetVolume(0)" title="Выключить" data-i18n-title="mute_title">🔈</span>` +
      `<input type="range" class="uvm-slider" id="uvmSlider" min="0" max="200" step="5" value="${  current  }" oninput="uvmOnSlide(this.value)">` +
      `<span class="uvm-icon" onclick="uvmSetVolume(200)" title="Максимум" data-i18n-title="match_max_label">🔊</span>` +
    `</div>` +
    `<div class="uvm-value" id="uvmValue" style="width:auto;text-align:center;margin-top:4px">${  current  }%</div>` +
    `<div class="uvm-reset" onclick="uvmSetVolume(100)"><span data-i18n="volume_reset_100">Сбросить до 100%</span></div>`;

  const rect = e.currentTarget.getBoundingClientRect();
  menu.style.display = 'block';
  let top = rect.bottom + 6;
  let {left} = rect;
  if (left + 200 > window.innerWidth) left = window.innerWidth - 210;
  if (top + 130 > window.innerHeight) top = rect.top - 130;
  menu.style.top = `${top  }px`;
  menu.style.left = `${left  }px`;
}

function closeUserVolumeMenu() {
  const menu = document.getElementById('userVolumeMenu');
  if (menu) menu.style.display = 'none';
  uvmTarget = null;
}

function uvmOnSlide(val) {
  uvmSetVolume(val, true);
}

function uvmSetVolume(val, fromSlider) {
  if (!uvmTarget) return;
  const v = Math.max(0, Math.min(200, parseInt(val, 10) || 0));
  if (window.setUserVolume) window.setUserVolume(uvmTarget.id, v);

  const slider = document.getElementById('uvmSlider');
  if (slider && !fromSlider) slider.value = v;
  const label = document.getElementById('uvmValue');
  if (label) label.textContent = `${v  }%`;
}
