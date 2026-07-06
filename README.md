# 🎮 Chalk Backend

Real-time teammate finder with voice calls.
**Stack:** Node.js · Express · Socket.io · Supabase · Agora

---

## Quick start

### 1. Clone & install
```bash
git clone https://github.com/you/chalk-backend
cd chalk-backend
npm install
```

### 2. Set up Supabase

1. Go to [supabase.com](https://supabase.com) → New project
2. **SQL Editor** → paste the full contents of `supabase/migrations/001_init.sql` → Run
3. Copy your keys from **Project Settings → API**:
   - `SUPABASE_URL`
   - `SUPABASE_ANON_KEY`
   - `SUPABASE_SERVICE_KEY` (service_role, keep secret!)

### 3. Set up Agora (voice calls)

1. Go to [console.agora.io](https://console.agora.io) → Create project
2. Enable "Secured mode" → App Certificate will appear
3. Copy `App ID` and `App Certificate`

> Without Agora credentials the server still runs — calls return a dev-mode
> token so you can test the rest of the app.

### 4. Configure environment
```bash
cp .env.example .env
# Edit .env with your keys
```

### 5. Run locally
```bash
npm install       # first time only — also (re)syncs package-lock.json,
                   # required before `npm ci` will work anywhere (Docker, CI)
npm run dev        # tsx watch — auto-reload, runs src/**/*.ts directly, no build step
# or
npm run build && npm start   # compile to dist/, then run the compiled JS
```

Server boots at `http://localhost:3000`
Health check: `GET /health`

### TypeScript

The backend (`src/`, `test/`) is TypeScript, compiled with `tsc` (see
`tsconfig.json`: `strict`, `commonjs`, `es2022`, `esModuleInterop`).
`public/js/` stays plain JS on purpose — it's loaded directly by the browser
via `<script>` tags with no bundler in front of it, so there's nothing for
`tsc` to compile there.

This is a first-pass migration: files were renamed `.js` → `.ts` and typed
just enough to satisfy `strict` mode (mostly explicit `: any` at dynamic
boundaries — request/response bodies, Socket.io payloads, Supabase rows).
`require()`/`module.exports` were intentionally left as-is rather than
rewritten to ES `import`/`export` — smaller diff, same runtime behavior.
Tightening the `any`s into real types is left for a follow-up pass.

```bash
npm run build       # tsc -p tsconfig.json -> dist/
npm run typecheck   # type-checks src/ + test/ together, no emit
npm test            # runs test/**/*.test.ts via node's test runner + tsx
```

---

## Deploy to Railway (free tier available)

```bash
# Install Railway CLI
npm i -g @railway/cli

# Login & init
railway login
railway init

# Set env vars (one-time)
railway variables set \
  SUPABASE_URL=... \
  SUPABASE_ANON_KEY=... \
  SUPABASE_SERVICE_KEY=... \
  JWT_SECRET=... \
  AGORA_APP_ID=... \
  AGORA_APP_CERTIFICATE=... \
  CLIENT_URL=https://your-frontend.vercel.app \
  NODE_ENV=production

# Deploy
railway up
```

Railway automatically reads `PORT` from the environment. No Dockerfile needed.

---

## API Reference

### Auth
| Method | Path | Body | Notes |
|--------|------|------|-------|
| POST | `/api/auth/register` | `{username, email, password, country, languages}` | Returns `{user, token}` |
| POST | `/api/auth/login` | `{email, password}` | Returns `{user, token}` |
| POST | `/api/auth/logout` | — | Marks user offline |
| GET  | `/api/auth/me` | — | Requires Bearer token |

### Users
| Method | Path | Notes |
|--------|------|-------|
| GET    | `/api/users/:id` | Public profile |
| PATCH  | `/api/users/me` | Update profile |
| PUT    | `/api/users/me/games` | Set game list |
| GET    | `/api/users/me/stats` | Match count, rating, friends |
| GET    | `/api/users/discover?game_id=valorant` | Tinder feed |

### Friends
| Method | Path | Notes |
|--------|------|-------|
| GET    | `/api/friends` | Your friend list |
| POST   | `/api/friends/request` | `{targetUserId}` |
| PATCH  | `/api/friends/:id/accept` | Accept pending request |
| DELETE | `/api/friends/:id` | Remove friend |
| POST   | `/api/friends/add-after-call` | Instant add after call |

### Chats
| Method | Path | Notes |
|--------|------|-------|
| GET    | `/api/chats` | Your conversations |
| POST   | `/api/chats/direct` | Get or create DM |
| POST   | `/api/chats/group` | Create group `{name, memberIds}` |
| GET    | `/api/chats/:id/messages` | Message history |
| GET    | `/api/chats/:id/members` | Members list |

### Calls
| Method | Path | Notes |
|--------|------|-------|
| POST   | `/api/calls/token` | Get Agora RTC token `{channelName, uid}` |
| POST   | `/api/calls/start` | Log call start |
| PATCH  | `/api/calls/:id/end` | Log call end |

### Match
| Method | Path | Notes |
|--------|------|-------|
| GET    | `/api/match/history` | Your match history |
| POST   | `/api/match/:matchId/rate` | Rate teammate 1–5 |

---

## Socket.io Events

Connect with:
```js
import { io } from 'socket.io-client';
const socket = io('https://your-server.railway.app', {
  auth: { token: 'YOUR_JWT' }
});
```

### Matchmaking
```
Client → match:join        { gameId, mode, squadSize, rank, rankScore, languages, region }
Server → match:searching   { position }
Server → match:found       { roomId, mode, gameId, participants }
Client → match:leave       {}
Server → match:cancelled   {}
Server → queue:size        { solo, group }
```

### Trial call vote
```
Client → trial:vote        { roomId, vote }   vote: 'yes' | 'no'
Server → trial:voted       { userId, vote }
Server → trial:result      { promote }
Server → call:promoted     { roomId }
```

### WebRTC Signaling
```
Client → signal:offer      { roomId, to, offer }
Server → signal:offer      { from, offer, roomId }
Client → signal:answer     { roomId, to, answer }
Server → signal:answer     { from, answer, roomId }
Client → signal:ice        { roomId, to, candidate }
Server → signal:ice        { from, candidate, roomId }
```

### Direct calls (friends)
```
Client → call:invite       { targetUserId, roomId }
Server → call:incoming     { roomId, from }
Client → call:accept       { roomId, inviterId }
Server → call:accepted     { roomId, by }
Client → call:reject       { roomId, inviterId }
Server → call:rejected     { roomId, by }
Client → call:end          { roomId }
Server → call:ended        { by }
```

### Chat
```
Client → chat:join         { conversationId }
Client → chat:message      { conversationId, text }
Server → chat:message      { id, conversation_id, sender_id, text, created_at }
Client → chat:typing       { conversationId }
Server → chat:typing       { userId, username }
```

### Swipe
```
Client → swipe             { targetUserId, direction }   direction: 'left'|'right'|'super'
Server → swipe:match       { with: userId }  (mutual match)
```

### Presence
```
Server → presence          { userId, status }   status: 'online'|'offline'
```

---

## Project structure

```
chalk/
├── src/
│   ├── index.js              # Entry point, Express + Socket.io
│   ├── routes/
│   │   ├── auth.js           # Register, login, logout, me
│   │   ├── users.js          # Profiles, games, discovery
│   │   ├── friends.js        # Friend requests & management
│   │   ├── chats.js          # Conversations & messages
│   │   ├── calls.js          # Agora token + call logging
│   │   └── match.js          # Match history & ratings
│   ├── socket/
│   │   └── index.js          # All real-time logic
│   ├── services/
│   │   ├── supabase.js       # DB clients
│   │   └── matchmaking.js    # In-memory queue + algorithm
│   └── middleware/
│       └── auth.js           # JWT verification
├── supabase/
│   └── migrations/
│       └── 001_init.sql      # Full schema + RLS
├── .env.example
├── package.json
└── README.md
```

---

## Connecting the frontend

In your `chalk.html` (or a separate JS client):

```js
// 1. Login and save token
const { token } = await fetch('/api/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email, password })
}).then(r => r.json());

localStorage.setItem('chalk_token', token);

// 2. Connect socket
const socket = io('https://your-server.railway.app', {
  auth: { token }
});

// 3. Start matchmaking
socket.emit('match:join', {
  gameId: 'valorant',
  mode: 'solo',
  languages: ['ru', 'en'],
  region: 'eu',
  rankScore: 3,
});

// 4. When match found → get Agora token and join channel
socket.on('match:found', async ({ roomId }) => {
  const { token: agoraToken, appId } = await fetch('/api/calls/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${localStorage.getItem('chalk_token')}`,
    },
    body: JSON.stringify({ channelName: roomId }),
  }).then(r => r.json());

  // Join Agora channel for actual voice
  await agoraClient.join(appId, roomId, agoraToken, null);
  await agoraClient.publish([localAudioTrack]);
});

// 5. Vote to continue after 2-min trial
socket.emit('trial:vote', { roomId, vote: 'yes' });
socket.on('call:promoted', ({ roomId }) => {
  // Stay in Agora channel — call continues
});
```

---

## Environment variables reference

| Variable | Required | Description |
|----------|----------|-------------|
| `SUPABASE_URL` | ✅ | Your Supabase project URL |
| `SUPABASE_ANON_KEY` | ✅ | Public anon key |
| `SUPABASE_SERVICE_KEY` | ✅ | Secret service role key (server only) |
| `JWT_SECRET` | ✅ | Min 32-char random string |
| `AGORA_APP_ID` | ⚡ | Agora App ID (voice works without it in dev) |
| `AGORA_APP_CERTIFICATE` | ⚡ | Agora App Certificate |
| `PORT` | auto | Set by Railway automatically |
| `CLIENT_URL` | ✅ | Your frontend URL (for CORS) |
| `NODE_ENV` | — | `development` or `production` |
