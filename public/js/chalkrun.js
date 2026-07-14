// ── CHALK RUN — a Mario-style platformer mini-game ───────────────────────────
// The chalk auto-runs to the right; you jump onto floating boards and over
// gaps, grab power-up blocks that make you invincible (you glow gold) for a few
// seconds, and dodge (or, while invincible, smash) sponge enemies that erase
// chalk. Falling into a gap or touching a sponge un-powered ends the run.
// Score = distance + pickup bonuses. Shares the generic arcade score backend
// (/api/games/platformer/*) and the shared leaderboard UI.
(function () {
  const GAME = 'platformer';
  const W = 360; const H = 260;
  const GROUND_H = 28; const GROUND_Y = H - GROUND_H; // top surface of the ground
  const PLAYER_X = 64; const PW = 18; const PH = 26;
  const GRAVITY = 1800; const JUMP_V = -620;
  const BASE_SPEED = 150; const MAX_SPEED = 340;
  const INVULN_MS = 5000;
  const ENEMY_H = 22; const ENEMY_W = 22;
  const CHUNK = 130;

  let canvas; let ctx;
  let rafId = null; let lastTs = 0;
  let running = false; let paused = false; let gameOver = false; let scoreSaved = false;
  let bestScore = Number(localStorage.getItem('chalk_run_best') || 0);

  // Mutable world state, grouped so a test snapshot is trivial.
  const S = {
    camX: 0, speed: BASE_SPEED, py: GROUND_Y - PH, vy: 0, onGround: true,
    invulnUntil: 0, bonus: 0, score: 0,
    gaps: [], platforms: [], blocks: [], enemies: [],
    generatedUpTo: 0, lastWasGap: false,
  };

  function reset() {
    S.camX = 0; S.speed = BASE_SPEED; S.py = GROUND_Y - PH; S.vy = 0; S.onGround = true;
    S.invulnUntil = 0; S.bonus = 0; S.score = 0;
    S.gaps = []; S.platforms = []; S.blocks = []; S.enemies = [];
    S.generatedUpTo = W; S.lastWasGap = false; // first screen is safe ground
    generateAhead();
    gameOver = false; scoreSaved = false;
    updateScoreUI();
    hideResult();
    draw();
  }

  function generateAhead() {
    while (S.generatedUpTo < S.camX + W + 260) {
      const x = S.generatedUpTo;
      if (!S.lastWasGap && Math.random() < 0.22) {
        const gw = 46 + Math.floor(Math.random() * 26);
        S.gaps.push({ x0: x + 30, x1: x + 30 + gw });
        // a board to aim for on the far side of the gap
        if (Math.random() < 0.6) S.platforms.push({ x: x + 30 + gw + 6, y: GROUND_Y - (54 + Math.random() * 40), w: 64 });
        S.lastWasGap = true;
      } else {
        S.lastWasGap = false;
        if (Math.random() < 0.32) S.platforms.push({ x: x + 40, y: GROUND_Y - (70 + Math.random() * 55), w: 60 + Math.random() * 30 });
        if (Math.random() < 0.22) S.blocks.push({ x: x + 60, y: GROUND_Y - 98, taken: false });
        if (Math.random() < 0.25) S.enemies.push({ x: x + 60 + Math.random() * 50, y: GROUND_Y - ENEMY_H, w: ENEMY_W, h: ENEMY_H, alive: true });
      }
      S.generatedUpTo += CHUNK;
    }
    // cull anything well behind the camera so the arrays don't grow forever
    const cutoff = S.camX - 60;
    S.gaps = S.gaps.filter((g) => g.x1 > cutoff);
    S.platforms = S.platforms.filter((p) => p.x + p.w > cutoff);
    S.blocks = S.blocks.filter((b) => b.x + 20 > cutoff);
    S.enemies = S.enemies.filter((e) => e.x + e.w > cutoff);
  }

  // AABB overlap of two { x, y, w, h } rectangles.
  function overlap(a, b) {
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  }

  // Advance the simulation by dt seconds. Pure state mutation; the rAF loop and
  // the (localhost-only) test hook both call this.
  function advance(dt) {
    if (gameOver) return;
    S.speed = Math.min(MAX_SPEED, BASE_SPEED + S.score * 0.05);
    S.camX += S.speed * dt;
    generateAhead();

    const prevFeet = S.py + PH;
    S.vy += GRAVITY * dt;
    S.py += S.vy * dt;
    const feet = S.py + PH;
    const worldX = S.camX + PLAYER_X;
    const cx = worldX + PW / 2;

    // Landing is one-way for BOTH the ground and platforms: you only land on a
    // surface if your feet crossed it from above this frame. This is what makes
    // a gap lethal — once you walk off the edge and drop past ground level you
    // keep falling instead of snapping back up onto the far side.
    const overGap = S.gaps.some((g) => cx > g.x0 && cx < g.x1);
    let surface = Infinity;
    if (S.vy >= 0) {
      if (!overGap && prevFeet <= GROUND_Y + 12 && feet >= GROUND_Y) surface = GROUND_Y;
      for (const p of S.platforms) {
        if (cx > p.x && cx < p.x + p.w && prevFeet <= p.y + 10 && feet >= p.y) surface = Math.min(surface, p.y);
      }
    }
    S.onGround = false;
    if (Number.isFinite(surface)) { S.py = surface - PH; S.vy = 0; S.onGround = true; }

    // Fell into a gap / off the bottom.
    if (S.py + PH > H + 20) { end(); return; }

    const now = Date.now();
    const invuln = now < S.invulnUntil;
    const pbox = { x: worldX, y: S.py, w: PW, h: PH };

    // Power-up blocks.
    for (const b of S.blocks) {
      if (!b.taken && overlap(pbox, { x: b.x, y: b.y, w: 20, h: 20 })) {
        b.taken = true; S.invulnUntil = now + INVULN_MS; S.bonus += 50;
      }
    }
    // Enemies.
    for (const e of S.enemies) {
      if (e.alive && overlap(pbox, e)) {
        if (invuln) { e.alive = false; S.bonus += 100; }
        else { end(); return; }
      }
    }

    S.score = Math.floor(S.camX / 10) + S.bonus;
    updateScoreUI();
  }

  function jump() {
    if (!running || paused || gameOver) return;
    if (S.onGround) { S.vy = JUMP_V; S.onGround = false; }
  }

  // ── Loop ─────────────────────────────────────────────────────────────────────
  function loop(ts) {
    if (!running || paused || gameOver) { rafId = null; return; }
    const dtMs = lastTs ? Math.min(ts - lastTs, 60) : 16;
    lastTs = ts;
    advance(dtMs / 1000);
    draw();
    if (running && !paused && !gameOver) rafId = requestAnimationFrame(loop);
    else rafId = null;
  }
  function startLoop() { if (rafId) return; lastTs = 0; rafId = requestAnimationFrame(loop); }
  function stopLoop() { if (rafId) { cancelAnimationFrame(rafId); rafId = null; } }

  // ── Drawing ────────────────────────────────────────────────────────────────
  function sx(worldX) { return worldX - S.camX; }

  function draw() {
    if (!ctx) return;
    ctx.fillStyle = '#0f1420';
    ctx.fillRect(0, 0, W, H);
    // ground strip
    ctx.fillStyle = '#243b2f';
    ctx.fillRect(0, GROUND_Y, W, GROUND_H);
    ctx.fillStyle = '#2f4d3d';
    ctx.fillRect(0, GROUND_Y, W, 4);
    // carve gaps out of the ground
    ctx.fillStyle = '#0f1420';
    for (const g of S.gaps) {
      const x = sx(g.x0);
      if (x > W || x + (g.x1 - g.x0) < 0) continue;
      ctx.fillRect(x, GROUND_Y, g.x1 - g.x0, GROUND_H);
    }
    // platforms (chalk boards)
    for (const p of S.platforms) {
      const x = sx(p.x);
      if (x > W || x + p.w < 0) continue;
      ctx.fillStyle = '#c8b48a';
      roundRect(x, p.y, p.w, 10, 3); ctx.fill();
      ctx.fillStyle = 'rgba(0,0,0,0.18)';
      ctx.fillRect(x, p.y + 8, p.w, 2);
    }
    // power-up blocks
    for (const b of S.blocks) {
      if (b.taken) continue;
      const x = sx(b.x);
      if (x > W || x + 20 < 0) continue;
      ctx.fillStyle = '#fbbf24';
      roundRect(x, b.y, 20, 20, 4); ctx.fill();
      ctx.fillStyle = '#7c5807';
      ctx.font = 'bold 15px Inter, sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('?', x + 10, b.y + 11);
    }
    // enemies (sponges)
    for (const e of S.enemies) {
      if (!e.alive) continue;
      const x = sx(e.x);
      if (x > W || x + e.w < 0) continue;
      ctx.fillStyle = '#e8b44a';
      roundRect(x, e.y, e.w, e.h, 4); ctx.fill();
      ctx.fillStyle = '#1a1206';
      ctx.fillRect(x + 5, e.y + 7, 3, 3);
      ctx.fillRect(x + e.w - 8, e.y + 7, 3, 3);
      ctx.fillRect(x + 5, e.y + e.h - 6, e.w - 10, 2);
    }
    // player (chalk) — glows gold while invincible
    const invuln = Date.now() < S.invulnUntil;
    ctx.fillStyle = invuln ? '#fbbf24' : '#e8edf5';
    roundRect(PLAYER_X, S.py, PW, PH, 4); ctx.fill();
    ctx.fillStyle = invuln ? '#7c5807' : '#334155';
    ctx.fillRect(PLAYER_X + 4, S.py + 8, 3, 3);
    ctx.fillRect(PLAYER_X + PW - 7, S.py + 8, 3, 3);
  }

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function updateScoreUI() {
    const el = document.getElementById('chalkRunScore');
    if (el) el.textContent = S.score;
    const bestEl = document.getElementById('chalkRunBest');
    if (bestEl) bestEl.textContent = Math.max(bestScore, S.score);
    const powerEl = document.getElementById('chalkRunPower');
    if (powerEl) {
      const left = Math.ceil((S.invulnUntil - Date.now()) / 1000);
      powerEl.textContent = left > 0 ? `⭐ ${left}${T('unit_sec_short')}` : '—';
    }
  }

  // ── Overlays / result ───────────────────────────────────────────────────────
  function showOverlay(text, btnText) {
    const ov = document.getElementById('chalkRunOverlay');
    const txt = document.getElementById('chalkRunOverlayText');
    const btn = document.getElementById('chalkRunStartBtn');
    if (!ov) return;
    txt.textContent = text; btn.textContent = btnText;
    ov.classList.remove('hide');
  }
  function hideOverlay() { const ov = document.getElementById('chalkRunOverlay'); if (ov) ov.classList.add('hide'); }
  function hideResult() { const r = document.getElementById('chalkRunResult'); if (r) r.classList.add('hide'); }

  function end() {
    gameOver = true; running = false; stopLoop();
    if (S.score > bestScore) { bestScore = S.score; localStorage.setItem('chalk_run_best', String(bestScore)); }
    updateScoreUI(); draw();
    const resEl = document.getElementById('chalkRunResult');
    const scoreEl = document.getElementById('chalkRunResultScore');
    const rankEl = document.getElementById('chalkRunResultRank');
    if (scoreEl) scoreEl.textContent = S.score;
    if (rankEl) rankEl.textContent = T('games_saving_result');
    if (resEl) resEl.classList.remove('hide');
    hideOverlay();
    saveScoreAndRefresh(S.score, rankEl);
  }

  async function saveScoreAndRefresh(finalScore, rankEl) {
    if (scoreSaved) return;
    scoreSaved = true;
    try {
      const res = await api(`/api/games/${GAME}/score`, { method: 'POST', body: JSON.stringify({ score: finalScore }) });
      if (rankEl) {
        rankEl.innerHTML = `🏆 ${  T('rating_place_label')  } #${  res.rank  } ${  T('unit_from')  } ${  res.totalPlayers
          }<div class="tetris-result-best">${  T('games_record_colon')  } ${  res.bestScore  }</div>`;
      }
    } catch (e) {
      if (rankEl) rankEl.textContent = T('games_err_save_result');
    }
    loadLeaderboard();
  }

  async function loadLeaderboard() {
    const list = document.getElementById('chalkRunLeaderboardList');
    const myRankEl = document.getElementById('chalkRunMyRank');
    if (!list) return;
    try {
      const res = await api(`/api/games/${GAME}/leaderboard?limit=10`);
      const rows = (res.top || []).map((row) => {
        const isMe = currentUser && row.userId === currentUser.id;
        return `<div class="tetris-lb-row${  isMe ? ' me' : ''  }">` +
          `<span class="tetris-lb-rank">${  row.rank  }</span>` +
          `<span class="tetris-lb-ava">${  row.avatarEmoji || '🏃'  }</span>` +
          `<span class="tetris-lb-name">${  row.username  }</span>` +
          `<span class="tetris-lb-score">${  row.bestScore  }</span>` +
          `</div>`;
      });
      list.innerHTML = rows.length ? rows.join('') : `<div style="font-size:11px;color:var(--muted);padding:6px 2px">${  T('games_none_played')  } — ${  T('msg_be_first_excl')  }</div>`;
      if (myRankEl) {
        myRankEl.textContent = res.me ? (`${T('rating_your_place')  } #${  res.me.rank  } (${  res.me.bestScore  })`) : '';
      }
    } catch (e) {
      list.innerHTML = `<div style="font-size:11px;color:var(--muted);padding:6px 2px">${  T('rating_err_load')  }</div>`;
    }
  }

  // ── Public API ──────────────────────────────────────────────────────────────
  window.chalkRunResumeOrStart = function () {
    if (!canvas) { canvas = document.getElementById('chalkRunCanvas'); ctx = canvas.getContext('2d'); }
    if (gameOver || !running) reset();
    running = true; paused = false;
    hideOverlay(); hideResult();
    startLoop();
  };

  window.openChalkRunModal = function () {
    const modal = document.getElementById('chalkRunModal');
    if (!modal) return;
    modal.classList.add('show');
    const pill = document.getElementById('chalkRunSearchPill');
    if (pill) pill.style.display = (typeof isSearching !== 'undefined' && isSearching) ? 'inline-flex' : 'none';
    if (!canvas) { canvas = document.getElementById('chalkRunCanvas'); ctx = canvas.getContext('2d'); reset(); }
    loadLeaderboard();
    updateScoreUI();
    if (!running) showOverlay(gameOver ? T('games_over') : T('match_ready_q'), gameOver ? T('btn_play_again') : T('games_start'));
  };

  window.closeChalkRunModal = function () {
    const modal = document.getElementById('chalkRunModal');
    if (modal) modal.classList.remove('show');
    paused = true; stopLoop();
  };

  window.chalkRunJump = function () { jump(); };

  document.addEventListener('keydown', (e) => {
    const modal = document.getElementById('chalkRunModal');
    if (!modal || !modal.classList.contains('show')) return;
    if (e.key === 'Escape') { window.closeChalkRunModal(); return; }
    if (e.key === ' ' || e.key === 'ArrowUp' || e.key === 'Spacebar') { e.preventDefault(); jump(); }
  });

  // Deterministic test hook (localhost only) — lets the dev harness step the
  // physics without a visible tab (requestAnimationFrame is paused when hidden).
  if (/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)) {
    window.__chalkRunTest = {
      state: S,
      advance: (dtSec) => advance(dtSec),
      jump: () => { running = true; jump(); },
      start: () => { if (!canvas) { canvas = document.getElementById('chalkRunCanvas'); ctx = canvas.getContext('2d'); } reset(); running = true; paused = false; gameOver = false; },
      isGameOver: () => gameOver,
      draw: () => draw(),
      snapshot: () => ({ score: S.score, camX: Math.round(S.camX), py: Math.round(S.py), vy: Math.round(S.vy), onGround: S.onGround, invulnMs: Math.max(0, S.invulnUntil - Date.now()), gameOver, enemies: S.enemies.filter((e) => e.alive).length }),
    };
  }
})();
