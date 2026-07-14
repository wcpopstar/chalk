// ── FRONTWARS — in-call territory-conquest duel ─────────────────────────────
// Turn-based 1v1 on a 9x9 planet grid. Capture neutral land, build farms
// (income) and towers (defense), recruit an army and push toward the enemy
// base. Relayed over 'call:game' (game: 'frontwars') exactly like chess: the
// server is a dumb relay, both clients run the same deterministic reducer, a
// shared seed (sent with the invite) generates identical neutral garrisons.
//
// Win: capture the enemy base, or own more cells when the round limit hits.

var FW = (() => {
  const N = 9;              // board is N x N
  const MAX_ROUNDS = 40;    // after this, most cells wins
  const START_GOLD = 6;
  const START_ARMY = 2;
  const COST_RECRUIT = 2;
  const COST_BUILD = 8;
  const BASE_DEF = 5;       // extra defense of the base cell
  const TOWER_DEF = 3;

  // Deterministic PRNG so both clients generate the same map from one seed.
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const idx = (r, c) => r * N + c;
  const inB = (r, c) => r >= 0 && r < N && c >= 0 && c < N;

  function newState(seed) {
    const rnd = mulberry32(seed >>> 0);
    const cells = [];
    for (let r = 0; r < N; r++) {
      for (let c = 0; c < N; c++) {
        cells.push({ owner: 0, def: 1 + Math.floor(rnd() * 3), bld: null }); // def 1–3
      }
    }
    // Bases in opposite corners; the surrounding cell is cheap to take first.
    const b1 = idx(N - 1, 0), b2 = idx(0, N - 1);
    cells[b1] = { owner: 1, def: 1, bld: 'base' };
    cells[b2] = { owner: 2, def: 1, bld: 'base' };
    return {
      cells, base: { 1: b1, 2: b2 },
      turn: 1, round: 1,
      gold: { 1: START_GOLD, 2: START_GOLD },
      army: { 1: START_ARMY, 2: START_ARMY },
      over: false, winner: null,
    };
  }

  function ownedCount(st, p) { return st.cells.filter((c) => c.owner === p).length; }
  function farmCount(st, p) { return st.cells.filter((c) => c.owner === p && c.bld === 'farm').length; }
  function income(st, p) { return 3 + Math.floor(ownedCount(st, p) / 2) + 2 * farmCount(st, p); }

  // Cost in soldiers to take cell i for player p (Infinity = not adjacent/own cell).
  function captureCost(st, p, i) {
    const cell = st.cells[i];
    if (cell.owner === p) return Infinity;
    const r = Math.floor(i / N), c = i % N;
    const adj = [[r - 1, c], [r + 1, c], [r, c - 1], [r, c + 1]]
      .some(([ar, ac]) => inB(ar, ac) && st.cells[idx(ar, ac)].owner === p);
    if (!adj) return Infinity;
    let cost = cell.def;
    if (cell.bld === 'tower') cost += TOWER_DEF;
    if (cell.bld === 'base') cost += BASE_DEF;
    if (cell.owner !== 0) cost += 1; // enemy land resists harder than neutral
    return cost;
  }

  // The reducer both clients run. act: {a:'rec'|'bld'|'atk'|'end', i?, b?}
  // Player `p` must be st.turn. Returns true if the action was legal+applied.
  function apply(st, p, act) {
    if (st.over || st.turn !== p) return false;
    if (act.a === 'rec') {
      if (st.gold[p] < COST_RECRUIT) return false;
      st.gold[p] -= COST_RECRUIT;
      st.army[p] += 1;
      return true;
    }
    if (act.a === 'bld') {
      const i = act.i | 0;
      if (i < 0 || i >= N * N) return false;
      if (act.b !== 'farm' && act.b !== 'tower') return false;
      const cell = st.cells[i];
      if (cell.owner !== p || cell.bld) return false;
      if (st.gold[p] < COST_BUILD) return false;
      st.gold[p] -= COST_BUILD;
      cell.bld = act.b;
      return true;
    }
    if (act.a === 'atk') {
      const i = act.i | 0;
      if (i < 0 || i >= N * N) return false;
      const cost = captureCost(st, p, i);
      if (!isFinite(cost) || st.army[p] < cost) return false;
      st.army[p] -= cost;
      const cell = st.cells[i];
      const wasEnemyBase = cell.bld === 'base' && cell.owner !== p && cell.owner !== 0;
      cell.owner = p;
      cell.def = 1;
      // Towers and bases are razed when captured; farms survive and switch sides.
      if (cell.bld === 'tower' || cell.bld === 'base') cell.bld = null;
      if (wasEnemyBase) { st.over = true; st.winner = p; }
      return true;
    }
    if (act.a === 'end') {
      const next = p === 1 ? 2 : 1;
      st.turn = next;
      if (next === 1) st.round += 1;
      st.gold[next] += income(st, next);
      if (st.round > MAX_ROUNDS && !st.over) {
        st.over = true;
        const c1 = ownedCount(st, 1), c2 = ownedCount(st, 2);
        st.winner = c1 === c2 ? 0 : c1 > c2 ? 1 : 2;
      }
      return true;
    }
    return false;
  }

  return { N, MAX_ROUNDS, COST_RECRUIT, COST_BUILD, newState, apply, captureCost, ownedCount, income };
})();

// ── UI state ────────────────────────────────────────────────────────────────
var fwState = null;
var fwMe = 1;             // my player number (inviter = 1)
var fwBuildMode = null;   // 'farm' | 'tower' | null — next owned-cell click builds

function fwStart(asInviter, seed) {
  fwState = FW.newState(seed);
  fwMe = asInviter ? 1 : 2;
  fwBuildMode = null;
  const modal = document.getElementById('frontwarsModal');
  if (modal) modal.classList.add('show');
  fwRender();
}

function closeFrontwarsModal() {
  if (callGameActive === 'frontwars') endCallGame(false);
  const modal = document.getElementById('frontwarsModal');
  if (modal) modal.classList.remove('show');
}

function fwEmit(act) { callGameEmit('frontwars', 'move', act); }

// Local action: run the reducer, and only if it was legal, relay it.
function fwDo(act) {
  if (!fwState) return;
  if (FW.apply(fwState, fwMe, act)) {
    fwEmit(act);
    fwRender();
    if (act.a === 'atk' && window.chalkSounds) window.chalkSounds.message();
  }
}

function fwApplyRemote(data) {
  if (!fwState) return;
  const act = { a: String(data.a || ''), i: Number(data.i), b: data.b ? String(data.b) : undefined };
  const them = fwMe === 1 ? 2 : 1;
  if (FW.apply(fwState, them, act)) fwRender();
}

function fwRecruit() { fwDo({ a: 'rec' }); }
function fwEndTurn() { fwBuildMode = null; fwDo({ a: 'end' }); }
function fwToggleBuild(kind) {
  fwBuildMode = fwBuildMode === kind ? null : kind;
  fwRender();
}

function fwCellClicked(i) {
  if (!fwState || fwState.over || fwState.turn !== fwMe) return;
  const cell = fwState.cells[i];
  if (fwBuildMode && cell.owner === fwMe && !cell.bld) {
    fwDo({ a: 'bld', i, b: fwBuildMode });
    fwBuildMode = null;
    fwRender();
    return;
  }
  if (cell.owner !== fwMe) fwDo({ a: 'atk', i });
}

// ── Render ──────────────────────────────────────────────────────────────────
var FW_BLD_ICON = { base: '⭐', farm: '🌾', tower: '🗼' };

function fwRender() {
  const board = document.getElementById('fwBoard');
  if (!board || !fwState) return;
  const st = fwState;
  const myTurn = st.turn === fwMe && !st.over;
  let html = '';
  for (let i = 0; i < FW.N * FW.N; i++) {
    const cell = st.cells[i];
    let cls = 'fw-cell';
    cls += cell.owner === 0 ? ' fw-neutral' : cell.owner === fwMe ? ' fw-mine' : ' fw-theirs';
    const cost = myTurn ? FW.captureCost(st, fwMe, i) : Infinity;
    const can = isFinite(cost) && st.army[fwMe] >= cost;
    if (myTurn && can && !fwBuildMode) cls += ' fw-can';
    if (fwBuildMode && cell.owner === fwMe && !cell.bld) cls += ' fw-can-build';
    const icon = cell.bld ? FW_BLD_ICON[cell.bld] : '';
    const label = icon || (cell.owner === 0 ? cell.def : '');
    const costTag = (myTurn && isFinite(cost) && !fwBuildMode) ? `<span class="fw-cost${can ? '' : ' fw-cost-no'}">${cost}</span>` : '';
    html += `<div class="${cls}" data-i="${i}">${label}${costTag}</div>`;
  }
  board.innerHTML = html;

  const bar = document.getElementById('fwBar');
  if (bar) {
    bar.innerHTML =
      `<span>💰 ${st.gold[fwMe]}</span><span>⚔️ ${st.army[fwMe]}</span>` +
      `<span>🗺 ${FW.ownedCount(st, fwMe)}:${FW.ownedCount(st, fwMe === 1 ? 2 : 1)}</span>` +
      `<span>📈 +${FW.income(st, fwMe)}</span><span>⏳ ${st.round}/${FW.MAX_ROUNDS}</span>`;
  }

  const status = document.getElementById('fwStatus');
  if (status) {
    if (st.over) {
      status.textContent = st.winner === 0 ? T('callgame_draw', 'Ничья')
        : st.winner === fwMe ? `🏆 ${T('callgame_you_won', 'Ты победил!')}`
        : `💀 ${T('callgame_you_lost', 'Ты проиграл')}`;
    } else if (fwBuildMode) {
      status.textContent = T('fw_pick_cell', 'Выбери свою пустую клетку для постройки');
    } else {
      status.textContent = myTurn ? T('fw_your_turn', 'Твой ход — захватывай клетки с цифрой (цена в солдатах)') : T('fw_their_turn', 'Ход противника…');
    }
  }

  const farmBtn = document.getElementById('fwBuildFarm');
  const towerBtn = document.getElementById('fwBuildTower');
  if (farmBtn) farmBtn.classList.toggle('active', fwBuildMode === 'farm');
  if (towerBtn) towerBtn.classList.toggle('active', fwBuildMode === 'tower');
  ['fwRecruitBtn', 'fwBuildFarm', 'fwBuildTower', 'fwEndTurnBtn'].forEach((id) => {
    const b = document.getElementById(id);
    if (b) b.disabled = !myTurn;
  });
}

// Delegated board clicks (bound once).
document.addEventListener('click', (e) => {
  const cell = e.target.closest && e.target.closest('#fwBoard .fw-cell');
  if (!cell) return;
  fwCellClicked(Number(cell.dataset.i));
});
