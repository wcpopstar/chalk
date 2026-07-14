// ── IN-CALL 1v1 MINI-GAMES: tetris duel + chess ─────────────────────────────
// Relayed over the 'call:game' socket event (see src/socket/calls.ts — the
// server is a dumb relay; rules run here). Invite flow: either side picks a
// game from the 🎮 menu → the other confirms → both start. Tetris duel reuses
// the normal tetris modal (each plays their own board, live opponent score);
// chess uses ChessEngine (chess-engine.js) with the inviter playing white.

// Which in-call game is running: null | 'tetris' | 'chess'
var callGameActive = null;
var callGamePendingInvite = null; // game we invited the partner to (awaiting answer)

// ── Tetris duel state ────────────────────────────────────────────────────────
var duelMyFinal = null;
var duelOppFinal = null;
var duelOppScore = 0;
var duelLastSent = 0;

// ── Chess state ──────────────────────────────────────────────────────────────
var chessState = null;
var chessMyWhite = true;
var chessSelected = null; // { r, c, moves }
var chessLastMove = null; // { r, c, r2, c2 }
var chessOver = false;

function callGameEmit(game, action, data) {
  if (!socket || !currentRoomId) return;
  socket.emit('call:game', { roomId: currentRoomId, game, action, data });
}

// ── 🎮 menu on the call overlay ──────────────────────────────────────────────
function toggleCallGamesMenu(ev) {
  ev.stopPropagation();
  const existing = document.getElementById('callGamesMenu');
  if (existing) { existing.remove(); return; }
  const menu = document.createElement('div');
  menu.className = 'chat-ctx-menu';
  menu.id = 'callGamesMenu';
  menu.innerHTML =
    `<button onclick="inviteCallGame('tetris')">🧩 ${T('callgame_tetris')}</button>` +
    `<button onclick="inviteCallGame('chess')">♟ ${T('callgame_chess')}</button>`;
  document.body.appendChild(menu);
  const rect = ev.currentTarget.getBoundingClientRect();
  menu.style.left = `${Math.min(rect.left, window.innerWidth - 210)}px`;
  menu.style.top = `${Math.max(10, rect.top - 100)}px`;
  setTimeout(() => document.addEventListener('click', closeCallGamesMenu, { once: true }), 0);
}
function closeCallGamesMenu() {
  const m = document.getElementById('callGamesMenu');
  if (m) m.remove();
}

function inviteCallGame(game) {
  closeCallGamesMenu();
  if (!currentRoomId) return;
  callGamePendingInvite = game;
  callGameEmit(game, 'invite');
  showToast(`🎮 ${T('callgame_invite_sent')}`);
}

// ── Incoming relay events (routed from socket.js) ───────────────────────────
function onCallGame(data) {
  const { game } = data;
  if (data.action === 'invite') {
    const gameName = game === 'chess' ? T('callgame_chess') : T('callgame_tetris');
    const q = T('callgame_invite_q').replace('{name}', data.fromName || T('status_user')).replace('{game}', gameName);
    if (confirm(q)) {
      callGameEmit(game, 'accept');
      startCallGame(game, false); // acceptor: black in chess
    } else {
      callGameEmit(game, 'decline');
    }
    return;
  }
  if (data.action === 'accept') {
    if (callGamePendingInvite !== game) return;
    callGamePendingInvite = null;
    startCallGame(game, true); // inviter: white in chess
    return;
  }
  if (data.action === 'decline') {
    callGamePendingInvite = null;
    showToast(T('callgame_declined'));
    return;
  }
  if (data.action === 'quit') {
    if (callGameActive === game) endCallGame(true);
    return;
  }
  if (game === 'tetris' && callGameActive === 'tetris') {
    if (data.action === 'score') {
      duelOppScore = Number((data.data || {}).score) || 0;
      updateDuelUI();
    } else if (data.action === 'over') {
      duelOppFinal = Number((data.data || {}).score) || 0;
      concludeDuelIfDone();
    }
    return;
  }
  if (game === 'chess' && callGameActive === 'chess' && data.action === 'move') {
    chessApplyRemote(String((data.data || {}).m || ''));
  }
}

function startCallGame(game, asInviter) {
  callGameActive = game;
  if (game === 'tetris') {
    duelMyFinal = null; duelOppFinal = null; duelOppScore = 0;
    setDuelElementsVisible(true);
    updateDuelUI();
    openTetrisModal();
    tetrisForceRestart();
  } else {
    chessStart(asInviter);
  }
}

// Ends the current game locally. fromRemote=true → the partner quit.
function endCallGame(fromRemote) {
  const game = callGameActive;
  callGameActive = null;
  if (!game) return;
  if (!fromRemote) callGameEmit(game, 'quit');
  else showToast(T('callgame_opponent_quit'));
  if (game === 'tetris') setDuelElementsVisible(false);
  else {
    const modal = document.getElementById('chessModal');
    if (modal) modal.classList.remove('show');
  }
}

// ── TETRIS DUEL ──────────────────────────────────────────────────────────────
function setDuelElementsVisible(on) {
  document.querySelectorAll('.tetris-duel-el').forEach((el) => { el.style.display = on ? '' : 'none'; });
}

function updateDuelUI() {
  const el = document.getElementById('tetrisDuelScore');
  if (el) el.textContent = duelOppScore;
}

document.addEventListener('tetris:score', (e) => {
  if (callGameActive !== 'tetris') return;
  const now = Date.now();
  if (now - duelLastSent < 400) return;
  duelLastSent = now;
  callGameEmit('tetris', 'score', { score: e.detail.score });
});

document.addEventListener('tetris:gameover', (e) => {
  if (callGameActive !== 'tetris') return;
  duelMyFinal = e.detail.score;
  callGameEmit('tetris', 'over', { score: duelMyFinal });
  concludeDuelIfDone();
});

function concludeDuelIfDone() {
  if (duelMyFinal === null || duelOppFinal === null) return;
  const msg = duelMyFinal > duelOppFinal ? T('callgame_you_won')
    : duelMyFinal < duelOppFinal ? T('callgame_you_lost')
    : T('callgame_draw');
  showToast(`🏁 ${msg} (${duelMyFinal}:${duelOppFinal})`);
  callGameActive = null;
  setDuelElementsVisible(false);
}

// ── CHESS ────────────────────────────────────────────────────────────────────
var CHESS_GLYPHS = { K: '♔', Q: '♕', R: '♖', B: '♗', N: '♘', P: '♙', k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' };

function chessStart(asWhite) {
  chessState = ChessEngine.newState();
  chessMyWhite = asWhite;
  chessSelected = null;
  chessLastMove = null;
  chessOver = false;
  const modal = document.getElementById('chessModal');
  if (modal) modal.classList.add('show');
  chessRender();
}

function closeChessModal() {
  if (callGameActive === 'chess') endCallGame(false);
  const modal = document.getElementById('chessModal');
  if (modal) modal.classList.remove('show');
}

// Display row/col → board row/col (black sees the board flipped).
function chessBoardCoord(i) { return chessMyWhite ? i : 7 - i; }

function chessRender() {
  const el = document.getElementById('chessBoard');
  if (!el || !chessState) return;
  let html = '';
  for (let dr = 0; dr < 8; dr++) {
    for (let dc = 0; dc < 8; dc++) {
      const r = chessBoardCoord(dr); const c = chessBoardCoord(dc);
      const p = chessState.board[r][c];
      const dark = (r + c) % 2 === 1;
      let cls = `chess-cell ${dark ? 'dark' : 'light'}`;
      if (chessSelected && chessSelected.r === r && chessSelected.c === c) cls += ' sel';
      if (chessLastMove && ((chessLastMove.r === r && chessLastMove.c === c) || (chessLastMove.r2 === r && chessLastMove.c2 === c))) cls += ' last';
      const target = chessSelected && chessSelected.moves.some((m) => m.r2 === r && m.c2 === c);
      if (target) cls += p ? ' capture' : ' target';
      const glyph = p ? `<span class="chess-piece ${ChessEngine.isWhitePiece(p) ? 'w' : 'b'}">${CHESS_GLYPHS[p]}</span>` : '';
      html += `<div class="${cls}" data-r="${r}" data-c="${c}">${glyph}</div>`;
    }
  }
  el.innerHTML = html;
  chessUpdateStatus();
}

function chessUpdateStatus() {
  const el = document.getElementById('chessStatus');
  if (!el || !chessState) return;
  const st = ChessEngine.status(chessState);
  const myTurn = (chessState.turn === 'w') === chessMyWhite;
  if (st === 'mate') {
    chessOver = true;
    el.textContent = `♛ ${T('chess_mate')} ${myTurn ? T('callgame_you_lost') : T('callgame_you_won')}`;
  } else if (st === 'stalemate') {
    chessOver = true;
    el.textContent = T('chess_stalemate');
  } else {
    const turnLabel = myTurn ? T('chess_your_turn') : T('chess_their_turn');
    el.textContent = st === 'check' ? `⚠️ ${T('chess_check')} ${turnLabel}` : turnLabel;
  }
}

function chessCellClicked(r, c) {
  if (!chessState || chessOver) return;
  const myTurn = (chessState.turn === 'w') === chessMyWhite;
  if (!myTurn) return;
  const mv = chessSelected && chessSelected.moves.find((m) => m.r2 === r && m.c2 === c);
  if (mv) {
    chessDoMove(mv);
    callGameEmit('chess', 'move', { m: ChessEngine.encodeMove(mv) });
    return;
  }
  const p = chessState.board[r][c];
  if (p && ChessEngine.isWhitePiece(p) === chessMyWhite) {
    const moves = ChessEngine.legalMovesFor(chessState, r, c);
    chessSelected = moves.length ? { r, c, moves } : null;
  } else {
    chessSelected = null;
  }
  chessRender();
}

function chessDoMove(mv) {
  chessState = ChessEngine.applyMove(chessState, mv);
  chessLastMove = mv;
  chessSelected = null;
  chessRender();
}

function chessApplyRemote(encoded) {
  if (!chessState || chessOver) return;
  const mv = ChessEngine.decodeMove(chessState, encoded);
  if (!mv) return; // invalid/out-of-turn remote move — ignore
  chessDoMove(mv);
  if (window.chalkSounds) window.chalkSounds.message();
}

function chessResign() {
  if (!confirm(T('chess_resign_q'))) return;
  showToast(T('callgame_you_lost'));
  endCallGame(false);
}

// Delegated board clicks (bound once).
document.addEventListener('click', (e) => {
  const cell = e.target.closest && e.target.closest('#chessBoard .chess-cell');
  if (!cell) return;
  chessCellClicked(Number(cell.dataset.r), Number(cell.dataset.c));
});
