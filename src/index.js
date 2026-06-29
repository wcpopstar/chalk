require('dotenv').config();
const express    = require('express');
const http       = require('http');
const path       = require('path');
const { Server } = require('socket.io');
const helmet     = require('helmet');
const cors       = require('cors');
const rateLimit  = require('express-rate-limit');

const authRoutes    = require('./routes/auth');
const userRoutes    = require('./routes/users');
const matchRoutes   = require('./routes/match');
const friendRoutes  = require('./routes/friends');
const callRoutes    = require('./routes/calls');
const chatRoutes    = require('./routes/chats');
const agoraRoutes = require('./routes/agora');

const { initSocket } = require('./socket');

const app    = express();
app.set('trust proxy', 1);
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: process.env.CLIENT_URL || '*', methods: ['GET', 'POST'], credentials: true },
  transports: ['websocket', 'polling'],
});

initSocket(io);

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: process.env.CLIENT_URL || '*', credentials: true }));
app.use(express.json({ limit: '2mb' }));
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 200, standardHeaders: true, legacyHeaders: false }));

app.get('/health', (_req, res) => res.json({ status: 'ok', ts: Date.now() }));

app.use('/api/auth',    authRoutes);
app.use('/api/users',   userRoutes);
app.use('/api/match',   matchRoutes);
app.use('/api/friends', friendRoutes);
app.use('/api/calls',   callRoutes);
app.use('/api/chats',   chatRoutes);
app.use('/api/agora', agoraRoutes);


app.use(express.static(path.join(__dirname, '../public')));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, '../public/index.html')));

app.use((_req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, _req, res, _next) => {
  console.error('[ERROR]', err);
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🎮 Chalk backend running on port ${PORT}`);
  console.log(`   ENV: ${process.env.NODE_ENV || 'development'}\n`);
});

module.exports = { app, io };