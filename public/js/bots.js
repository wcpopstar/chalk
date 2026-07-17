// ── Боты: секция настроек ────────────────────────────────────────────────────
// Создание/удаление ботов, перевыпуск токена, добавление бота в чат.
// Серверная часть: src/routes/bots.ts. Токен показывается ровно один раз.

async function loadBotsSection() {
  const list = document.getElementById('botsList');
  const example = document.getElementById('botApiExample');
  if (example && example.textContent.includes('{origin}')) {
    example.textContent = example.textContent.replace('{origin}', location.origin);
  }
  try {
    const { bots } = await api('/api/bots');
    renderBotsList(bots || []);
  } catch (e) {
    if (list) list.innerHTML = `<div class="section-sub">${escHtml(e.message || 'Ошибка загрузки')}</div>`;
  }
}

function renderBotsList(bots) {
  const list = document.getElementById('botsList');
  if (!list) return;
  if (!bots.length) {
    list.innerHTML = '<div class="section-sub">Пока нет ботов — создай первого выше.</div>';
    return;
  }
  list.innerHTML = bots.map((b) => `
    <div class="bot-row" data-botid="${escHtml(b.id)}">
      <div class="bot-row-ava">${b.avatar_url ? `<img src="${escHtml(b.avatar_url)}" alt="">` : escHtml(b.avatar_emoji || '🤖')}</div>
      <div class="bot-row-info">
        <div class="bot-row-name">${escHtml(b.username)} <span class="bot-badge">БОТ</span></div>
        <div class="bot-row-meta">создан ${new Date(b.created_at).toLocaleDateString()}</div>
      </div>
      <div class="bot-row-actions">
        <button class="bot-act-btn" onclick="botPickChat('${escHtml(b.id)}')">В чат</button>
        <button class="bot-act-btn" onclick="regenBotToken('${escHtml(b.id)}')">Токен ↺</button>
        <button class="bot-act-btn bot-act-danger" onclick="deleteBot('${escHtml(b.id)}', '${jsStr(b.username)}')">Удалить</button>
      </div>
    </div>`).join('');
}

async function createBot() {
  const input = document.getElementById('botNameInput');
  const btn = document.getElementById('botCreateBtn');
  const username = (input.value || '').trim();
  if (username.length < 3) { showToast('Имя бота — минимум 3 символа'); return; }
  btn.disabled = true;
  try {
    const { bot, token } = await api('/api/bots', { method: 'POST', body: JSON.stringify({ username }) });
    input.value = '';
    revealBotToken(bot.username, token);
    loadBotsSection();
  } catch (e) {
    showToast(e.message || 'Не удалось создать бота');
  } finally {
    btn.disabled = false;
  }
}

// Показ токена (после создания или перевыпуска) с кнопкой копирования.
function revealBotToken(botName, token) {
  const box = document.getElementById('botTokenReveal');
  if (!box) return;
  box.style.display = 'block';
  box.innerHTML = `
    <div class="bot-token-title">Токен бота «${escHtml(botName)}» — сохрани, он больше не покажется:</div>
    <div class="bot-token-row">
      <code class="bot-token-value" id="botTokenValue">${escHtml(token)}</code>
      <button class="bot-act-btn" onclick="copyBotToken()">Копировать</button>
    </div>`;
}

function copyBotToken() {
  const el = document.getElementById('botTokenValue');
  if (!el) return;
  navigator.clipboard.writeText(el.textContent).then(
    () => showToast('Токен скопирован ✓'),
    () => showToast('Не удалось скопировать'),
  );
}

async function regenBotToken(botId) {
  if (!confirm('Перевыпустить токен? Старый сразу перестанет работать.')) return;
  try {
    const { token } = await api(`/api/bots/${botId}/token`, { method: 'POST' });
    revealBotToken('', token);
    showToast('Новый токен выпущен ✓');
  } catch (e) {
    showToast(e.message || 'Ошибка');
  }
}

async function deleteBot(botId, name) {
  if (!confirm(`Удалить бота «${name}»? Это действие необратимо.`)) return;
  try {
    await api(`/api/bots/${botId}`, { method: 'DELETE' });
    showToast('Бот удалён');
    loadBotsSection();
  } catch (e) {
    showToast(e.message || 'Ошибка');
  }
}

// ── Добавление бота в чат: мини-выбор из списка моих чатов ──────────────────
async function botPickChat(botId) {
  let conversations;
  try {
    ({ conversations } = await api('/api/chats'));
  } catch (e) {
    showToast(e.message || 'Не удалось загрузить чаты'); return;
  }
  const items = (conversations || []).filter((c) => c.type !== 'saved');
  if (!items.length) { showToast('Сначала создай чат или группу'); return; }

  const label = (c) => c.name || (c.other_user && c.other_user.username) || 'Чат';
  const pick = prompt(`Номер чата, куда добавить бота:\n${
    items.map((c, i) => `${i + 1}. ${label(c)}${c.type === 'group' ? ' (группа)' : ''}`).join('\n')}`);
  const idx = parseInt(pick, 10) - 1;
  if (isNaN(idx) || !items[idx]) return;
  try {
    await api(`/api/bots/${botId}/chats`, { method: 'POST', body: JSON.stringify({ conversation_id: items[idx].id }) });
    showToast(`Бот добавлен в «${label(items[idx])}» ✓`);
  } catch (e) {
    showToast(e.message || 'Ошибка');
  }
}
