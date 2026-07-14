// ── COMPACT CHESS ENGINE (rules only, no UI) ─────────────────────────────────
// Used by the in-call chess duel (call-games.js). Board is an 8×8 array,
// board[0] = rank 8 (black's back rank); white pieces are uppercase PNBRQK.
// Covers the full move rules: castling, en passant, promotion (auto-queen),
// check legality, mate & stalemate detection.
(function () {
  const inB = (x) => x >= 0 && x <= 7;
  const isW = (p) => p === p.toUpperCase();

  function newState() {
    const back = ['r', 'n', 'b', 'q', 'k', 'b', 'n', 'r'];
    const board = [
      back.slice(),
      new Array(8).fill('p'),
      new Array(8).fill(null),
      new Array(8).fill(null),
      new Array(8).fill(null),
      new Array(8).fill(null),
      new Array(8).fill('P'),
      back.map((x) => x.toUpperCase()),
    ];
    return { board, turn: 'w', castling: { K: true, Q: true, k: true, q: true }, ep: null };
  }

  const KNIGHT = [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]];
  const KING = [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]];
  const ORTHO = [[-1,0],[1,0],[0,-1],[0,1]];
  const DIAG = [[-1,-1],[-1,1],[1,-1],[1,1]];

  // Is square (r,c) attacked by the side `byWhite`?
  function attacked(board, r, c, byWhite) {
    const pd = byWhite ? 1 : -1; // pawns of that side sit one rank "behind" their attack
    for (const dc of [-1, 1]) {
      const pr = r + pd; const pc = c + dc;
      if (inB(pr) && inB(pc)) {
        const p = board[pr][pc];
        if (p && p.toLowerCase() === 'p' && isW(p) === byWhite) return true;
      }
    }
    for (const [dr, dc] of KNIGHT) {
      const r2 = r + dr; const c2 = c + dc;
      if (inB(r2) && inB(c2)) {
        const p = board[r2][c2];
        if (p && p.toLowerCase() === 'n' && isW(p) === byWhite) return true;
      }
    }
    for (const [dr, dc] of KING) {
      const r2 = r + dr; const c2 = c + dc;
      if (inB(r2) && inB(c2)) {
        const p = board[r2][c2];
        if (p && p.toLowerCase() === 'k' && isW(p) === byWhite) return true;
      }
    }
    const scan = (dirs, hits) => {
      for (const [dr, dc] of dirs) {
        let r2 = r + dr; let c2 = c + dc;
        while (inB(r2) && inB(c2)) {
          const p = board[r2][c2];
          if (p) {
            if (isW(p) === byWhite && hits.indexOf(p.toLowerCase()) !== -1) return true;
            break;
          }
          r2 += dr; c2 += dc;
        }
      }
      return false;
    };
    return scan(ORTHO, ['r', 'q']) || scan(DIAG, ['b', 'q']);
  }

  function findKing(board, white) {
    const k = white ? 'K' : 'k';
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) if (board[r][c] === k) return [r, c];
    return null;
  }

  function pseudoMoves(st, r, c) {
    const p = st.board[r][c];
    if (!p) return [];
    const white = isW(p);
    const t = p.toLowerCase();
    const mvs = [];
    const push = (r2, c2, fl) => mvs.push(Object.assign({ r, c, r2, c2 }, fl || {}));
    const stepTo = (r2, c2) => {
      if (!inB(r2) || !inB(c2)) return;
      const q = st.board[r2][c2];
      if (!q || isW(q) !== white) push(r2, c2);
    };
    const slide = (dirs) => {
      for (const [dr, dc] of dirs) {
        let r2 = r + dr; let c2 = c + dc;
        while (inB(r2) && inB(c2)) {
          const q = st.board[r2][c2];
          if (!q) push(r2, c2);
          else { if (isW(q) !== white) push(r2, c2); break; }
          r2 += dr; c2 += dc;
        }
      }
    };

    if (t === 'p') {
      const dir = white ? -1 : 1;
      const startR = white ? 6 : 1;
      const promoR = white ? 0 : 7;
      if (inB(r + dir) && !st.board[r + dir][c]) {
        push(r + dir, c, r + dir === promoR ? { promo: true } : null);
        if (r === startR && !st.board[r + 2 * dir][c]) push(r + 2 * dir, c, { double: true });
      }
      for (const dc of [-1, 1]) {
        const r2 = r + dir; const c2 = c + dc;
        if (!inB(r2) || !inB(c2)) continue;
        const q = st.board[r2][c2];
        if (q && isW(q) !== white) push(r2, c2, r2 === promoR ? { promo: true } : null);
        else if (!q && st.ep && st.ep[0] === r2 && st.ep[1] === c2) push(r2, c2, { ep: true });
      }
    } else if (t === 'n') {
      for (const [dr, dc] of KNIGHT) stepTo(r + dr, c + dc);
    } else if (t === 'b') slide(DIAG);
    else if (t === 'r') slide(ORTHO);
    else if (t === 'q') slide(ORTHO.concat(DIAG));
    else if (t === 'k') {
      for (const [dr, dc] of KING) stepTo(r + dr, c + dc);
      const homeR = white ? 7 : 0;
      const rights = st.castling;
      if (r === homeR && c === 4 && !attacked(st.board, homeR, 4, !white)) {
        if ((white ? rights.K : rights.k) && !st.board[homeR][5] && !st.board[homeR][6] &&
            !attacked(st.board, homeR, 5, !white) && !attacked(st.board, homeR, 6, !white)) push(homeR, 6, { castle: 'K' });
        if ((white ? rights.Q : rights.q) && !st.board[homeR][3] && !st.board[homeR][2] && !st.board[homeR][1] &&
            !attacked(st.board, homeR, 3, !white) && !attacked(st.board, homeR, 2, !white)) push(homeR, 2, { castle: 'Q' });
      }
    }
    return mvs;
  }

  function applyMove(st, mv) {
    const board = st.board.map((row) => row.slice());
    const p = board[mv.r][mv.c];
    const white = isW(p);
    board[mv.r][mv.c] = null;
    board[mv.r2][mv.c2] = mv.promo ? (white ? 'Q' : 'q') : p;
    if (mv.ep) board[mv.r][mv.c2] = null; // captured pawn sits beside the mover
    if (mv.castle === 'K') { board[mv.r2][5] = board[mv.r2][7]; board[mv.r2][7] = null; }
    if (mv.castle === 'Q') { board[mv.r2][3] = board[mv.r2][0]; board[mv.r2][0] = null; }

    const castling = Object.assign({}, st.castling);
    if (p === 'K') { castling.K = false; castling.Q = false; }
    if (p === 'k') { castling.k = false; castling.q = false; }
    for (const [rr, cc] of [[mv.r, mv.c], [mv.r2, mv.c2]]) {
      if (rr === 7 && cc === 0) castling.Q = false;
      if (rr === 7 && cc === 7) castling.K = false;
      if (rr === 0 && cc === 0) castling.q = false;
      if (rr === 0 && cc === 7) castling.k = false;
    }

    return {
      board,
      turn: st.turn === 'w' ? 'b' : 'w',
      castling,
      ep: mv.double ? [(mv.r + mv.r2) / 2, mv.c] : null,
    };
  }

  function legalMovesFor(st, r, c) {
    const p = st.board[r][c];
    if (!p) return [];
    const white = isW(p);
    if ((st.turn === 'w') !== white) return [];
    return pseudoMoves(st, r, c).filter((mv) => {
      const next = applyMove(st, mv);
      const king = findKing(next.board, white);
      return king && !attacked(next.board, king[0], king[1], !white);
    });
  }

  function anyLegal(st) {
    const white = st.turn === 'w';
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const p = st.board[r][c];
        if (p && isW(p) === white && legalMovesFor(st, r, c).length) return true;
      }
    }
    return false;
  }

  // 'ok' | 'check' | 'mate' | 'stalemate' — for the side to move.
  function status(st) {
    const white = st.turn === 'w';
    const king = findKing(st.board, white);
    const inCheck = Boolean(king) && attacked(st.board, king[0], king[1], !white);
    if (anyLegal(st)) return inCheck ? 'check' : 'ok';
    return inCheck ? 'mate' : 'stalemate';
  }

  // "e2e4" (+ optional trailing 'q' for promotion) ⇆ move object.
  const FILES = 'abcdefgh';
  function encodeMove(mv) {
    return FILES[mv.c] + String(8 - mv.r) + FILES[mv.c2] + String(8 - mv.r2) + (mv.promo ? 'q' : '');
  }
  function decodeMove(st, str) {
    if (typeof str !== 'string' || str.length < 4) return null;
    const c = FILES.indexOf(str[0]); const r = 8 - Number(str[1]);
    const c2 = FILES.indexOf(str[2]); const r2 = 8 - Number(str[3]);
    if (!inB(r) || !inB(c) || !inB(r2) || !inB(c2)) return null;
    // Re-derive the move from legal moves so a remote move is validated too.
    return legalMovesFor(st, r, c).find((mv) => mv.r2 === r2 && mv.c2 === c2) || null;
  }

  window.ChessEngine = { newState, legalMovesFor, applyMove, status, encodeMove, decodeMove, isWhitePiece: isW };
})();
