-- ═══════════════════════════════════════════════════════════════════════════
-- CHALK — additional games + a "just chat" (non-gaming) category
-- ═══════════════════════════════════════════════════════════════════════════

INSERT INTO games (id, name, emoji) VALUES
  ('minecraft', 'Minecraft',         '🧱'),
  ('genshin',   'Genshin Impact',    '⚡'),
  ('roblox',    'Roblox',            '🟩'),
  ('gta5',      'GTA V',             '🚗'),
  ('amongus',   'Among Us',          '🚀'),
  ('r6siege',   'Rainbow Six Siege', '🌈'),
  ('wow',       'World of Warcraft', '🐉'),
  ('mlbb',      'Mobile Legends',    '🔥'),
  ('chat',      'Просто пообщаться', '💬')
ON CONFLICT (id) DO NOTHING;
