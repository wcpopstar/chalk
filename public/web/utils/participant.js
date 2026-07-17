// Accessors that normalize the several shapes a "participant"/user object can
// arrive in (snake_case from the API, camelCase from some call payloads). Pure
// except participantAvatarHtml, which composes the shared avatarHtml renderer.
import { avatarHtml } from './dom.js';
import { T } from '../i18n/t.js';

// Best available id across the naming variants, or null.
export function getParticipantId(p) {
  return (p && (p.id || p.userId || p.user_id || p.participantId || null)) || null;
}

// Display name across field-name variants, falling back to a localized default.
export function participantDisplayName(p) {
  return (p && (p.username || p.userName || p.nickname || T('games_player'))) || T('games_player');
}

// Avatar HTML for a participant, tolerant of emoji/url field-name variants.
export function participantAvatarHtml(p) {
  return avatarHtml(
    p && (p.avatar_emoji || p.avatarEmoji || null),
    p && (p.avatar_url || p.avatarUrl || null),
  );
}
