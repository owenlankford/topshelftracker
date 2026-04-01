
const NCAA_DIV     = { 2: 'd2', 3: 'd3' };
const PER_PAGE     = 24;
const TIMEOUT      = 30000; // longer — server does heavy lifting
const AUTO_SEC     = 60;
const CACHE_TTL    = 2 * 60 * 1000; // 2 min client-side cache


const S = {
  div: 1, gender: 'both', page: 0,
  games: [], error: null,
  loading: false, progress: 0, lastFetch: null,
  autoTimer: null, cdTimer: null, cdVal: AUTO_SEC,
  teamFilter: '',
  search: '',
};


function cacheKey()      { return `lax_${S.div}_${S.gender}`; }
function loadCache() {
  try {
    const r = localStorage.getItem(cacheKey());
    if (!r) return null;
    const { ts, games } = JSON.parse(r);
    return Date.now() - ts < CACHE_TTL ? games : null;
  } catch { return null; }
}
function saveCache(games) {
  try { localStorage.setItem(cacheKey(), JSON.stringify({ ts: Date.now(), games })); }
  catch {}
}
function clearCache() {
  try {
    [1,2,3].forEach(d => ['both','men','women'].forEach(g =>
      localStorage.removeItem(`lax_${d}_${g}`)
    ));
  } catch {}
}


async function fetchSeason() {
  S.error = null;
  const url  = `/api/season/${S.div}/${S.gender}`;
  try {
    const ctrl = new AbortController();
    const tid  = setTimeout(() => ctrl.abort(), TIMEOUT);
    const r    = await fetch(url, { headers: { Accept: 'application/json' }, signal: ctrl.signal });
    clearTimeout(tid);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const games = await r.json();
    if (!Array.isArray(games) || !games.length) {
      S.error = 'No games returned. Try refreshing.';
      return [];
    }
    return games;
  } catch(e) {
    S.error = e.name === 'AbortError' ? 'Request timed out.' : (e.message || 'Network error');
    return [];
  }
}


function gameInvolvesTeam(gm, team) {
  return !team || gm.home.short === team || gm.away.short === team;
}
function filteredGames() {
  let games = S.teamFilter ? S.games.filter(g => gameInvolvesTeam(g, S.teamFilter)) : S.games;
  if (S.search) {
    const q = S.search.toLowerCase();
    games = games.filter(g =>
      g.home.short.toLowerCase().includes(q) ||
      g.away.short.toLowerCase().includes(q) ||
      g.home.abbr.toLowerCase().includes(q)  ||
      g.away.abbr.toLowerCase().includes(q)
    );
  }
  return games;
}
function populateTeamFilter() {
  const sel  = document.getElementById('team-filter');
  const prev = S.teamFilter;
  const teams = [...new Set(S.games.flatMap(g => [g.home.short, g.away.short]))]
    .filter(Boolean).sort((a,b) => a.localeCompare(b));
  sel.innerHTML = '<option value="">All Teams</option>' +
    teams.map(t => `<option value="${t}"${t===prev?' selected':''}>${t}</option>`).join('');
  S.teamFilter = teams.includes(prev) ? prev : '';
  sel.value = S.teamFilter;
  sel.className = S.teamFilter ? 'active' : '';
}
function setTeamFilter(val) {
  S.teamFilter = val;
  S.page = 0;
  document.getElementById('team-filter').className = val ? 'active' : '';
  renderGames();
}

function getTeamList() {
  return [...new Set(S.games.flatMap(g => [g.home.short, g.away.short]))]
    .filter(Boolean).sort((a,b) => a.localeCompare(b));
}
function showAutocomplete(q) {
  const box = document.getElementById('search-autocomplete');
  if (!q) { box.style.display = 'none'; return; }
  const matches = getTeamList().filter(t => t.toLowerCase().includes(q.toLowerCase())).slice(0, 8);
  if (!matches.length) { box.style.display = 'none'; return; }
  box.innerHTML = matches.map(t => {
    const safe = t.replace(/'/g, "\'");
    const hi   = t.replace(new RegExp('(' + q.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&') + ')', 'gi'), '<strong>$1</strong>');
    return '<div class="ac-item" onmousedown="pickAutocomplete(\'' + safe + '\')">' + hi + '</div>';
  }).join('');
  box.style.display = 'block';
}
function hideAutocomplete() {
  const box = document.getElementById('search-autocomplete');
  if (box) box.style.display = 'none';
}
function pickAutocomplete(name) {
  S.search = name;
  S.page = 0;
  const el = document.getElementById('search-input');
  el.value = name;
  el.classList.add('active');
  hideAutocomplete();
  renderGames();
}

function setSearch(val) {
  S.search = val.trim();
  S.page = 0;
  const el = document.getElementById('search-input');
  el.classList.toggle('active', !!S.search);
  showAutocomplete(val.trim());
  renderGames();
}
function clearSearch() {
  S.search = '';
  S.page = 0;
  const el = document.getElementById('search-input');
  el.value = '';
  el.classList.remove('active');
  hideAutocomplete();
  renderGames();
}


function sortedPast() {
  return filteredGames().filter(g => g.status === 'post').sort((a,b) => b.epoch - a.epoch);
}
function sortedUpcoming() {
  const today = new Date(); today.setHours(0,0,0,0);
  const ts0   = today.getTime() / 1000;
  return filteredGames()
    .filter(g => {
      if (g.status !== 'pre') return false;
      const ts = g.epoch > 0 ? g.epoch : (g.date ? new Date(g.date).getTime()/1000 : 0);
      return ts === 0 || ts >= ts0;
    })
    .sort((a,b) => {
      const ta = a.epoch > 0 ? a.epoch : (a.date ? new Date(a.date).getTime()/1000 : 0);
      const tb = b.epoch > 0 ? b.epoch : (b.date ? new Date(b.date).getTime()/1000 : 0);
      return ta - tb;
    });
}
function sortedNonLive() { return sortedPast(); }


const EMO = { in:'🔴', pre:'🕐', post:'✅', postponed:'⚠️', canceled:'❌', suspended:'⏸️' };

function liveCard(gm) {
  const {home:h, away:a, gender:g} = gm;
  const ac  = a.winner ? 'winner' : 'away';
  const hc  = h.winner ? 'winner' : 'home';
  const clock = gm.status_desc || 'In Progress';
  const bcast = gm.broadcast ? `<span>📺 ${gm.broadcast}</span>` : '';
  const loc   = gm.location  ? `<span>📍 ${gm.location}</span>`  : '';
  return `<div class="live-card">
  <div class="live-card-top">
    <span class="live-clock">${clock}</span>
    <span class="live-gender-badge ${g}">${g==='men'?'♂ Men':'♀ Women'}</span>
  </div>
  <div class="score-table">
    <div class="live-score-row">
      <span class="live-abbr ${ac}">${a.abbr}</span>
      <span class="live-team-name">${a.short} <span style="font-size:10px;color:var(--muted2)">${a.record}</span></span>
      <span class="live-score ${a.winner?'winner':''}">${a.score}</span>
    </div>
    <div class="live-score-row">
      <span class="live-abbr ${hc}">${h.abbr}</span>
      <span class="live-team-name">${h.short} <span style="font-size:10px;color:var(--muted2)">${h.record}</span></span>
      <span class="live-score ${h.winner?'winner':''}">${h.score}</span>
    </div>
  </div>
  <div class="live-divider"></div>
  <div class="live-card-footer"><div class="live-meta">${bcast}${loc}</div></div>
</div>`;
}

function renderLive() {
  const live = filteredGames().filter(g => g.status === 'in');
  const sec  = document.getElementById('live-section');
  const rail = document.getElementById('live-rail');
  const cnt  = document.getElementById('live-count');
  if (!live.length) { sec.style.display = 'none'; return; }
  sec.style.display = 'block';
  cnt.textContent   = `${live.length} game${live.length!==1?'s':''} live`;
  rail.innerHTML    = live.map(liveCard).join('');
}

function fmtUpcomingDate(gm) {
  try {
    const d = new Date(gm.date || gm.epoch*1000);
    return isNaN(d) ? '' : d.toLocaleDateString([], {weekday:'short',month:'short',day:'numeric'});
  } catch { return ''; }
}
function fmtUpcomingTime(gm) {
  const desc = gm.status_desc || '';
  if (desc && !desc.startsWith('0001')) return desc;
  try {
    const d = new Date(gm.date || gm.epoch*1000);
    return isNaN(d) ? 'TBD' : d.toLocaleTimeString([],{hour:'numeric',minute:'2-digit',timeZoneName:'short'});
  } catch { return 'TBD'; }
}

function upcomingCard(gm) {
  const {home:h, away:a, gender:g} = gm;
  const bcast = gm.broadcast ? `<span>📺 ${gm.broadcast}</span>` : '';
  const loc   = gm.location  ? `<span>📍 ${gm.location}</span>`  : '';
  const note  = gm.note      ? `<span>${gm.note}</span>`          : '';
  return `<div class="upcoming-card">
  <div class="upcoming-card-top">
    <span class="upcoming-time">${fmtUpcomingTime(gm)}</span>
    <span class="upcoming-date-chip">${fmtUpcomingDate(gm)}</span>
    <span class="live-gender-badge ${g}" style="font-size:10px;padding:1px 7px">${g==='men'?'♂':'♀'}</span>
  </div>
  <div>
    <div class="upcoming-vs-row">
      <span class="upcoming-abbr away">${a.abbr}</span>
      <span class="upcoming-team-name">${a.short} <span class="upcoming-record">${a.record}</span></span>
    </div>
    <div style="height:6px;display:flex;align-items:center;padding:2px 0">
      <span style="font-family:'Barlow Condensed',sans-serif;font-size:10px;font-weight:700;color:var(--muted2);letter-spacing:1px">VS</span>
    </div>
    <div class="upcoming-vs-row">
      <span class="upcoming-abbr home">${h.abbr}</span>
      <span class="upcoming-team-name">${h.short} <span class="upcoming-record">${h.record}</span></span>
    </div>
  </div>
  <div class="upcoming-vs-divider"></div>
  <div class="upcoming-card-footer"><div class="upcoming-meta">${bcast}${loc}${note}</div></div>
</div>`;
}

function renderUpcoming() {
  const upcoming = sortedUpcoming();
  const sec  = document.getElementById('upcoming-section');
  const rail = document.getElementById('upcoming-rail');
  const cnt  = document.getElementById('upcoming-count');
  if (!upcoming.length) { sec.style.display = 'none'; return; }
  sec.style.display = 'block';
  cnt.textContent   = `${upcoming.length} game${upcoming.length!==1?'s':''} scheduled`;
  rail.innerHTML    = upcoming.map(upcomingCard).join('');
}

function fmtTime(gm) {
  const d = gm.status_desc || '';
  if (d && !d.startsWith('0001')) return d;
  try { return new Date(gm.date).toLocaleTimeString([],{hour:'numeric',minute:'2-digit',timeZoneName:'short'}); }
  catch { return 'Scheduled'; }
}

function pastCard(gm) {
  const {status:s, home:h, away:a, gender:g} = gm;
  const cls = s === 'pre' ? 'pre' : 'post';
  const ac  = a.winner ? 'winner' : 'away';
  const hc  = h.winner ? 'winner' : 'home';
  const as_ = a.winner ? 'winner' : '';
  const hs  = h.winner ? 'winner' : '';
  const stxt = s === 'post'
    ? `<span class="status-post">${gm.status_desc||'Final'}</span>`
    : `<span class="status-pre">${fmtTime(gm)}</span>`;
  const bcast = gm.broadcast ? `<span class="broadcast">📺 ${gm.broadcast}</span>` : '';
  const note  = gm.note      ? `<span>${gm.note}</span>` : '';
  const loc   = gm.location  ? `<span>📍 ${gm.location}</span>` : '';
  return `<div class="game-card ${cls}">
  <div class="card-header">
    <span class="matchup-label ${cls}">${a.short} @ ${h.short}</span>
    <span class="gender-badge ${g}">${g==='men'?'♂ Men':'♀ Women'}</span>
  </div>
  <div class="score-table">
    <div class="score-row">
      <div class="team-info"><span class="team-abbr ${ac}">${a.abbr}</span><span class="team-name">${a.short}</span><span class="team-record">${a.record}</span></div>
      <span></span><span class="team-score ${as_}">${a.score}</span>
    </div>
    <div class="score-row">
      <div class="team-info"><span class="team-abbr ${hc}">${h.abbr}</span><span class="team-name">${h.short}</span><span class="team-record">${h.record}</span></div>
      <span class="score-divider">—</span><span class="team-score ${hs}">${h.score}</span>
    </div>
  </div>
  <div class="card-footer">
    <div class="status-line"><span class="status-emoji">${EMO[s]||'•'}</span>${stxt}${bcast}</div>
    ${note||loc?`<div class="card-meta">${note}${loc}</div>`:''}
  </div>
</div>`;
}

function renderGrid() {
  const grid  = document.getElementById('game-grid');
  const past  = sortedPast();
  const total = past.length;
  const pages = Math.max(1, Math.ceil(total/PER_PAGE));
  S.page      = Math.min(S.page, pages-1);
  const vis   = past.slice(S.page*PER_PAGE, (S.page+1)*PER_PAGE);
  const divLbl = {1:'Division I',2:'Division II',3:'Division III'}[S.div];

  document.getElementById('games-section-title').textContent = 'Past Results';
  document.getElementById('games-section-count').textContent = total ? `${total} games` : '';

  if (S.error && !S.games.length) {
    grid.innerHTML = `<div class="error-state grid-empty">
      <div class="empty-icon">⚠️</div>
      <div class="empty-title error-title">Connection Problem</div>
      <div class="empty-sub">${S.error}</div></div>`;
  } else if (!vis.length && !S.loading) {
    grid.innerHTML = `<div class="empty-state grid-empty">
      <div class="empty-icon">🥍</div>
      <div class="empty-title">No ${divLbl} Results Yet</div>
      <div class="empty-sub">Try a different division or gender filter.</div></div>`;
  } else if (vis.length) {
    grid.innerHTML = vis.map(pastCard).join('');
  }

  const pag = document.getElementById('pagination');
  if (pages > 1) {
    pag.style.display = 'flex';
    document.getElementById('page-info').textContent = `Page ${S.page+1} / ${pages}  ·  ${total} games`;
    document.getElementById('btn-prev').disabled = S.page === 0;
    document.getElementById('btn-next').disabled = S.page === pages-1;
  } else { pag.style.display = 'none'; }
}

function renderGames() {
  populateTeamFilter();
  const fg = filteredGames();
  document.getElementById('sum-live').textContent = fg.filter(g => g.status==='in').length;
  document.getElementById('sum-pre').textContent  = sortedUpcoming().length;
  renderLive();
  renderUpcoming();
  renderGrid();
}


function showProgress() {
  const w = document.getElementById('progress-wrap');
  const b = document.getElementById('progress-bar');
  w.style.display = S.loading ? 'block' : 'none';
  b.style.width   = S.progress + '%';
  if (S.loading) document.getElementById('fetch-status').textContent = 'Loading…';
}

function renderHeader() {
  const dot = document.getElementById('live-dot');
  const st  = document.getElementById('fetch-status');
  if (!S.loading) {
    showProgress();
    if (S.error && !S.games.length) {
      dot.className = 'live-dot'; st.textContent = '⚠ '+S.error; st.style.color = 'var(--yellow)';
    } else {
      dot.className = 'live-dot ok';
      const e = S.lastFetch ? Math.round((Date.now()-S.lastFetch)/1000) : null;
      st.textContent = e!==null&&e<5 ? 'Updated just now' : e ? `Updated ${e}s ago` : '';
      st.style.color = '';
    }
  }
  [1,2,3].forEach(d => {
    document.getElementById(`btn-d${d}`).className = 'btn' + (S.div===d ? ` active-div${d}` : '');
  });
  ['both','men','women'].forEach(g => {
    document.getElementById(`btn-${g}`).className = 'btn' + (S.gender===g ? ` active-${g}` : '');
  });
  const sl = document.getElementById('season-label');
  sl.style.color = {1:'var(--div1)',2:'var(--div2)',3:'var(--div3)'}[S.div];
  sl.textContent = `2026 · ${{1:'Division I',2:'Division II',3:'Division III'}[S.div]}`;
}


async function doFetch() {
  if (S.loading) return;

  // Show cache instantly while fresh data loads
  const cached = loadCache();
  if (cached && cached.length) {
    S.games = cached;
    renderGames();
    document.getElementById('fetch-status').textContent = 'Updating…';
  }

  S.loading = true; S.progress = 0;
  document.getElementById('btn-refresh').classList.add('spinning');
  showProgress(); renderHeader();

  try {
    const games = await fetchSeason();
    if (games.length) {
      S.games     = games;
      S.lastFetch = Date.now();
      saveCache(games);
    }
  } catch(e) { S.error = e.message || 'Unknown error'; }

  S.loading = false;
  document.getElementById('btn-refresh').classList.remove('spinning');
  renderHeader(); renderGames();
}

function startAuto() {
  clearInterval(S.autoTimer); clearInterval(S.cdTimer); S.cdVal = AUTO_SEC;
  S.autoTimer = setInterval(() => { doFetch(); S.cdVal = AUTO_SEC; }, AUTO_SEC*1000);
  S.cdTimer   = setInterval(() => {
    S.cdVal = Math.max(0, S.cdVal-1);
    document.getElementById('countdown').textContent = `· ${S.cdVal}s`;
  }, 1000);
}


function resetFilter() {
  S.teamFilter = '';
  S.search = '';
  document.getElementById('team-filter').innerHTML = '<option value="">All Teams</option>';
  document.getElementById('team-filter').className = '';
  const si = document.getElementById('search-input');
  if (si) { si.value = ''; si.classList.remove('active'); }
}
function setDiv(d) {
  if (S.div===d && S.games.length) return;
  S.div=d; S.page=0; S.games=[]; resetFilter(); renderHeader(); doFetch();
}
function setGender(g) {
  if (S.gender===g && S.games.length) return;
  S.gender=g; S.page=0; S.games=[]; resetFilter(); renderHeader(); doFetch();
}
function changePage(n) {
  const p = Math.max(1, Math.ceil(sortedPast().length/PER_PAGE));
  S.page  = Math.max(0, Math.min(S.page+n, p-1));
  renderGrid(); window.scrollTo({top:0,behavior:'smooth'});
}
function manualRefresh() {
  clearCache(); S.games=[]; resetFilter(); doFetch(); startAuto();
}

document.addEventListener('keydown', e => {
  if (e.target.tagName==='INPUT' || e.target.tagName==='SELECT' || e.target.id==='search-input') return;
  const k = e.key;
  if      (k==='1') setDiv(1);
  else if (k==='2') setDiv(2);
  else if (k==='3') setDiv(3);
  else if (k==='m') setGender('men');
  else if (k==='w') setGender('women');
  else if (k==='b') setGender('both');
  else if (k==='r') manualRefresh();
  else if (k==='n'||k==='ArrowRight') changePage(1);
  else if (k==='p'||k==='ArrowLeft')  changePage(-1);
});


window.setDiv          = setDiv;
window.setGender       = setGender;
window.setTeamFilter   = setTeamFilter;
window.setSearch       = setSearch;
window.clearSearch     = clearSearch;
window.hideAutocomplete= hideAutocomplete;
window.pickAutocomplete= pickAutocomplete;
window.changePage      = changePage;
window.manualRefresh   = manualRefresh;


(function() {
  renderHeader(); doFetch(); startAuto();
})();
