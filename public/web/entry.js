// Module entry point for the frontend. As the codebase migrates off global
// scripts, new/refactored ES modules are imported here and (for anything the
// remaining legacy global scripts still call) bridged onto `window`.
//
// Loaded two ways:
//   - dev  : <script type="module" src="/web/entry.js"> in public/index.html,
//            resolved natively by the browser (no build step — instant dev).
//   - prod : bundled by esbuild and PREPENDED to the legacy bundle so these
//            globals exist synchronously before any legacy code runs.
//            See scripts/build-client.mjs.
import { escHtml, jsStr, avatarHtml } from './utils/dom.js';
import {
  formatChatTime, fmtDateTime, msgDayKey,
  formatCallDuration, formatLastSeen, formatDayLabel,
} from './utils/format.js';
import { gamingLinkUrl } from './utils/links.js';
import { getParticipantId, participantAvatarHtml, participantDisplayName } from './utils/participant.js';
import { maskEmail } from './utils/text.js';
import { genderLabel, langLabel } from './utils/labels.js';
import { lastMessagePreview, presenceStatusLabel } from './chat/summary.js';
import {
  forwardedLabelHtml, replyQuoteHtml, dateDividerHtml, youtubePreviewHtml, videoNoteHtml,
} from './chat/message-html.js';

// Bridge: keep the legacy global API working until every caller is a module.
Object.assign(window, {
  escHtml, jsStr, avatarHtml,
  formatChatTime, fmtDateTime, msgDayKey,
  formatCallDuration, formatLastSeen, formatDayLabel,
  gamingLinkUrl,
  getParticipantId, participantAvatarHtml, participantDisplayName,
  maskEmail,
  genderLabel, langLabel,
  lastMessagePreview, presenceStatusLabel,
  forwardedLabelHtml, replyQuoteHtml, dateDividerHtml, youtubePreviewHtml, videoNoteHtml,
});
