// ── DESIGN CUSTOMIZER (settings → Дизайн) ────────────────────────────────────
// Lets the user reshape the app for themselves: an edit mode where any element
// can be dragged with the mouse (translate) and resized by its corner handle,
// a font picker, color overrides for the theme variables, a background image
// (drop a picture anywhere in edit mode), and named themes that snapshot all
// of it. Everything is personal and local: state lives in localStorage and is
// re-applied on every load — nothing is sent to the server.
//
// Element identity: a dragged element is remembered as a CSS selector (its id
// when it has one, otherwise a class/nth-of-type path). Selectors that no
// longer match anything (markup changed, dynamic element gone) are simply
// skipped — a stale entry can't break the page.

var CUSTOMIZER_KEY = 'chalk_custom_design';

var customDesign = (() => {
  try {
    const d = JSON.parse(localStorage.getItem(CUSTOMIZER_KEY) || 'null');
    if (d && typeof d === 'object') {
      return { layout: d.layout || {}, font: d.font || '', vars: d.vars || {}, bg: d.bg || '', themes: d.themes || {} };
    }
  } catch (_) {}
  return { layout: {}, font: '', vars: {}, bg: '', themes: {} };
})();

// Fixed list — the value is used verbatim as a font-family stack.
var CUSTOM_FONTS = [
  ['', 'По умолчанию (Inter)'],
  ["'Rajdhani', sans-serif", 'Rajdhani (игровой)'],
  ['system-ui, sans-serif', 'Системный'],
  ["Georgia, 'Times New Roman', serif", 'С засечками'],
  ["'Courier New', monospace", 'Моноширинный'],
  ["'Comic Sans MS', 'Comic Sans', cursive", 'Comic Sans'],
  ["Verdana, Geneva, sans-serif", 'Verdana'],
  ["'Trebuchet MS', sans-serif", 'Trebuchet'],
];

// Theme variables exposed in the «Дизайн» section, with UI labels.
var CUSTOM_VARS = [
  ['--accent', 'Акцент'],
  ['--bg', 'Фон'],
  ['--surface', 'Панели'],
  ['--surface2', 'Панели 2'],
  ['--text', 'Текст'],
  ['--border', 'Границы'],
];

function saveCustomDesign() {
  try {
    localStorage.setItem(CUSTOMIZER_KEY, JSON.stringify(customDesign));
  } catch (e) {
    showToast('❌ Не хватило места для сохранения (слишком большое изображение?)');
  }
}

// ── APPLY ────────────────────────────────────────────────────────────────────

function applyCustomFont() {
  let styleEl = document.getElementById('customFontStyle');
  if (!customDesign.font) { if (styleEl) styleEl.remove(); return; }
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = 'customFontStyle';
    document.head.appendChild(styleEl);
  }
  // Only allow values from our fixed list — never arbitrary strings into CSS.
  const known = CUSTOM_FONTS.some(([v]) => v === customDesign.font);
  if (!known) { customDesign.font = ''; styleEl.remove(); return; }
  styleEl.textContent = `body, button, input, select, textarea { font-family: ${customDesign.font} !important; }`;
}

function applyCustomVars() {
  const root = document.documentElement;
  CUSTOM_VARS.forEach(([name]) => {
    const v = customDesign.vars[name];
    // Values come from <input type="color"> → always #rrggbb; validate anyway.
    if (v && /^#[0-9a-fA-F]{3,8}$/.test(v)) root.style.setProperty(name, v);
    else root.style.removeProperty(name);
  });
}

function applyCustomBg() {
  const b = document.body;
  if (customDesign.bg && /^data:image\//.test(customDesign.bg)) {
    b.style.backgroundImage = `url("${customDesign.bg}")`;
    b.style.backgroundSize = 'cover';
    b.style.backgroundPosition = 'center';
    b.style.backgroundAttachment = 'fixed';
  } else {
    b.style.backgroundImage = '';
    b.style.backgroundSize = '';
    b.style.backgroundPosition = '';
    b.style.backgroundAttachment = '';
  }
}

// Applies stored translate/size to every element the selectors still match.
// Idempotent — safe to re-run whenever new DOM appears.
function applyCustomLayout() {
  Object.keys(customDesign.layout).forEach((sel) => {
    const c = customDesign.layout[sel];
    let el = null;
    try { el = document.querySelector(sel); } catch (_) { return; }
    if (!el) return;
    el.style.translate = (c.dx || c.dy) ? `${c.dx || 0}px ${c.dy || 0}px` : '';
    if (c.w) el.style.width = `${c.w}px`;
    if (c.h) el.style.height = `${c.h}px`;
  });
}

var customLayoutObserver = null;

function applyCustomDesign() {
  applyCustomFont();
  applyCustomVars();
  applyCustomBg();
  applyCustomLayout();
  // Dynamic parts of the UI (chats list, modals…) appear after load — re-apply
  // the layout (debounced) so customized dynamic elements pick their state up.
  if (!customLayoutObserver && Object.keys(customDesign.layout).length) {
    let t = null;
    customLayoutObserver = new MutationObserver(() => {
      clearTimeout(t);
      t = setTimeout(applyCustomLayout, 250);
    });
    customLayoutObserver.observe(document.body, { childList: true, subtree: true });
  }
}

// ── EDIT MODE ────────────────────────────────────────────────────────────────

var designEdit = null; // { hoverEl, selEl, drag, toolbar, box }

function designPickTarget(t) {
  // Climb to something meaningful: skip bare text wrappers with no class/id.
  let el = t;
  while (el && el !== document.body && !el.id && !el.classList.length) el = el.parentElement;
  if (!el || el === document.body || el === document.documentElement) return null;
  if (el.closest('.dz-toolbar, .dz-box')) return null;
  return el;
}

// Unique, reasonably stable selector for an element.
function designSelectorFor(el) {
  if (el.id) return `#${CSS.escape(el.id)}`;
  const parts = [];
  let cur = el;
  while (cur && cur !== document.body) {
    if (cur.id) { parts.unshift(`#${CSS.escape(cur.id)}`); break; }
    let seg = cur.tagName.toLowerCase();
    const cls = [...cur.classList].filter((c) => !/^(active|hidden|dz-)/.test(c)).slice(0, 2);
    if (cls.length) seg += `.${cls.map((c) => CSS.escape(c)).join('.')}`;
    const parent = cur.parentElement;
    if (parent) {
      const same = [...parent.children].filter((s) => s.tagName === cur.tagName);
      if (same.length > 1) seg += `:nth-of-type(${same.indexOf(cur) + 1})`;
    }
    parts.unshift(seg);
    cur = cur.parentElement;
  }
  const sel = parts.join(' > ');
  try {
    if (document.querySelectorAll(sel).length === 1) return sel;
  } catch (_) {}
  return sel; // best effort — applyCustomLayout uses querySelector (first match)
}

function designUpdateBox() {
  const { selEl, box } = designEdit;
  if (!selEl || !selEl.isConnected) { box.style.display = 'none'; return; }
  const r = selEl.getBoundingClientRect();
  box.style.display = 'block';
  box.style.left = `${r.left - 2}px`;
  box.style.top = `${r.top - 2}px`;
  box.style.width = `${r.width + 4}px`;
  box.style.height = `${r.height + 4}px`;
}

function designLayoutEntry(el) {
  const sel = designSelectorFor(el);
  if (!customDesign.layout[sel]) customDesign.layout[sel] = { dx: 0, dy: 0, w: 0, h: 0 };
  return [sel, customDesign.layout[sel]];
}

function designOnPointerDown(e) {
  if (!designEdit) return;
  const resizeHandle = e.target.closest('.dz-box-handle');
  const el = resizeHandle ? designEdit.selEl : designPickTarget(e.target);
  if (e.target.closest('.dz-toolbar')) return; // toolbar keeps normal clicks
  e.preventDefault();
  e.stopPropagation();
  if (!el) return;
  designEdit.selEl = el;
  const [sel, entry] = designLayoutEntry(el);
  const r = el.getBoundingClientRect();
  designEdit.drag = {
    sel,
    entry,
    resize: Boolean(resizeHandle),
    startX: e.clientX,
    startY: e.clientY,
    baseDx: entry.dx || 0,
    baseDy: entry.dy || 0,
    baseW: entry.w || r.width,
    baseH: entry.h || r.height,
    moved: false,
  };
  designUpdateBox();
}

function designOnPointerMove(e) {
  if (!designEdit) return;
  const d = designEdit.drag;
  if (!d) {
    const el = designPickTarget(e.target);
    if (designEdit.hoverEl && designEdit.hoverEl !== el) designEdit.hoverEl.classList.remove('dz-hover');
    designEdit.hoverEl = el;
    if (el && el !== designEdit.selEl) el.classList.add('dz-hover');
    return;
  }
  e.preventDefault();
  const dx = e.clientX - d.startX;
  const dy = e.clientY - d.startY;
  if (Math.abs(dx) + Math.abs(dy) > 2) d.moved = true;
  const el = designEdit.selEl;
  if (d.resize) {
    d.entry.w = Math.max(24, Math.round(d.baseW + dx));
    d.entry.h = Math.max(16, Math.round(d.baseH + dy));
    el.style.width = `${d.entry.w}px`;
    el.style.height = `${d.entry.h}px`;
  } else {
    d.entry.dx = Math.round(d.baseDx + dx);
    d.entry.dy = Math.round(d.baseDy + dy);
    el.style.translate = `${d.entry.dx}px ${d.entry.dy}px`;
  }
  designUpdateBox();
}

function designOnPointerUp(e) {
  if (!designEdit || !designEdit.drag) return;
  e.preventDefault();
  e.stopPropagation();
  const d = designEdit.drag;
  designEdit.drag = null;
  if (d.moved) {
    // Drop no-op entries so the stored layout stays minimal.
    const en = d.entry;
    if (!en.dx && !en.dy && !en.w && !en.h) delete customDesign.layout[d.sel];
    saveCustomDesign();
  }
  designUpdateBox();
}

// In edit mode every normal click is swallowed (capture phase) so dragging a
// button doesn't also trigger it.
function designOnClickCapture(e) {
  if (!designEdit) return;
  if (e.target.closest('.dz-toolbar')) return;
  e.preventDefault();
  e.stopPropagation();
}

function designOnKeyDown(e) {
  if (!designEdit) return;
  if (e.key === 'Escape') { e.preventDefault(); exitDesignEditMode(); }
}

// Drop an image anywhere in edit mode → it becomes the app background.
function designOnDrop(e) {
  if (!designEdit) return;
  e.preventDefault();
  const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (file && file.type.startsWith('image/')) setCustomBgFromFile(file);
}

function enterDesignEditMode() {
  if (designEdit) return;
  const toolbar = document.createElement('div');
  toolbar.className = 'dz-toolbar';
  toolbar.innerHTML = `
    <span class="dz-toolbar-hint">🎨 Тяни элементы мышкой • угол рамки — размер • брось картинку — фон • Esc — выход</span>
    <button class="dz-btn" onclick="designResetSelected()">↺ Сбросить элемент</button>
    <button class="dz-btn dz-btn-primary" onclick="exitDesignEditMode()">✅ Готово</button>`;
  const box = document.createElement('div');
  box.className = 'dz-box';
  box.innerHTML = '<div class="dz-box-handle" title="Потяни, чтобы изменить размер"></div>';
  document.body.append(toolbar, box);
  document.documentElement.classList.add('dz-editing');
  designEdit = { hoverEl: null, selEl: null, drag: null, toolbar, box };

  document.addEventListener('pointerdown', designOnPointerDown, true);
  document.addEventListener('pointermove', designOnPointerMove, true);
  document.addEventListener('pointerup', designOnPointerUp, true);
  document.addEventListener('click', designOnClickCapture, true);
  document.addEventListener('keydown', designOnKeyDown, true);
  document.addEventListener('dragover', (e) => { if (designEdit) e.preventDefault(); });
  document.addEventListener('drop', designOnDrop);
  window.addEventListener('scroll', designScrollUpd, true);
}

function designScrollUpd() { if (designEdit && designEdit.selEl) designUpdateBox(); }

function exitDesignEditMode() {
  if (!designEdit) return;
  document.removeEventListener('pointerdown', designOnPointerDown, true);
  document.removeEventListener('pointermove', designOnPointerMove, true);
  document.removeEventListener('pointerup', designOnPointerUp, true);
  document.removeEventListener('click', designOnClickCapture, true);
  document.removeEventListener('keydown', designOnKeyDown, true);
  window.removeEventListener('scroll', designScrollUpd, true);
  if (designEdit.hoverEl) designEdit.hoverEl.classList.remove('dz-hover');
  designEdit.toolbar.remove();
  designEdit.box.remove();
  document.documentElement.classList.remove('dz-editing');
  designEdit = null;
  saveCustomDesign();
  showToast('✅ Дизайн сохранён');
}
window.enterDesignEditMode = enterDesignEditMode;
window.exitDesignEditMode = exitDesignEditMode;

function designResetSelected() {
  if (!designEdit || !designEdit.selEl) { showToast('Сначала выбери элемент'); return; }
  const sel = designSelectorFor(designEdit.selEl);
  delete customDesign.layout[sel];
  const el = designEdit.selEl;
  el.style.translate = '';
  el.style.width = '';
  el.style.height = '';
  saveCustomDesign();
  designUpdateBox();
}
window.designResetSelected = designResetSelected;

// ── BACKGROUND IMAGE ─────────────────────────────────────────────────────────

// Downscale + JPEG-compress before storing — localStorage has ~5 MB total.
function setCustomBgFromFile(file) {
  const img = new Image();
  const url = URL.createObjectURL(file);
  img.onload = () => {
    URL.revokeObjectURL(url);
    const maxW = 1920;
    const scale = Math.min(1, maxW / img.width);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.width * scale);
    canvas.height = Math.round(img.height * scale);
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    customDesign.bg = canvas.toDataURL('image/jpeg', 0.82);
    applyCustomBg();
    saveCustomDesign();
    showToast('🖼️ Фон обновлён');
  };
  img.onerror = () => { URL.revokeObjectURL(url); showToast('❌ Не удалось прочитать изображение'); };
  img.src = url;
}
window.setCustomBgFromFile = setCustomBgFromFile;

function onCustomBgInput(input) {
  const f = input.files && input.files[0];
  if (f) setCustomBgFromFile(f);
  input.value = '';
}
window.onCustomBgInput = onCustomBgInput;

function clearCustomBg() {
  customDesign.bg = '';
  applyCustomBg();
  saveCustomDesign();
}
window.clearCustomBg = clearCustomBg;

// ── SETTINGS SECTION UI ──────────────────────────────────────────────────────

function loadDesignSection() {
  const fontSel = document.getElementById('designFontSelect');
  if (fontSel) {
    fontSel.innerHTML = CUSTOM_FONTS.map(([v, label]) =>
      `<option value="${escHtml(v)}"${v === customDesign.font ? ' selected' : ''}>${escHtml(label)}</option>`).join('');
    fontSel.onchange = () => {
      customDesign.font = fontSel.value;
      applyCustomFont();
      saveCustomDesign();
    };
  }

  const varsWrap = document.getElementById('designVars');
  if (varsWrap) {
    const current = getComputedStyle(document.documentElement);
    varsWrap.innerHTML = CUSTOM_VARS.map(([name, label]) => {
      const val = customDesign.vars[name] || rgbToHex(current.getPropertyValue(name).trim());
      return `<label class="dz-var-row"><span>${escHtml(label)}</span>
        <input type="color" value="${escHtml(val)}" onchange="onDesignVarChange('${name}', this.value)">
        </label>`;
    }).join('');
  }

  renderDesignThemes();
}
window.loadDesignSection = loadDesignSection;

function rgbToHex(v) {
  const m = v.match(/^rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)/);
  if (!m) return /^#/.test(v) ? v : '#000000';
  return `#${[m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, '0')).join('')}`;
}

function onDesignVarChange(name, value) {
  if (!CUSTOM_VARS.some(([n]) => n === name)) return;
  customDesign.vars[name] = value;
  applyCustomVars();
  saveCustomDesign();
}
window.onDesignVarChange = onDesignVarChange;

// ── THEMES ───────────────────────────────────────────────────────────────────

function renderDesignThemes() {
  const wrap = document.getElementById('designThemes');
  if (!wrap) return;
  const names = Object.keys(customDesign.themes);
  wrap.innerHTML = names.length
    ? names.map((n) => `<div class="dz-theme-row">
        <span class="dz-theme-name">${escHtml(n)}</span>
        <button class="dz-btn" onclick="applyDesignTheme('${jsStr(n)}')">Применить</button>
        <button class="dz-btn dz-btn-danger" onclick="deleteDesignTheme('${jsStr(n)}')">✕</button>
      </div>`).join('')
    : '<div class="section-sub">Сохранённых тем пока нет.</div>';
}

function saveDesignTheme() {
  const input = document.getElementById('designThemeName');
  const name = (input && input.value || '').trim().slice(0, 40);
  if (!name) { showToast('Дай теме имя'); return; }
  customDesign.themes[name] = {
    font: customDesign.font,
    vars: { ...customDesign.vars },
    bg: customDesign.bg,
    layout: JSON.parse(JSON.stringify(customDesign.layout)),
  };
  saveCustomDesign();
  if (input) input.value = '';
  renderDesignThemes();
  showToast(`💾 Тема «${name}» сохранена`);
}
window.saveDesignTheme = saveDesignTheme;

function applyDesignTheme(name) {
  const t = customDesign.themes[name];
  if (!t) return;
  customDesign.font = t.font || '';
  customDesign.vars = { ...(t.vars || {}) };
  customDesign.bg = t.bg || '';
  customDesign.layout = JSON.parse(JSON.stringify(t.layout || {}));
  saveCustomDesign();
  // Layout offsets of elements not in the theme must be cleared — a reload is
  // the reliable way to drop every inline style this feature ever set.
  location.reload();
}
window.applyDesignTheme = applyDesignTheme;

function deleteDesignTheme(name) {
  delete customDesign.themes[name];
  saveCustomDesign();
  renderDesignThemes();
}
window.deleteDesignTheme = deleteDesignTheme;

function resetCustomDesign() {
  if (!confirm('Сбросить весь кастомный дизайн (позиции, шрифт, цвета, фон)? Сохранённые темы останутся.')) return;
  customDesign.layout = {};
  customDesign.font = '';
  customDesign.vars = {};
  customDesign.bg = '';
  saveCustomDesign();
  location.reload();
}
window.resetCustomDesign = resetCustomDesign;

// ── STARTUP ──────────────────────────────────────────────────────────────────
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', applyCustomDesign);
} else {
  applyCustomDesign();
}
