// ── ADMIN PANEL (/admin.html) ────────────────────────────────────────────────
// Standalone ops page, NOT part of the logged-in SPA: every request carries the
// x-admin-key header (see src/middleware/requireAdminKey.ts). The key lives in
// sessionStorage only — closing the tab forgets it.
/* eslint-env browser */

var ADMIN_KEY_STORE = 'chalk_admin_key';

function adminKey() {
  return sessionStorage.getItem(ADMIN_KEY_STORE) || '';
}

function adminShowError(msg) {
  var el = document.getElementById('adminError');
  el.textContent = msg || '';
  el.classList.toggle('admin-hidden', !msg);
}

async function adminApi(path, options) {
  var opts = options || {};
  opts.headers = Object.assign({ 'x-admin-key': adminKey(), 'Content-Type': 'application/json' }, opts.headers || {});
  var res = await fetch(path, opts);
  var body = null;
  try { body = await res.json(); } catch (_) { /* non-JSON error body */ }
  if (!res.ok) throw new Error((body && body.error) || (`HTTP ${  res.status}`));
  return body;
}

function escA(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

// ── Connect ──────────────────────────────────────────────────────────────────
async function adminConnect() {
  var key = document.getElementById('adminKey').value.trim();
  if (!key) return;
  sessionStorage.setItem(ADMIN_KEY_STORE, key);
  adminShowError('');
  try {
    await adminApi('/api/admin/users?limit=1'); // key check
    document.getElementById('adminPanel').classList.remove('admin-hidden');
    adminLoadUsers();
  } catch (e) {
    sessionStorage.removeItem(ADMIN_KEY_STORE);
    document.getElementById('adminPanel').classList.add('admin-hidden');
    adminShowError(`Ключ не подошёл: ${  e.message}`);
  }
}

function adminShowTab(which) {
  document.getElementById('paneUsers').classList.toggle('admin-hidden', which !== 'users');
  document.getElementById('paneReports').classList.toggle('admin-hidden', which !== 'reports');
  document.getElementById('tabUsers').classList.toggle('active', which === 'users');
  document.getElementById('tabReports').classList.toggle('active', which === 'reports');
  if (which === 'reports') adminLoadReports();
}

// ── Users ────────────────────────────────────────────────────────────────────
function isBannedNow(u) {
  return Boolean(u.banned_until) && new Date(u.banned_until) > new Date();
}

function banLabel(u) {
  var until = new Date(u.banned_until);
  var perm = until.getFullYear() > 2500;
  var base = perm ? 'БАН НАВСЕГДА' : (`БАН до ${  until.toLocaleString()}`);
  return base + (u.ban_reason ? (` · ${  escA(u.ban_reason)}`) : '');
}

async function adminLoadUsers(bannedOnly) {
  var q = document.getElementById('userSearch').value.trim();
  var list = document.getElementById('usersList');
  list.innerHTML = '<div class="admin-empty">Загрузка…</div>';
  try {
    var params = new URLSearchParams();
    if (q) params.set('q', q);
    if (bannedOnly) params.set('banned', 'true');
    var data = await adminApi(`/api/admin/users?${  params.toString()}`);
    var users = data.users || [];
    if (!users.length) { list.innerHTML = '<div class="admin-empty">Никого не найдено</div>'; return; }
    list.innerHTML = users.map((u) => {
      var banned = isBannedNow(u);
      return `<div class="admin-row${  banned ? ' banned' : ''  }">` +
        `<div class="admin-row-main">` +
          `<div class="admin-row-name">${  escA(u.avatar_emoji || '👤')  } ${  escA(u.username)  }</div>` +
          `<div class="admin-row-sub">${  escA(u.email)  } · создан ${  new Date(u.created_at).toLocaleDateString()  }</div>${ 
          banned ? `<div class="admin-row-sub" style="color:var(--danger)">${  banLabel(u)  }</div>` : '' 
        }</div>${ 
        banned
          ? `<div class="admin-actions"><button class="admin-btn secondary" onclick="adminUnban('${  u.id  }')">Разбанить</button></div>`
          : `<div class="admin-actions"><button class="admin-btn danger" onclick="adminBan('${  u.id  }','${  escA(u.username).replace(/'/g, '')  }')">Забанить</button></div>` 
      }</div>`;
    }).join('');
  } catch (e) {
    list.innerHTML = `<div class="admin-error">Ошибка: ${  escA(e.message)  }</div>`;
  }
}

async function adminBan(userId, username) {
  var hoursRaw = prompt(`Забанить ${  username  }.\nНа сколько часов? (пусто или 0 = навсегда)`, '24');
  if (hoursRaw === null) return;
  var hours = parseInt(hoursRaw, 10) || 0;
  var reason = prompt('Причина бана (видна пользователю при входе):', '') || '';
  try {
    await adminApi(`/api/admin/users/${  userId  }/ban`, { method: 'POST', body: JSON.stringify({ hours, reason }) });
    adminLoadUsers();
  } catch (e) { adminShowError(`Не удалось забанить: ${  e.message}`); }
}

async function adminUnban(userId) {
  try {
    await adminApi(`/api/admin/users/${  userId  }/unban`, { method: 'POST' });
    adminLoadUsers();
  } catch (e) { adminShowError(`Не удалось разбанить: ${  e.message}`); }
}

// ── Reports ──────────────────────────────────────────────────────────────────
var REASON_LABELS = {
  harassment: 'Домогательства / травля',
  hate_speech: 'Разжигание ненависти',
  spam: 'Спам или реклама',
  inappropriate_content: 'Неприемлемый контент',
  scam: 'Мошенничество',
  underage: 'Несовершеннолетний',
  other: 'Другое',
};

async function adminLoadReports() {
  var list = document.getElementById('reportsList');
  list.innerHTML = '<div class="admin-empty">Загрузка…</div>';
  try {
    var data = await adminApi('/api/admin/reports?status=open');
    var reports = data.reports || [];
    if (!reports.length) { list.innerHTML = '<div class="admin-empty">Открытых жалоб нет 🎉</div>'; return; }
    list.innerHTML = reports.map((r) => {
      var reported = r.reported || {};
      var reporter = r.reporter || {};
      var banned = reported.banned_until && new Date(reported.banned_until) > new Date();
      return `<div class="admin-row">` +
        `<span class="admin-badge open">${  escA(REASON_LABELS[r.reason] || r.reason)  }</span>` +
        `<div class="admin-row-main">` +
          `<div class="admin-row-name">на: ${  escA(reported.username || '?')  }${banned ? ' <span class="admin-badge ban">уже в бане</span>' : ''  }</div>` +
          `<div class="admin-row-sub">от: ${  escA(reporter.username || '?')  } · ${  new Date(r.created_at).toLocaleString() 
            }${r.context ? (` · ${  escA(r.context)}`) : ''  }</div>${ 
          r.details ? `<div class="admin-row-sub">«${  escA(r.details)  }»</div>` : '' 
        }</div>` +
        `<div class="admin-actions">${ 
          reported.id && !banned ? `<button class="admin-btn danger" onclick="adminBan('${  reported.id  }','${  escA(reported.username || '').replace(/'/g, '')  }')">Бан</button>` : '' 
          }<button class="admin-btn secondary" onclick="adminResolveReport('${  r.id  }','reviewed')">Рассмотрено</button>` +
          `<button class="admin-btn secondary" onclick="adminResolveReport('${  r.id  }','dismissed')">Отклонить</button>` +
        `</div>` +
      `</div>`;
    }).join('');
  } catch (e) {
    list.innerHTML = `<div class="admin-error">Ошибка: ${  escA(e.message)  }</div>`;
  }
}

async function adminResolveReport(id, status) {
  try {
    await adminApi(`/api/admin/reports/${  id}`, { method: 'PATCH', body: JSON.stringify({ status }) });
    adminLoadReports();
  } catch (e) { adminShowError(`Не удалось обновить жалобу: ${  e.message}`); }
}

// Auto-reconnect if a key is already in sessionStorage (page refresh).
if (adminKey()) {
  document.getElementById('adminKey').value = adminKey();
  adminConnect();
}
