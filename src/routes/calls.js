const router  = require('express').Router();
const { v4: uuid } = require('uuid');
const { requireAuth } = require('../middleware/auth');
const { supabaseAdmin } = require('../services/supabase');

// NOTE: Agora RTC tokens are issued by /api/agora/token (see routes/agora.js),
// which handles the UUID -> numeric-uid hashing the client needs. This file
// only logs call lifecycle events to the `calls` table.

// ── POST /api/calls/start ──────────────────────────────────────────────────
// Logs a call start in the DB
router.post('/start', requireAuth, async (req, res) => {
  const { roomId, participants, mode } = req.body;

  const { data, error } = await supabaseAdmin.from('calls').insert({
    id: roomId || uuid(),
    initiated_by: req.user.id,
    participants: participants || [req.user.id],
    mode: mode || 'solo',
    started_at: new Date().toISOString(),
    status: 'active',
  }).select().single();

  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json({ call: data });
});

// ── PATCH /api/calls/:id/end ───────────────────────────────────────────────
router.patch('/:id/end', requireAuth, async (req, res) => {
  const { duration_seconds } = req.body;

  const { error } = await supabaseAdmin.from('calls').update({
    ended_at: new Date().toISOString(),
    duration_seconds: duration_seconds || null,
    status: 'ended',
  }).eq('id', req.params.id);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

module.exports = router;
