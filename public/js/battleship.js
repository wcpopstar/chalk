// ── BATTLESHIP MINI-GAME (single-player accuracy hunt) ───────────────────────
// An 8×8 board hides a fleet; you fire at cells to sink every ship in as few
// shots as possible. Score rewards accuracy: totalShipCells / shots × 1000, so
// a perfect no-miss game = 1000. Shares the generic arcade score backend
// (/api/games/battleship/*) and the shared leaderboard UI.
(function () {
  const GAME = 'battleship';
  const SIZE = 8;
  const FLEET = [4, 3, 3, 2]; // ship lengths → 12 target cells
  const TOTAL_CELLS = FLEET.reduce((a, b) => a + b, 0);

  let grid = null;   // SIZE×SIZE of { ship: index|-1, fired: bool }
  let ships = null;  // [{ cells:[[r,c]], size, hits }]
  let shots = 0; let hits = 0;
  let running = false; let gameOver = false; let scoreSaved = false;
  let bestScore = Number(localStorage.getItem('chalk_battleship_best') || 0);

  function makeGrid() {
    grid = [];
    for (let r = 0; r < SIZE; r++) {
      const row = [];
      for (let c = 0; c < SIZE; c++) row.push({ ship: -1, fired: false });
      grid.push(row);
    }
  }

  function canPlace(cells) {
    return cells.every(([r, c]) => r >= 0 && r < SIZE && c >= 0 && c < SIZE && grid[r][c].ship === -1);
  }

  function placeFleet() {
    ships = [];
    FLEET.forEach((size, idx) => {
      let placed = false; let guard = 0;
      while (!placed && guard++ < 500) {
        const horiz = Math.random() < 0.5;
        const r0 = Math.floor(Math.random() * SIZE);
        const c0 = Math.floor(Math.random() * SIZE);
        const cells = [];
        for (let k = 0; k < size; k++) cells.push(horiz ? [r0, c0 + k] : [r0 + k, c0]);
        if (!canPlace(cells)) continue;
        cells.forEach(([r, c]) => { grid[r][c].ship = idx; });
        ships.push({ cells, size, hits: 0 });
        placed = true;
      }
    });
  }

  function resetGame() {
    makeGrid();
    placeFleet();
    shots = 0; hits = 0;
    gameOver = false; scoreSaved = false;
    updateScoreUI();
    hideResult();
    render();
  }

  function shipsRemaining() { return ships.filter((s) => s.hits < s.size).length; }

  function fire(r, c) {
    if (!running || gameOver) return;
    const cell = grid[r][c];
    if (cell.fired) return;
    cell.fired = true;
    shots++;
    if (cell.ship !== -1) {
      hits++;
      const ship = ships[cell.ship];
      ship.hits++;
      if (ship.hits === ship.size) ship.sunk = true;
    }
    // Repaint just the affected cell(s) rather than rebuilding the whole
    // board — a full innerHTML rewrite on every shot is wasteful and drops
    // hover state. When a ship sinks, all of its cells change to the sunk look.
    if (cell.ship !== -1 && ships[cell.ship].sunk) ships[cell.ship].cells.forEach(([sr, sc]) => paintCell(sr, sc));
    else paintCell(r, c);
    updateScoreUI();
    if (hits >= TOTAL_CELLS) onWin();
  }

  function currentScore() {
    if (!shots) return 0;
    return Math.round((TOTAL_CELLS / shots) * 1000);
  }

  // ── Rendering ────────────────────────────────────────────────────────────────
  function render() {
    const el = document.getElementById('battleshipBoard');
    if (!el) return;
    let html = '';
    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        const cell = grid[r][c];
        let cls = 'bs-cell';
        let mark = '';
        if (cell.fired) {
          if (cell.ship !== -1) {
            const { sunk } = ships[cell.ship];
            cls += sunk ? ' bs-sunk' : ' bs-hit';
            mark = sunk ? '🔥' : '✕';
          } else { cls += ' bs-miss'; mark = '•'; }
        }
        html += `<button class="${cls}" data-r="${r}" data-c="${c}"${cell.fired ? ' disabled' : ''}>${mark}</button>`;
      }
    }
    el.innerHTML = html;
  }

  function paintCell(r, c) {
    const btn = document.querySelector(`#battleshipBoard .bs-cell[data-r="${r}"][data-c="${c}"]`);
    if (!btn) return;
    const cell = grid[r][c];
    btn.className = 'bs-cell';
    btn.textContent = '';
    btn.disabled = false;
    if (cell.fired) {
      btn.disabled = true;
      if (cell.ship !== -1) {
        const { sunk } = ships[cell.ship];
        btn.classList.add(sunk ? 'bs-sunk' : 'bs-hit');
        btn.textContent = sunk ? '🔥' : '✕';
      } else { btn.classList.add('bs-miss'); btn.textContent = '•'; }
    }
  }

  function updateScoreUI() {
    const shotsEl = document.getElementById('battleshipShots');
    if (shotsEl) shotsEl.textContent = shots;
    const shipsEl = document.getElementById('battleshipShipsLeft');
    if (shipsEl) shipsEl.textContent = ships ? shipsRemaining() : FLEET.length;
    const bestEl = document.getElementById('battleshipBest');
    if (bestEl) bestEl.textContent = Math.max(bestScore, currentScore());
  }

  // ── Overlays / result ───────────────────────────────────────────────────────
  function showOverlay(text, btnText) {
    const ov = document.getElementById('battleshipOverlay');
    const txt = document.getElementById('battleshipOverlayText');
    const btn = document.getElementById('battleshipStartBtn');
    if (!ov) return;
    txt.textContent = text;
    btn.textContent = btnText;
    ov.classList.remove('hide');
  }
  function hideOverlay() { const ov = document.getElementById('battleshipOverlay'); if (ov) ov.classList.add('hide'); }
  function hideResult() { const r = document.getElementById('battleshipResult'); if (r) r.classList.add('hide'); }

  function onWin() {
    gameOver = true;
    running = false;
    const finalScore = currentScore();
    if (finalScore > bestScore) { bestScore = finalScore; localStorage.setItem('chalk_battleship_best', String(bestScore)); }
    updateScoreUI();
    const resEl = document.getElementById('battleshipResult');
    const scoreEl = document.getElementById('battleshipResultScore');
    const subEl = document.getElementById('battleshipResultSub');
    const rankEl = document.getElementById('battleshipResultRank');
    if (scoreEl) scoreEl.textContent = finalScore;
    if (subEl) subEl.textContent = `${T('game_bs_shots')}: ${shots} · ${T('game_bs_accuracy')}: ${Math.round((hits / shots) * 100)}%`;
    if (rankEl) rankEl.textContent = T('games_saving_result');
    if (resEl) resEl.classList.remove('hide');
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
    const list = document.getElementById('battleshipLeaderboardList');
    const myRankEl = document.getElementById('battleshipMyRank');
    if (!list) return;
    try {
      const res = await api(`/api/games/${GAME}/leaderboard?limit=10`);
      const rows = (res.top || []).map((row) => {
        const isMe = currentUser && row.userId === currentUser.id;
        return `<div class="tetris-lb-row${  isMe ? ' me' : ''  }">` +
          `<span class="tetris-lb-rank">${  row.rank  }</span>` +
          `<span class="tetris-lb-ava">${  row.avatarEmoji || '🚢'  }</span>` +
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
  window.battleshipResumeOrStart = function () {
    resetGame();
    running = true;
    gameOver = false;
    hideOverlay();
    hideResult();
    render();
  };

  window.openBattleshipModal = function () {
    const modal = document.getElementById('battleshipModal');
    if (!modal) return;
    modal.classList.add('show');
    const pill = document.getElementById('battleshipSearchPill');
    if (pill) pill.style.display = (typeof isSearching !== 'undefined' && isSearching) ? 'inline-flex' : 'none';
    if (!grid) resetGame();
    const board = document.getElementById('battleshipBoard');
    if (board && !board.dataset.bound) {
      board.addEventListener('click', (e) => {
        const btn = e.target.closest('.bs-cell');
        if (!btn || btn.disabled) return;
        fire(Number(btn.dataset.r), Number(btn.dataset.c));
      });
      board.dataset.bound = '1';
    }
    loadLeaderboard();
    updateScoreUI();
    if (!running) showOverlay(gameOver ? T('games_over') : T('match_ready_q'), gameOver ? T('btn_play_again') : T('games_start'));
  };

  window.closeBattleshipModal = function () {
    const modal = document.getElementById('battleshipModal');
    if (modal) modal.classList.remove('show');
  };

  document.addEventListener('keydown', (e) => {
    const modal = document.getElementById('battleshipModal');
    if (!modal || !modal.classList.contains('show')) return;
    if (e.key === 'Escape') window.closeBattleshipModal();
  });
})();
