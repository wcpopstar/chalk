// ── Username generation ─────────────────────────────────────────────────────
// Produces gaming-flavored English handles like "SilentViper" or
// "CrimsonReaper" for people who register without picking a name.
//
// Design constraints:
//  - Must satisfy the username schema (validation/schemas.ts): 3-24 chars,
//    [a-zA-Z0-9 _-] only. Longest possible combo here is 9+9(+3 digits)
//    = 21 chars, safely under the cap.
//  - Clean names first: the default has NO digits — "NeonPhantom" reads
//    like a name someone chose, "Player7291" reads like a bot. The numeric
//    suffix exists only as a collision-escape hatch (see auth/register.ts,
//    which checks availability and retries).
//  - No word appears in both lists, so degenerate doubles ("EchoEcho")
//    can't happen.
//
// 72 adjectives x 88 nouns = 6336 clean combos; with the 2-digit suffix
// variant the space is ~570k — collisions stay rare far beyond this app's
// scale, and register.ts handles the rare hit by retrying.

const ADJECTIVES = [
  'Silent', 'Crimson', 'Neon', 'Frost', 'Iron', 'Ghost', 'Storm', 'Night',
  'Solar', 'Lunar', 'Cyber', 'Turbo', 'Feral', 'Vivid', 'Rogue', 'Savage',
  'Static', 'Golden', 'Hollow', 'Rapid', 'Grim', 'Arctic', 'Cosmic', 'Mystic',
  'Prime', 'Wild', 'Zero', 'Astral', 'Ember', 'Onyx', 'Jade', 'Steel',
  'Void', 'Nova', 'Hyper', 'Alpha', 'Omega', 'Delta', 'Rebel', 'Royal',
  'Lucky', 'Stealth', 'Thunder', 'Winter', 'Scarlet', 'Radiant', 'Fierce', 'Bold',
  'Dire', 'Drift', 'Flux', 'Aero', 'Apex', 'Blazing', 'Bronze', 'Carbon',
  'Chrome', 'Dark', 'Dusk', 'Dawn', 'Elder', 'Gloom', 'Ivory', 'Jolly',
  'Krypto', 'Midnight', 'Nimble', 'Obsidian', 'Phantom', 'Quantum', 'Rusty', 'Velvet',
] as const;

const NOUNS = [
  'Viper', 'Falcon', 'Wolf', 'Raven', 'Phoenix', 'Dragon', 'Panther', 'Reaper',
  'Hunter', 'Sniper', 'Ranger', 'Knight', 'Samurai', 'Ninja', 'Wizard', 'Titan',
  'Golem', 'Specter', 'Wraith', 'Griffin', 'Kraken', 'Hydra', 'Cobra', 'Lynx',
  'Jaguar', 'Hawk', 'Fox', 'Bear', 'Shark', 'Orca', 'Mantis', 'Scorpion',
  'Raptor', 'Rhino', 'Bison', 'Puma', 'Drifter', 'Nomad', 'Voyager', 'Pilot',
  'Ace', 'Baron', 'Duke', 'Jester', 'Rook', 'Blade', 'Arrow', 'Comet',
  'Meteor', 'Pulse', 'Surge', 'Cipher', 'Vector', 'Glitch', 'Byte', 'Pixel',
  'Core', 'Forge', 'Saber', 'Lancer', 'Warden', 'Sentry', 'Scout', 'Gunner',
  'Striker', 'Slayer', 'Vandal', 'Bandit', 'Outlaw', 'Maverick', 'Renegade', 'Corsair',
  'Gambit', 'Havoc', 'Fury', 'Wrath', 'Tempest', 'Cyclone', 'Avalanche', 'Inferno',
  'Eclipse', 'Zenith', 'Nadir', 'Onslaught', 'Bastion', 'Citadel', 'Paladin', 'Crusader',
] as const;

function pick<T>(list: readonly T[]): T {
  return list[Math.floor(Math.random() * list.length)]!;
}

/**
 * One username candidate. Clean ("SilentViper") by default; pass
 * `{ suffix: true }` to append a 2-digit number ("SilentViper42") — used by
 * register.ts as the escape hatch when clean candidates are taken.
 */
function generateUsername({ suffix = false }: { suffix?: boolean } = {}): string {
  const base = `${pick(ADJECTIVES)}${pick(NOUNS)}`;
  if (!suffix) return base;
  return `${base}${10 + Math.floor(Math.random() * 90)}`;
}

export { generateUsername };
