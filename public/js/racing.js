// ── F1 RACING MINI-GAME (modal, plays while searching for a match) ───────────
// Endless lane-based racer: your car sits near the bottom, oncoming cars fall
// from the top, you dodge left/right. Speed and spawn rate ramp up the longer
// you survive; score is distance travelled. Shares the generic arcade score
// backend (/api/games/racing/*) and mirrors tetris.js's leaderboard UI.
(function () {
  const GAME = 'racing';
  const W = 180; const H = 360;
  const LANES = 3;
  const LANE_W = W / LANES;
  const CAR_H = 46;
  const PLAYER_Y = H - CAR_H - 12;

  let canvas; let ctx;
  let running = false; let paused = false; let gameOver = false; let scoreSaved = false;
  let rafId = null; let lastTs = 0;
  let playerLane = 1;
  let enemies = [];       // { lane, y }
  let roadOffset = 0;
  let speed = 0;          // px/sec the world scrolls down
  let spawnAcc = 0;       // ms accumulator for spawning
  let spawnEvery = 1400;  // ms between spawns (shrinks over time)
  let score = 0;          // distance, integer "metres"
  let elapsed = 0;        // ms survived
  let bestScore = Number(localStorage.getItem('chalk_racing_best') || 0);

  const BASE_SPEED = 150; const MAX_SPEED = 460;
  const MIN_SPAWN = 520;
  const ENEMY_COLORS = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#3b82f6', '#a855f7'];

  function laneCenterX(lane) { return lane * LANE_W + LANE_W / 2; }

  function resetGame() {
    running = false;
    paused = false;
    gameOver = false;
    scoreSaved = false;
    playerLane = 1;
    enemies = [];
    roadOffset = 0;
    speed = BASE_SPEED;
    spawnAcc = 0;
    spawnEvery = 1400;
    score = 0;
    elapsed = 0;
    updateScoreUI();
    hideResult();
  }

  function spawnEnemy() {
    // Avoid spawning a wall across every lane at once — leave at least one gap.
    const occupiedTop = enemies.filter((e) => e.y < CAR_H).map((e) => e.lane);
    let lane = Math.floor(Math.random() * LANES);
    let tries = 0;
    while (occupiedTop.indexOf(lane) !== -1 && tries < LANES) { lane = (lane + 1) % LANES; tries++; }
    enemies.push({ lane, y: -CAR_H, color: ENEMY_COLORS[Math.floor(Math.random() * ENEMY_COLORS.length)] });
  }

  function collides() {
    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i];
      if (e.lane !== playerLane) continue;
      // rectangle overlap on the Y axis (same lane ⇒ X already overlaps)
      if (e.y + CAR_H > PLAYER_Y && e.y < PLAYER_Y + CAR_H) return true;
    }
    return false;
  }

  function tick(dtMs) {
    if (!running || paused || gameOver) return;
    const dt = dtMs / 1000;
    elapsed += dtMs;

    // Ramp difficulty: speed climbs with distance, spawns get more frequent.
    speed = Math.min(MAX_SPEED, BASE_SPEED + score * 0.08);
    spawnEvery = Math.max(MIN_SPAWN, 1400 - score * 0.9);

    roadOffset = (roadOffset + speed * dt) % 40;
    score += speed * dt * 0.1;

    for (let i = 0; i < enemies.length; i++) enemies[i].y += speed * dt;
    enemies = enemies.filter((e) => e.y < H + CAR_H);

    spawnAcc += dtMs;
    if (spawnAcc >= spawnEvery) { spawnAcc = 0; spawnEnemy(); }

    if (collides()) { onGameOver(); return; }

    updateScoreUI();
  }

  function loop(ts) {
    if (!running || paused || gameOver) { rafId = null; return; }
    const dtMs = lastTs ? Math.min(ts - lastTs, 60) : 16;
    lastTs = ts;
    tick(dtMs);
    draw();
    if (running && !paused && !gameOver) rafId = requestAnimationFrame(loop);
    else rafId = null;
  }

  function startLoop() {
    if (rafId) return;
    lastTs = 0;
    rafId = requestAnimationFrame(loop);
  }
  function stopLoop() {
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
  }

  // ── Drawing ────────────────────────────────────────────────────────────────
  // Top-down open-wheel racer: narrow pointed body, front/rear wings, four
  // wheels sticking out, a cockpit. Player faces up; oncoming cars face down.
  function drawCar(cx, y, color, isPlayer) {
    const noseUp = isPlayer;
    const bodyW = 13; const half = bodyW / 2;
    const top = y; const bot = y + CAR_H;

    // wheels (drawn first, under the body)
    ctx.fillStyle = '#0b0f18';
    const ww = 5; const wh = 12;
    const lx = cx - half - ww + 1; const rx = cx + half - 1;
    [10, CAR_H - 10 - wh].forEach((wy) => {
      roundRect(lx, y + wy, ww, wh, 2); ctx.fill();
      roundRect(rx, y + wy, ww, wh, 2); ctx.fill();
    });

    // front + rear wings (dark bars wider than the body)
    ctx.fillStyle = '#0b0f18';
    const rearWingY = noseUp ? bot - 7 : top + 3;
    const frontWingY = noseUp ? top + 2 : bot - 5;
    ctx.fillRect(cx - (bodyW + 10) / 2, rearWingY, bodyW + 10, 4);
    ctx.fillRect(cx - (bodyW + 4) / 2, frontWingY, bodyW + 4, 3);

    // tapered body with a pointed nose
    const noseY = noseUp ? top + 4 : bot - 4;
    const shoulderY = noseUp ? top + 15 : bot - 15;
    const tailY = noseUp ? bot - 6 : top + 6;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(cx, noseY);
    ctx.lineTo(cx - half, shoulderY);
    ctx.lineTo(cx - half, tailY);
    ctx.lineTo(cx + half, tailY);
    ctx.lineTo(cx + half, shoulderY);
    ctx.closePath();
    ctx.fill();

    // cockpit / helmet
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.beginPath();
    ctx.arc(cx, y + CAR_H / 2, 3.5, 0, Math.PI * 2);
    ctx.fill();
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

  function draw() {
    if (!ctx) return;
    // asphalt
    ctx.fillStyle = '#1b1e27';
    ctx.fillRect(0, 0, W, H);
    // lane dividers (dashed, scrolling)
    ctx.strokeStyle = 'rgba(255,255,255,0.28)';
    ctx.lineWidth = 3;
    ctx.setLineDash([16, 24]);
    ctx.lineDashOffset = -roadOffset;
    for (let l = 1; l < LANES; l++) {
      const x = l * LANE_W;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, H);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    // edge lines
    ctx.strokeStyle = 'rgba(255,255,255,0.4)';
    ctx.lineWidth = 4;
    ctx.beginPath(); ctx.moveTo(2, 0); ctx.lineTo(2, H); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(W - 2, 0); ctx.lineTo(W - 2, H); ctx.stroke();

    for (let i = 0; i < enemies.length; i++) drawCar(laneCenterX(enemies[i].lane), enemies[i].y, enemies[i].color, false);
    if (!gameOver) drawCar(laneCenterX(playerLane), PLAYER_Y, '#22d3ee', true);
  }

  function updateScoreUI() {
    const s = Math.floor(score);
    const el = document.getElementById('racingScore');
    if (el) el.textContent = s;
    const bestEl = document.getElementById('racingBest');
    if (bestEl) bestEl.textContent = Math.max(bestScore, s);
    const spdEl = document.getElementById('racingSpeed');
    if (spdEl) spdEl.textContent = Math.round(speed);
  }

  // ── Controls ────────────────────────────────────────────────────────────────
  function moveLane(dir) {
    if (!running || paused || gameOver) return;
    const next = playerLane + dir;
    if (next < 0 || next >= LANES) return;
    playerLane = next;
    draw();
  }

  // ── Overlays / result ───────────────────────────────────────────────────────
  function showOverlay(text, btnText) {
    const ov = document.getElementById('racingOverlay');
    const txt = document.getElementById('racingOverlayText');
    const btn = document.getElementById('racingStartBtn');
    if (!ov) return;
    txt.textContent = text;
    btn.textContent = btnText;
    ov.classList.remove('hide');
  }
  function hideOverlay() {
    const ov = document.getElementById('racingOverlay');
    if (ov) ov.classList.add('hide');
  }
  function hideResult() {
    const r = document.getElementById('racingResult');
    if (r) r.classList.add('hide');
  }

  function onGameOver() {
    gameOver = true;
    running = false;
    stopLoop();
    const finalScore = Math.floor(score);
    if (finalScore > bestScore) {
      bestScore = finalScore;
      localStorage.setItem('chalk_racing_best', String(bestScore));
    }
    updateScoreUI();
    draw();
    const resEl = document.getElementById('racingResult');
    const scoreEl = document.getElementById('racingResultScore');
    const rankEl = document.getElementById('racingResultRank');
    if (scoreEl) scoreEl.textContent = finalScore;
    if (rankEl) rankEl.textContent = T('games_saving_result');
    if (resEl) resEl.classList.remove('hide');
    hideOverlay();
    saveScoreAndRefresh(finalScore, rankEl);
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
    const list = document.getElementById('racingLeaderboardList');
    const myRankEl = document.getElementById('racingMyRank');
    if (!list) return;
    try {
      const res = await api(`/api/games/${GAME}/leaderboard?limit=10`);
      const rows = (res.top || []).map((row) => {
        const isMe = currentUser && row.userId === currentUser.id;
        return `<div class="tetris-lb-row${  isMe ? ' me' : ''  }">` +
          `<span class="tetris-lb-rank">${  row.rank  }</span>` +
          `<span class="tetris-lb-ava">${  row.avatarEmoji || '🏎️'  }</span>` +
          `<span class="tetris-lb-name">${  row.username  }</span>` +
          `<span class="tetris-lb-score">${  row.bestScore  }</span>` +
          `</div>`;
      });
      list.innerHTML = rows.length ? rows.join('') : `<div style="font-size:11px;color:var(--muted);padding:6px 2px">${  T('games_none_played')  } — ${  T('msg_be_first_excl')  }</div>`;
      if (myRankEl) {
        myRankEl.textContent = res.me ? (`${T('rating_your_place')  } #${  res.me.rank  } (${  res.me.bestScore  } ${  T('unit_points_dot')  })`) : '';
      }
    } catch (e) {
      list.innerHTML = `<div style="font-size:11px;color:var(--muted);padding:6px 2px">${  T('rating_err_load')  }</div>`;
    }
  }

  // ── Public API ──────────────────────────────────────────────────────────────
  window.racingResumeOrStart = function () {
    if (!canvas) {
      canvas = document.getElementById('racingCanvas');
      ctx = canvas.getContext('2d');
    }
    if (gameOver || !running && score === 0) resetGame();
    running = true;
    paused = false;
    hideOverlay();
    hideResult();
    startLoop();
  };

  window.racingPause = function () {
    if (!running) return;
    paused = true;
    stopLoop();
    showOverlay(T('games_pause'), T('btn_continue'));
  };

  window.openRacingModal = function () {
    const modal = document.getElementById('racingModal');
    if (!modal) return;
    modal.classList.add('show');
    const pill = document.getElementById('racingModalSearchPill');
    if (pill) pill.style.display = (typeof isSearching !== 'undefined' && isSearching) ? 'inline-flex' : 'none';
    if (!canvas) {
      canvas = document.getElementById('racingCanvas');
      ctx = canvas.getContext('2d');
      resetGame();
      draw();
    }
    loadLeaderboard();
    updateScoreUI();
    if (!running) showOverlay(gameOver ? T('games_over') : T('match_ready_q'), gameOver ? T('btn_play_again') : T('games_start'));
  };

  window.closeRacingModal = function () {
    const modal = document.getElementById('racingModal');
    if (modal) modal.classList.remove('show');
    window.racingPause();
  };

  // Touch / mouse: tap-and-hold not needed (lane hops are discrete), a single
  // press per lane change matches how a phone player expects it to feel.
  window.racingMove = function (dir) { moveLane(dir === 'left' ? -1 : 1); };

  // ── Keyboard (only while the racing modal is open) ──────────────────────────
  document.addEventListener('keydown', (e) => {
    const modal = document.getElementById('racingModal');
    if (!modal || !modal.classList.contains('show')) return;
    if (e.key === 'Escape') { window.closeRacingModal(); return; }
    if (!running || paused || gameOver) return;
    if (e.key === 'ArrowLeft') { e.preventDefault(); moveLane(-1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); moveLane(1); }
  });

  // ── GAMES HUB (picker shown from the "play while searching" button) ─────────
  window.openGamesHub = function () {
    const modal = document.getElementById('gamesHubModal');
    if (!modal) return;
    const pill = document.getElementById('gamesHubSearchPill');
    if (pill) pill.style.display = (typeof isSearching !== 'undefined' && isSearching) ? 'inline-flex' : 'none';
    modal.classList.add('show');
  };
  window.closeGamesHub = function () {
    const modal = document.getElementById('gamesHubModal');
    if (modal) modal.classList.remove('show');
  };
})();
