// Human-readable label lookups (gender, language). Localized ones go through
// the i18n adapter; language names are shown in their own endonym regardless of
// UI language, so they're a static map.
import { T } from '../i18n/t.js';

// Rebuilt on every call so it reflects the CURRENT language. A cached object
// would bake in whatever language was active when first built and never update
// — that used to make gender labels keep showing the old language after a
// switch.
function genderLabels() {
  return {
    male: T('chip_male'),
    female: T('chip_female'),
    other: T('chip_other'),
    prefer_not_to_say: T('profile_not_specified'),
  };
}

export function genderLabel(g) {
  return genderLabels()[g] || T('profile_not_specified');
}

const LANG_LABELS = {
  ru: '🇷🇺 Русский', en: '🇬🇧 English', uk: '🇺🇦 Українська', de: '🇩🇪 Deutsch',
  fr: '🇫🇷 Français', es: '🇪🇸 Español', it: '🇮🇹 Italiano', pt: '🇵🇹 Português',
  pl: '🇵🇱 Polski', nl: '🇳🇱 Nederlands', sv: '🇸🇪 Svenska', no: '🇳🇴 Norsk',
  da: '🇩🇰 Dansk', fi: '🇫🇮 Suomi', cs: '🇨🇿 Čeština', sk: '🇸🇰 Slovenčina',
  hu: '🇭🇺 Magyar', ro: '🇷🇴 Română', bg: '🇧🇬 Български', el: '🇬🇷 Ελληνικά',
  hr: '🇭🇷 Hrvatski', sr: '🇷🇸 Српски', lt: '🇱🇹 Lietuvių', lv: '🇱🇻 Latviešu',
  et: '🇪🇪 Eesti', tr: '🇹🇷 Türkçe', kz: '🇰🇿 Қазақша',
};

export function langLabel(l) {
  return LANG_LABELS[l] || l.toUpperCase();
}
