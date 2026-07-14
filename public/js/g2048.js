// ── 2048 MINI-GAME (modal, plays while searching for a match) ────────────────
// Classic 4×4 slide-and-merge. Arrow keys / on-screen buttons / swipe move all
// tiles; equal tiles merge and their sum is added to the score. Shares the
// generic arcade score backend (/api/games/g2048/*) and mirrors the tetris /
// racing leaderboard UI.
(function () {
  const GAME = 'g2048';
  const SIZE = 4;

  let board = null;       // SIZE×SIZE array of numbers (0 = empty)
  let score = 0;
  let running = false; let gameOver = false; let won = false; let scoreSaved = false;
  let bestScore = Number(localStorage.getItem('chalk_2048_best') || 0);

  function emptyBoard() {
    const b = [];
    for (let r = 0; r < SIZE; r++) b.push(new Array(SIZE).fill(0));
    return b;
  }

  function emptyCells() {
    const cells = [];
    for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) if (!board[r][c]) cells.push([r, c]);
    return cells;
  }

  function spawnTile() {
    const cells = emptyCells();
    if (!cells.length) return;
    const [r, c] = cells[Math.floor(Math.random() * cells.length)];
    board[r][c] = Math.random() < 0.9 ? 2 : 4;
    return [r, c];
  }

  function resetGame() {
    board = emptyBoard();
    score = 0;
    gameOver = false;
    won = false;
    scoreSaved = false;
    spawnTile();
    spawnTile();
    updateScoreUI();
    hideResult();
    render([]);
  }

  // Slide + merge one row toward index 0. Returns { row, gained }.
  function slide(row) {
    const nums = row.filter((v) => v);
    let gained = 0;
    for (let i = 0; i < nums.length - 1; i++) {
      if (nums[i] === nums[i + 1]) {
        nums[i] *= 2;
        gained += nums[i];
        if (nums[i] === 2048) won = true;
        nums.splice(i + 1, 1);
      }
    }
    while (nums.length < SIZE) nums.push(0);
    return { row: nums, gained };
  }

  function getRow(b, i) { return b[i].slice(); }
  function getCol(b, i) { const col = []; for (let r = 0; r < SIZE; r++) col.push(b[r][i]); return col; }
  function setRow(b, i, row) { b[i] = row; }
  function setCol(b, i, col) { for (let r = 0; r < SIZE; r++) b[r][i] = col[r]; }

  // dir: 'left' | 'right' | 'up' | 'down'. Returns the new tiles' coords for a
  // spawn-pop animation, or null if nothing moved.
  function applyMove(dir) {
    const before = JSON.stringify(board);
    const horizontal = dir === 'left' || dir === 'right';
    const reverse = dir === 'right' || dir === 'down';
    let gainedTotal = 0;

    for (let i = 0; i < SIZE; i++) {
      const line = horizontal ? getRow(board, i) : getCol(board, i);
      if (reverse) line.reverse();
      const { row, gained } = slide(line);
      let out = row;
      if (reverse) out = out.slice().reverse();
      if (horizontal) setRow(board, i, out); else setCol(board, i, out);
      gainedTotal += gained;
    }

    if (JSON.stringify(board) === before) return null; // illegal move, no change
    score += gainedTotal;
    if (score > bestScore) { bestScore = score; localStorage.setItem('chalk_2048_best', String(bestScore)); }
    const spawned = spawnTile();
    updateScoreUI();
    return spawned ? [spawned] : [];
  }

  function canMove() {
    if (emptyCells().length) return true;
    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        const v = board[r][c];
        if (c + 1 < SIZE && board[r][c + 1] === v) return true;
        if (r + 1 < SIZE && board[r + 1][c] === v) return true;
      }
    }
    return false;
  }

  function move(dir) {
    if (!running || gameOver) return;
    const newTiles = applyMove(dir);
    if (!newTiles) return; // nothing moved
    render(newTiles);
    if (!canMove()) onGameOver();
  }

  // ── Rendering ────────────────────────────────────────────────────────────────
  function render(newTiles) {
    const el = document.getElementById('g2048Board');
    if (!el) return;
    const fresh = new Set((newTiles || []).map(([r, c]) => `${r},${c}`));
    let html = '';
    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        const v = board[r][c];
        const cls = v ? `g2048-tile v${v > 2048 ? 'big' : v}` : 'g2048-cell';
        const pop = v && fresh.has(`${r},${c}`) ? ' g2048-pop' : '';
        html += `<div class="${cls}${pop}">${v || ''}</div>`;
      }
    }
    el.innerHTML = html;
  }

  function updateScoreUI() {
    const el = document.getElementById('g2048Score');
    if (el) el.textContent = score;
    const bestEl = document.getElementById('g2048Best');
    if (bestEl) bestEl.textContent = Math.max(bestScore, score);
  }

  // ── Overlays / result ───────────────────────────────────────────────────────
  function showOverlay(text, btnText) {
    const ov = document.getElementById('g2048Overlay');
    const txt = document.getElementById('g2048OverlayText');
    const btn = document.getElementById('g2048StartBtn');
    if (!ov) return;
    txt.textContent = text;
    btn.textContent = btnText;
    ov.classList.remove('hide');
  }
  function hideOverlay() {
    const ov = document.getElementById('g2048Overlay');
    if (ov) ov.classList.add('hide');
  }
  function hideResult() {
    const r = document.getElementById('g2048Result');
    if (r) r.classList.add('hide');
  }

  function onGameOver() {
    gameOver = true;
    running = false;
    updateScoreUI();
    const resEl = document.getElementById('g2048Result');
    const titleEl = document.getElementById('g2048ResultTitle');
    const scoreEl = document.getElementById('g2048ResultScore');
    const rankEl = document.getElementById('g2048ResultRank');
    if (titleEl) titleEl.textContent = won ? '🎉 2048!' : T('games_over');
    if (scoreEl) scoreEl.textContent = score;
    if (rankEl) rankEl.textContent = T('games_saving_result');
    if (resEl) resEl.classList.remove('hide');
    hideOverlay();
    saveScoreAndRefresh(score, rankEl);
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
    const list = document.getElementById('g2048LeaderboardList');
    const myRankEl = document.getElementById('g2048MyRank');
    if (!list) return;
    try {
      const res = await api(`/api/games/${GAME}/leaderboard?limit=10`);
      const rows = (res.top || []).map((row) => {
        const isMe = currentUser && row.userId === currentUser.id;
        return `<div class="tetris-lb-row${  isMe ? ' me' : ''  }">` +
          `<span class="tetris-lb-rank">${  row.rank  }</span>` +
          `<span class="tetris-lb-ava">${  row.avatarEmoji || '🔢'  }</span>` +
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
  window.g2048ResumeOrStart = function () {
    if (!board || gameOver) resetGame();
    running = true;
    gameOver = false;
    hideOverlay();
    hideResult();
    render([]);
  };

  window.openG2048Modal = function () {
    const modal = document.getElementById('g2048Modal');
    if (!modal) return;
    modal.classList.add('show');
    const pill = document.getElementById('g2048SearchPill');
    if (pill) pill.style.display = (typeof isSearching !== 'undefined' && isSearching) ? 'inline-flex' : 'none';
    if (!board) resetGame();
    loadLeaderboard();
    updateScoreUI();
    render([]);
    if (!running) showOverlay(gameOver ? T('games_over') : T('match_ready_q'), gameOver ? T('btn_play_again') : T('games_start'));
  };

  window.closeG2048Modal = function () {
    const modal = document.getElementById('g2048Modal');
    if (modal) modal.classList.remove('show');
  };

  window.g2048Move = function (dir) { move(dir); };

  // ── Keyboard (only while the 2048 modal is open) ────────────────────────────
  const KEY_DIR = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };
  document.addEventListener('keydown', (e) => {
    const modal = document.getElementById('g2048Modal');
    if (!modal || !modal.classList.contains('show')) return;
    if (e.key === 'Escape') { window.closeG2048Modal(); return; }
    if (!KEY_DIR[e.key]) return;
    e.preventDefault();
    move(KEY_DIR[e.key]);
  });

  // ── Touch swipe on the board ────────────────────────────────────────────────
  let touchX = 0; let touchY = 0;
  document.addEventListener('touchstart', (e) => {
    const modal = document.getElementById('g2048Modal');
    if (!modal || !modal.classList.contains('show')) return;
    const t = e.touches[0]; touchX = t.clientX; touchY = t.clientY;
  }, { passive: true });
  document.addEventListener('touchend', (e) => {
    const modal = document.getElementById('g2048Modal');
    if (!modal || !modal.classList.contains('show')) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - touchX; const dy = t.clientY - touchY;
    if (Math.max(Math.abs(dx), Math.abs(dy)) < 24) return; // ignore taps
    if (Math.abs(dx) > Math.abs(dy)) move(dx > 0 ? 'right' : 'left');
    else move(dy > 0 ? 'down' : 'up');
  }, { passive: true });
})();
