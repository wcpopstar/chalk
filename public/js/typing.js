// ── TYPING SPEED TEST MINI-GAME ("who types faster in a minute") ─────────────
// A 60-second sprint: type the shown passage as fast and accurately as you can.
// Score = net WPM (correct chars ÷ 5 ÷ minutes). Shares the generic arcade
// score backend (/api/games/typing/*) and the shared leaderboard UI.
(function () {
  const GAME = 'typing';
  const DURATION_MS = 60 * 1000;
  const PASSAGE_WORDS = 120;

  // Common-word pools; the passage is built from the current UI language
  // (uk falls back to ru, everything else to en) so it reads naturally.
  const WORDS = {
    ru: 'и в не на что с как это по но из они мы вы для так вот его она они там где когда очень если бы уже или тоже быть день дом рука друг игра слово время дело жизнь мир свет вода огонь путь ветер небо утро вечер добро сила мысль книга музыка город улица работа сердце голос радость надежда'.split(' '),
    en: 'the of and to in that is it for was as with his they be at one have this from or had by hot but some what there we can out other were all your when up use word how said each she which do their time will way about many then them would write like so these her long make thing see him two has look more day could go come did my sound no most number who over know water than call first people may down side been now find'.split(' '),
  };

  let target = '';
  let started = false; let finished = false; let scoreSaved = false;
  let startTime = 0; let endTimer = null; let tickTimer = null;
  let bestScore = Number(localStorage.getItem('chalk_typing_best') || 0);

  function pool() {
    const lang = (typeof currentLang !== 'undefined') ? currentLang : 'ru';
    if (lang === 'ru' || lang === 'uk') return WORDS.ru;
    return WORDS.en;
  }

  function buildPassage() {
    const src = pool();
    const out = [];
    for (let i = 0; i < PASSAGE_WORDS; i++) out.push(src[Math.floor(Math.random() * src.length)]);
    return out.join(' ');
  }

  function renderTarget(typed) {
    const el = document.getElementById('typingText');
    if (!el) return;
    let html = '';
    for (let i = 0; i < target.length; i++) {
      const ch = target[i];
      let cls = '';
      if (i < typed.length) cls = typed[i] === ch ? 'ok' : 'bad';
      else if (i === typed.length) cls = 'cur';
      html += `<span class="${cls}">${ch === ' ' ? '&nbsp;' : ch}</span>`;
    }
    el.innerHTML = html;
    // keep the cursor roughly in view
    const cur = el.querySelector('.cur');
    if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: 'nearest' });
  }

  function stats(typed) {
    let correct = 0;
    for (let i = 0; i < typed.length && i < target.length; i++) if (typed[i] === target[i]) correct++;
    const minutes = Math.max((Date.now() - startTime) / 60000, 1 / 600);
    // Cap at a level no human sustains (~top competitive typists peak ~250) so
    // an instant paste / scripted fill can't post an absurd leaderboard score.
    const wpm = Math.min(300, Math.round((correct / 5) / minutes));
    const acc = typed.length ? Math.round((correct / typed.length) * 100) : 100;
    return { wpm, acc, correct };
  }

  function updateLiveUI(typed) {
    const s = stats(typed);
    const wpmEl = document.getElementById('typingWpm');
    if (wpmEl) wpmEl.textContent = started ? s.wpm : 0;
    const accEl = document.getElementById('typingAcc');
    if (accEl) accEl.textContent = `${started ? s.acc : 100}%`;
    const bestEl = document.getElementById('typingBest');
    if (bestEl) bestEl.textContent = Math.max(bestScore, started ? s.wpm : 0);
  }

  function updateTimeUI() {
    const el = document.getElementById('typingTime');
    if (!el) return;
    const left = started ? Math.max(0, Math.ceil((DURATION_MS - (Date.now() - startTime)) / 1000)) : 60;
    el.textContent = `${left}${T('unit_sec_short')}`;
  }

  function onInput(e) {
    if (finished) return;
    const typed = e.target.value;
    if (!started && typed.length) {
      started = true;
      startTime = Date.now();
      endTimer = setTimeout(finish, DURATION_MS);
      tickTimer = setInterval(() => { updateTimeUI(); updateLiveUI(document.getElementById('typingInput').value); }, 250);
    }
    renderTarget(typed);
    updateLiveUI(typed);
    if (typed.length >= target.length) finish();
  }

  function clearTimers() {
    if (endTimer) { clearTimeout(endTimer); endTimer = null; }
    if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
  }

  // ── Overlays / result ───────────────────────────────────────────────────────
  function showOverlay(text, btnText) {
    const ov = document.getElementById('typingOverlay');
    const txt = document.getElementById('typingOverlayText');
    const btn = document.getElementById('typingStartBtn');
    if (!ov) return;
    txt.textContent = text;
    btn.textContent = btnText;
    ov.classList.remove('hide');
  }
  function hideOverlay() { const ov = document.getElementById('typingOverlay'); if (ov) ov.classList.add('hide'); }
  function hideResult() { const r = document.getElementById('typingResult'); if (r) r.classList.add('hide'); }

  function finish() {
    if (finished) return;
    finished = true;
    started = false;
    clearTimers();
    const input = document.getElementById('typingInput');
    const typed = input ? input.value : '';
    if (input) input.disabled = true;
    const s = stats(typed);
    if (s.wpm > bestScore) { bestScore = s.wpm; localStorage.setItem('chalk_typing_best', String(bestScore)); }
    updateLiveUI(typed);
    const resEl = document.getElementById('typingResult');
    const scoreEl = document.getElementById('typingResultScore');
    const subEl = document.getElementById('typingResultSub');
    const rankEl = document.getElementById('typingResultRank');
    if (scoreEl) scoreEl.textContent = s.wpm;
    if (subEl) subEl.textContent = `${T('game_typing_accuracy')}: ${s.acc}%`;
    if (rankEl) rankEl.textContent = T('games_saving_result');
    if (resEl) resEl.classList.remove('hide');
    saveScoreAndRefresh(s.wpm, rankEl);
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
    const list = document.getElementById('typingLeaderboardList');
    const myRankEl = document.getElementById('typingMyRank');
    if (!list) return;
    try {
      const res = await api(`/api/games/${GAME}/leaderboard?limit=10`);
      const rows = (res.top || []).map((row) => {
        const isMe = currentUser && row.userId === currentUser.id;
        return `<div class="tetris-lb-row${  isMe ? ' me' : ''  }">` +
          `<span class="tetris-lb-rank">${  row.rank  }</span>` +
          `<span class="tetris-lb-ava">${  row.avatarEmoji || '⌨️'  }</span>` +
          `<span class="tetris-lb-name">${  row.username  }</span>` +
          `<span class="tetris-lb-score">${  row.bestScore  }</span>` +
          `</div>`;
      });
      list.innerHTML = rows.length ? rows.join('') : `<div style="font-size:11px;color:var(--muted);padding:6px 2px">${  T('games_none_played')  } — ${  T('msg_be_first_excl')  }</div>`;
      if (myRankEl) {
        myRankEl.textContent = res.me ? (`${T('rating_your_place')  } #${  res.me.rank  } (${  res.me.bestScore  } WPM)`) : '';
      }
    } catch (e) {
      list.innerHTML = `<div style="font-size:11px;color:var(--muted);padding:6px 2px">${  T('rating_err_load')  }</div>`;
    }
  }

  // ── Public API ──────────────────────────────────────────────────────────────
  window.typingResumeOrStart = function () {
    target = buildPassage();
    started = false; finished = false; scoreSaved = false;
    clearTimers();
    const input = document.getElementById('typingInput');
    if (input) { input.disabled = false; input.value = ''; }
    renderTarget('');
    updateLiveUI('');
    updateTimeUI();
    hideOverlay();
    hideResult();
    if (input) input.focus();
  };

  window.openTypingModal = function () {
    const modal = document.getElementById('typingModal');
    if (!modal) return;
    modal.classList.add('show');
    const pill = document.getElementById('typingSearchPill');
    if (pill) pill.style.display = (typeof isSearching !== 'undefined' && isSearching) ? 'inline-flex' : 'none';
    const input = document.getElementById('typingInput');
    if (input && !input.dataset.bound) { input.addEventListener('input', onInput); input.dataset.bound = '1'; }
    if (!target) { target = buildPassage(); renderTarget(''); }
    loadLeaderboard();
    updateLiveUI(input ? input.value : '');
    updateTimeUI();
    if (!started && !finished) showOverlay(T('match_ready_q'), T('games_start'));
  };

  window.closeTypingModal = function () {
    const modal = document.getElementById('typingModal');
    if (modal) modal.classList.remove('show');
    clearTimers();
  };

  document.addEventListener('keydown', (e) => {
    const modal = document.getElementById('typingModal');
    if (!modal || !modal.classList.contains('show')) return;
    if (e.key === 'Escape') window.closeTypingModal();
  });
})();
