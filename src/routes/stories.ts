import type { Request, Response } from 'express';
const router = require('express').Router();
const { v4: uuid } = require('uuid');
const { requireAuth } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { uuidParam } = require('../validation/common');
const { userLimiter } = require('../middleware/rateLimit');
const { createStorySchema } = require('../validation/storySchemas');
import { supabaseAdmin } from '../services/supabase';

// Posting a story writes a row (+ a fairly large image payload), so keep it
// tighter; reading the feed is polled as the app is used, so keep it loose.
const postLimiter = userLimiter({ windowMs: 10 * 60 * 1000, max: 20, message: 'Слишком много историй, подожди немного.' });
const readLimiter = userLimiter({ windowMs: 60 * 1000, max: 90, message: 'Слишком много запросов, подожди немного.' });

const STORY_TTL_MS = 24 * 60 * 60 * 1000; // stories live 24h, Instagram/Telegram-style

// ── The set of user ids whose stories the current user may see: themselves
// plus everyone they're accepted friends with. Shared by the feed (which
// users to fetch) and the view/read guard (whether a given story is visible).
async function visibleAuthorIds(uid: string): Promise<Set<string>> {
  const { data: friendRows } = await supabaseAdmin
    .from('friends')
    .select('user_a, user_b')
    .or(`user_a.eq.${uid},user_b.eq.${uid}`)
    .eq('status', 'accepted');
  const ids = new Set<string>([uid]);
  (friendRows || []).forEach((r: { user_a: string; user_b: string }) => {
    ids.add(r.user_a === uid ? r.user_b : r.user_a);
  });
  return ids;
}

/**
 * @openapi
 * /api/stories:
 *   post:
 *     tags: [Stories]
 *     summary: Post a story (visible to friends for 24h)
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [image]
 *             properties:
 *               image: { type: string, description: 'Resized-JPEG data URL' }
 *               caption: { type: string, nullable: true, maxLength: 200 }
 *     responses:
 *       201: { description: Story created }
 */
router.post('/', requireAuth, postLimiter, validate({ body: createStorySchema }), async (req: Request, res: Response) => {
  const { image, caption } = req.body;
  const now = new Date();
  const { data, error } = await supabaseAdmin
    .from('stories')
    .insert({
      id: uuid(),
      user_id: req.user.id,
      image_url: image,
      caption: caption || null,
      created_at: now.toISOString(),
      expires_at: new Date(now.getTime() + STORY_TTL_MS).toISOString(),
    })
    .select('id, caption, created_at, expires_at')
    .single();
  if (error) return res.status(500).json({ error: error.message });
  return res.status(201).json({ story: data });
});

/**
 * @openapi
 * /api/stories:
 *   get:
 *     tags: [Stories]
 *     summary: Active stories from the current user and their friends, grouped by author
 *     responses:
 *       200: { description: OK }
 */
router.get('/', requireAuth, readLimiter, async (req: Request, res: Response) => {
  const uid = req.user.id;
  const authorIds = await visibleAuthorIds(uid);
  const nowIso = new Date().toISOString();

  const { data: rows, error } = await supabaseAdmin
    .from('stories')
    .select('id, user_id, image_url, caption, created_at, expires_at, author:users!stories_user_id_fkey ( id, username, avatar_emoji, avatar_url, status_text )')
    .in('user_id', Array.from(authorIds))
    .gt('expires_at', nowIso)
    .order('created_at', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });

  // Which of these stories the viewer has already opened — for the "seen"
  // ring (a grey ring once every story of an author has been viewed).
  const storyIds = (rows || []).map((r) => r.id);
  const viewed = new Set<string>();
  if (storyIds.length) {
    const { data: viewRows } = await supabaseAdmin
      .from('story_views')
      .select('story_id')
      .eq('viewer_id', uid)
      .in('story_id', storyIds);
    (viewRows || []).forEach((v: { story_id: string }) => viewed.add(v.story_id));
  }

  // Group by author, preserving created_at order within each group. The
  // current user's own stories are surfaced as a separate `me` block so the
  // client can render the "Your story" tile first.
  const groups: Record<string, any> = {};
  (rows || []).forEach((r) => {
    const g = groups[r.user_id] || (groups[r.user_id] = { user: r.author, stories: [], all_viewed: true });
    const isViewed = viewed.has(r.id);
    if (!isViewed && r.user_id !== uid) g.all_viewed = false;
    g.stories.push({ id: r.id, image_url: r.image_url, caption: r.caption, created_at: r.created_at, viewed: isViewed });
  });

  const mine = groups[uid] || null;
  const friends = Object.keys(groups)
    .filter((id) => id !== uid)
    .map((id) => groups[id]);

  return res.json({ me: mine, friends });
});

/**
 * @openapi
 * /api/stories/{id}/view:
 *   post:
 *     tags: [Stories]
 *     summary: Mark a story as seen by the current user
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200: { description: OK }
 */
router.post('/:id/view', requireAuth, readLimiter, validate({ params: uuidParam() }), async (req: Request, res: Response) => {
  const uid = req.user.id;
  const storyId = req.params.id!;

  // Only record a view for a story the viewer is actually allowed to see.
  const { data: story } = await supabaseAdmin
    .from('stories')
    .select('user_id')
    .eq('id', storyId)
    .maybeSingle();
  if (!story) return res.status(404).json({ error: 'История не найдена' });
  const authorIds = await visibleAuthorIds(uid);
  if (!authorIds.has(story.user_id)) return res.status(403).json({ error: 'Нет доступа к этой истории' });

  await supabaseAdmin
    .from('story_views')
    .upsert({ story_id: storyId, viewer_id: uid, created_at: new Date().toISOString() }, { onConflict: 'story_id,viewer_id' });
  return res.json({ ok: true });
});

/**
 * @openapi
 * /api/stories/{id}:
 *   delete:
 *     tags: [Stories]
 *     summary: Delete one of the current user's own stories
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200: { description: Deleted }
 */
router.delete('/:id', requireAuth, postLimiter, validate({ params: uuidParam() }), async (req: Request, res: Response) => {
  const { error } = await supabaseAdmin
    .from('stories')
    .delete()
    .eq('id', req.params.id!)
    .eq('user_id', req.user.id);
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ ok: true });
});

export = router;
