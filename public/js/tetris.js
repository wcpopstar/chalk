// ── TETRIS MINI-GAME (modal, plays while searching for a match) ──────────────
(function () {
  const COLS = 9; const ROWS = 18; const CELL = 20;
  let canvas; let ctx;
  let board; let cur; let curX; let curY; let score; let running; let paused; let gameOver; let scoreSaved;
  let dropTimer = null; let holdTimer = null; let difficultyTimer = null; let lockTimer = null;
  const LOCK_DELAY_MS = 450;
  const BASE_DROP_MS = 600; const MIN_DROP_MS = 130;
  let dropMs = BASE_DROP_MS;
  let level = 1; let linesCleared = 0; let gameStartTime = 0;
  let bestScore = Number(localStorage.getItem('chalk_tetris_best') || 0);

  const SHAPES = {
    I: [[1,1,1,1]],
    O: [[1,1],[1,1]],
    T: [[0,1,0],[1,1,1]],
    S: [[0,1,1],[1,1,0]],
    Z: [[1,1,0],[0,1,1]],
    J: [[1,0,0],[1,1,1]],
    L: [[0,0,1],[1,1,1]]
  };
  const COLORS = { I:'#22d3ee', O:'#facc15', T:'#a855f7', S:'#22c55e', Z:'#ef4444', J:'#3b82f6', L:'#f97316' };

  function emptyBoard() {
    const b = [];
    for (let r = 0; r < ROWS; r++) b.push(new Array(COLS).fill(null));
    return b;
  }

  function newPiece() {
    const keys = Object.keys(SHAPES);
    const k = keys[Math.floor(Math.random() * keys.length)];
    return { shape: SHAPES[k].map((row) =>row.slice()), color: COLORS[k] };
  }

  function resetGame() {
    board = emptyBoard();
    score = 0;
    level = 1;
    linesCleared = 0;
    dropMs = BASE_DROP_MS;
    gameStartTime = Date.now();
    gameOver = false;
    scoreSaved = false;
    clearLockTimer();
    spawnPiece();
    updateScoreUI();
    hideResult();
  }

  function spawnPiece() {
    cur = newPiece();
    curX = Math.floor((COLS - cur.shape[0].length) / 2);
    curY = 0;
    clearLockTimer();
    if (collides(cur.shape, curX, curY)) {
      gameOver = true;
      running = false;
      stopLoop();
      stopDifficultyTimer();
      draw();
      onGameOver();
    }
  }

  function collides(shape, x, y) {
    for (let r = 0; r < shape.length; r++) {
      for (let c = 0; c < shape[r].length; c++) {
        if (!shape[r][c]) continue;
        const nx = x + c; const ny = y + r;
        if (nx < 0 || nx >= COLS || ny >= ROWS) return true;
        if (ny >= 0 && board[ny][nx]) return true;
      }
    }
    return false;
  }

  function merge() {
    for (let r = 0; r < cur.shape.length; r++) {
      for (let c = 0; c < cur.shape[r].length; c++) {
        if (cur.shape[r][c]) {
          const ny = curY + r; const nx = curX + c;
          if (ny >= 0) board[ny][nx] = cur.color;
        }
      }
    }
  }

  function clearLines() {
    let cleared = 0;
    for (let r = ROWS - 1; r >= 0; r--) {
      if (board[r].every((cell) =>cell)) {
        board.splice(r, 1);
        board.unshift(new Array(COLS).fill(null));
        cleared++;
        r++;
      }
    }
    if (cleared) {
      score += ([0, 10, 30, 60, 100][cleared] || cleared * 30) * level;
      linesCleared += cleared;
      updateScoreUI();
      recalcDifficulty();
    }
  }

  // ── DIFFICULTY: speeds up the longer you survive AND the more lines you clear ─
  function recalcDifficulty() {
    const elapsedSec = (Date.now() - gameStartTime) / 1000;
    const timeLevel = Math.floor(elapsedSec / 15);        // +1 level every 15s survived
    const lineLevel = Math.floor(linesCleared / 4);        // +1 level every 4 lines cleared
    const newLevel = 1 + timeLevel + lineLevel;
    if (newLevel !== level) {
      level = newLevel;
      updateScoreUI();
    }
    const newDropMs = Math.max(MIN_DROP_MS, BASE_DROP_MS - (level - 1) * 35);
    if (newDropMs !== dropMs) {
      dropMs = newDropMs;
      if (running && !paused && !gameOver) startLoop();
    }
  }

  function startDifficultyTimer() {
    stopDifficultyTimer();
    difficultyTimer = setInterval(recalcDifficulty, 1000);
  }
  function stopDifficultyTimer() {
    if (difficultyTimer) { clearInterval(difficultyTimer); difficultyTimer = null; }
  }

  function isGrounded() {
    return collides(cur.shape, curX, curY + 1);
  }

  function rotateShape(shape) {
    const rows = shape.length; const cols = shape[0].length;
    const res = [];
    for (let c = 0; c < cols; c++) {
      const row = [];
      for (let r = rows - 1; r >= 0; r--) row.push(shape[r][c]);
      res.push(row);
    }
    return res;
  }

  function clearLockTimer() {
    if (lockTimer) { clearTimeout(lockTimer); lockTimer = null; }
  }

  function lockPiece() {
    lockTimer = null;
    merge();
    clearLines();
    spawnPiece();
    draw();
  }

  // Called after a successful move/rotate: if the piece is now resting on
  // something, (re)start the lock-delay countdown; otherwise cancel it.
  function refreshLockState() {
    if (!cur || gameOver) return;
    if (isGrounded()) {
      clearLockTimer();
      lockTimer = setTimeout(lockPiece, LOCK_DELAY_MS);
    } else {
      clearLockTimer();
    }
  }

  function tetrisRotate() {
    if (!running || paused || gameOver) return;
    const rotated = rotateShape(cur.shape);
    if (!collides(rotated, curX, curY)) {
      cur.shape = rotated;
    } else if (!collides(rotated, curX - 1, curY)) {
      curX -= 1; cur.shape = rotated;
    } else if (!collides(rotated, curX + 1, curY)) {
      curX += 1; cur.shape = rotated;
    } else {
      return;
    }
    refreshLockState();
    draw();
  }

  function move(dx) {
    if (!running || paused || gameOver) return;
    if (!collides(cur.shape, curX + dx, curY)) {
      curX += dx;
      refreshLockState();
      draw();
    }
  }

  function softDrop() {
    if (!running || paused || gameOver) return;
    if (!isGrounded()) {
      curY += 1;
      clearLockTimer();
      draw();
    } else if (!lockTimer) {
      // already resting — lock it in right away on an explicit soft-drop press
      lockPiece();
    }
  }

  function step() {
    if (!running || paused || gameOver) return;
    if (!isGrounded()) {
      curY += 1;
      clearLockTimer();
      draw();
    } else if (!lockTimer) {
      // piece just touched down — give the player a brief grace period
      // (like real Tetris) before it actually locks in place
      lockTimer = setTimeout(lockPiece, LOCK_DELAY_MS);
    }
  }


  function draw() {
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        if (board[r][c]) drawCell(c, r, board[r][c]);
      }
    }
    if (!gameOver) {
      for (let r2 = 0; r2 < cur.shape.length; r2++) {
        for (let c2 = 0; c2 < cur.shape[r2].length; c2++) {
          if (cur.shape[r2][c2]) drawCell(curX + c2, curY + r2, cur.color);
        }
      }
    }
  }

  function drawCell(x, y, color) {
    ctx.fillStyle = color;
    ctx.fillRect(x * CELL + 1, y * CELL + 1, CELL - 2, CELL - 2);
  }

  function updateScoreUI() {
    const el = document.getElementById('tetrisScore');
    if (el) el.textContent = score;
    const bestEl = document.getElementById('tetrisBest');
    if (bestEl) bestEl.textContent = Math.max(bestScore, score);
    const lvlEl = document.getElementById('tetrisLevel');
    if (lvlEl) lvlEl.textContent = level;
  }

  function startLoop() {
    stopLoop();
    dropTimer = setInterval(step, dropMs);
  }
  function stopLoop() {
    if (dropTimer) { clearInterval(dropTimer); dropTimer = null; }
  }

  function showOverlay(text, btnText) {
    const ov = document.getElementById('tetrisOverlay');
    const txt = document.getElementById('tetrisOverlayText');
    const btn = document.getElementById('tetrisStartBtn');
    if (!ov) return;
    txt.textContent = text;
    btn.textContent = btnText;
    ov.classList.remove('hide');
  }
  function hideOverlay() {
    const ov = document.getElementById('tetrisOverlay');
    if (ov) ov.classList.add('hide');
  }
  function hideResult() {
    const r = document.getElementById('tetrisResult');
    if (r) r.classList.add('hide');
  }

  function onGameOver() {
    if (score > bestScore) {
      bestScore = score;
      localStorage.setItem('chalk_tetris_best', String(bestScore));
    }
    updateScoreUI();
    const resEl = document.getElementById('tetrisResult');
    const scoreEl = document.getElementById('tetrisResultScore');
    const levelEl = document.getElementById('tetrisResultLevel');
    const rankEl = document.getElementById('tetrisResultRank');
    if (scoreEl) scoreEl.textContent = score;
    if (levelEl) levelEl.textContent = `${T('status_level_reached')  } ${  level}`;
    if (rankEl) rankEl.textContent = T('games_saving_result');
    if (resEl) resEl.classList.remove('hide');
    hideOverlay();
    saveScoreAndRefresh(score, rankEl);
  }

  async function saveScoreAndRefresh(finalScore, rankEl) {
    if (scoreSaved) return;
    scoreSaved = true;
    try {
      const res = await api('/api/games/tetris/score', { method: 'POST', body: JSON.stringify({ score: finalScore }) });
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
    const list = document.getElementById('tetrisLeaderboardList');
    const myRankEl = document.getElementById('tetrisMyRank');
    if (!list) return;
    try {
      const res = await api('/api/games/tetris/leaderboard?limit=10');
      const rows = (res.top || []).map((row) => {
        const isMe = currentUser && row.userId === currentUser.id;
        return `<div class="tetris-lb-row${  isMe ? ' me' : ''  }">` +
          `<span class="tetris-lb-rank">${  row.rank  }</span>` +
          `<span class="tetris-lb-ava">${  row.avatarEmoji || '🎮'  }</span>` +
          `<span class="tetris-lb-name">${  row.username  }</span>` +
          `<span class="tetris-lb-score">${  row.bestScore  }</span>` +
          `</div>`;
      });
      list.innerHTML = rows.length ? rows.join('') : `<div style="font-size:11px;color:var(--muted);padding:6px 2px">${  T('games_none_played')  } — ${  T('msg_be_first_excl')  }</div>`;
      if (myRankEl) {
        myRankEl.textContent = res.me ? (`${T('rating_your_place')  } #${  res.me.rank  } (${  res.me.bestScore  } ${  T('unit_points_dot')  })`) : '';
      }
    } catch (e) {
      list.innerHTML = '<div style="font-size:11px;color:var(--muted);padding:6px 2px"><span data-i18n="rating_err_load">Не удалось загрузить рейтинг</span></div>';
    }
  }

  window.tetrisResumeOrStart = function () {
    if (!canvas) {
      canvas = document.getElementById('tetrisCanvas');
      ctx = canvas.getContext('2d');
    }
    if (!board || gameOver) resetGame();
    running = true;
    paused = false;
    hideOverlay();
    hideResult();
    startLoop();
    startDifficultyTimer();
    refreshLockState();
    draw();
  };

  window.tetrisPause = function () {
    if (!running) return;
    paused = true;
    stopLoop();
    stopDifficultyTimer();
    clearLockTimer();
    showOverlay(T('games_pause'), T('btn_continue'));
  };

  window.openTetrisModal = function () {
    const modal = document.getElementById('tetrisModal');
    if (!modal) return;
    modal.classList.add('show');
    const pill = document.getElementById('tetrisModalSearchPill');
    if (pill) pill.style.display = isSearching ? 'inline-flex' : 'none';
    if (!canvas) {
      canvas = document.getElementById('tetrisCanvas');
      ctx = canvas.getContext('2d');
      resetGame();
      draw();
      loadLeaderboard();
    } else {
      loadLeaderboard();
    }
    updateScoreUI();
    if (!running) showOverlay(gameOver ? T('match_ready_q') : T('games_pause'), gameOver ? T('games_start') : T('btn_continue'));
  };

  window.closeTetrisModal = function () {
    const modal = document.getElementById('tetrisModal');
    if (modal) modal.classList.remove('show');
    tetrisPause();
  };

  window.tetrisRotate = tetrisRotate;

  // ── Touch / mouse hold-to-repeat (side buttons) ───────────────────────────
  window.tetrisHold = function (dir) {
    if (!running || paused || gameOver) return;
    const fn = dir === 'left' ? function(){ move(-1) } : dir === 'right' ? function(){ move(1) } : function(){ softDrop() };
    fn();
    clearInterval(holdTimer);
    holdTimer = setInterval(fn, 110);
  };
  window.tetrisRelease = function () {
    clearInterval(holdTimer);
    holdTimer = null;
  };

  // ── Keyboard hold-to-repeat (arrow keys keep moving while held down) ─────
  let keyHoldTimer = null;
  let activeKey = null;
  document.addEventListener('keydown', (e) => {
    const modal = document.getElementById('tetrisModal');
    if (!modal || !modal.classList.contains('show')) return;
    if (e.key === 'Escape') { closeTetrisModal(); return; }
    if (!running || paused || gameOver) return;
    if (['ArrowLeft','ArrowRight','ArrowDown','ArrowUp'].indexOf(e.key) === -1) return;
    e.preventDefault();
    if (e.repeat) return; // we drive our own repeat loop, ignore the OS one
    if (e.key === 'ArrowUp') { tetrisRotate(); return; }
    if (activeKey === e.key) return;
    activeKey = e.key;
    const fn = e.key === 'ArrowLeft' ? function(){ move(-1) } : e.key === 'ArrowRight' ? function(){ move(1) } : function(){ softDrop() };
    fn();
    clearInterval(keyHoldTimer);
    keyHoldTimer = setInterval(fn, 110);
  });
  document.addEventListener('keyup', (e) => {
    if (e.key === activeKey) {
      clearInterval(keyHoldTimer);
      keyHoldTimer = null;
      activeKey = null;
    }
  });
  window.addEventListener('blur', () => {
    clearInterval(keyHoldTimer);
    keyHoldTimer = null;
    activeKey = null;
    clearInterval(holdTimer);
    holdTimer = null;
  });
})();


