// Date/time formatting helpers. The first three are pure; the rest are
// localized via the i18n adapter (../i18n/t.js), which for now proxies the
// legacy global T() — so these already `import` T cleanly and won't need to
// change when i18n becomes a real module. Bridged onto window by web/entry.js
// for the legacy global scripts that still call them.
import { T, getCurrentLang } from '../i18n/t.js';

// Compact timestamp for a chat-list row: "HH:MM" if the message is from today,
// otherwise "DD.MM".
export function formatChatTime(iso) {
  try {
    const d = new Date(iso);
    const now = new Date();
    if (d.toDateString() === now.toDateString()) {
      return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    }
    return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}`;
  } catch (_) {
    return '';
  }
}

// Full locale-formatted date+time (used in settings — devices / login history).
export function fmtDateTime(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString();
  } catch (_) {
    return iso;
  }
}

// Stable "YYYY-MM-DD" key for grouping messages by calendar day (date dividers).
export function msgDayKey(iso) {
  const d = iso ? new Date(iso) : new Date();
  if (isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// "1ч 5мин" / "5мин" / "42с" — total call time, localized units. Members who
// can manage messages bypass slow-mode, etc. — pure formatting only here.
export function formatCallDuration(totalSeconds) {
  const s = Math.max(0, parseInt(totalSeconds, 10) || 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}${T('unit_hour', 'ч')} ${m}${T('unit_min', 'мин')}`;
  if (m > 0) return `${m}${T('unit_min', 'мин')}`;
  return `${s} ${T('unit_seconds_short', 'с')}`;
}

// Human "last seen" label: "just now" / "N min ago" / "at HH:MM" / "yesterday
// at HH:MM" / "DD.MM.YYYY", localized.
export function formatLastSeen(iso) {
  if (!iso) return T('status_offline_lc');
  const d = new Date(iso);
  if (isNaN(d.getTime())) return T('status_offline_lc');
  const now = new Date();
  const diff = (now.getTime() - d.getTime()) / 1000;
  if (diff < 60) return T('last_seen_just_now');
  if (diff < 3600) return T('last_seen_min').replace('{n}', String(Math.floor(diff / 60)));
  const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (d.toDateString() === now.toDateString()) {
    if (diff < 6 * 3600) return T('last_seen_hours').replace('{n}', String(Math.floor(diff / 3600)));
    return T('last_seen_at').replace('{t}', hhmm);
  }
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return T('last_seen_yesterday').replace('{t}', hhmm);
  const dd = `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
  return T('last_seen_date').replace('{d}', dd);
}

// Day divider label: "Today" / "Yesterday" / a localized long date.
export function formatDayLabel(iso) {
  const d = iso ? new Date(iso) : new Date();
  if (isNaN(d.getTime())) return '';
  const today = msgDayKey(new Date().toISOString());
  const key = msgDayKey(iso);
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  if (key === today) return T('date_today');
  if (key === msgDayKey(yesterday.toISOString())) return T('date_yesterday');
  const sameYear = d.getFullYear() === new Date().getFullYear();
  try {
    return d.toLocaleDateString(getCurrentLang(), sameYear ? { day: 'numeric', month: 'long' } : { day: 'numeric', month: 'long', year: 'numeric' });
  } catch (_) {
    return key;
  }
}
