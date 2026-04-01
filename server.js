const http  = require('http');
const https = require('https');

const PORT         = 3000;
const ESPN_BASE    = 'https://site.api.espn.com/apis/site/v2/sports/lacrosse';
const NCAA_BASE    = 'https://ncaa-api.henrygd.me';
const TIMEOUT_MS   = 8000;
const CACHE_TTL_MS = 2 * 60 * 1000;

const cache = new Map();

function getCache(key) {
  const e = cache.get(key);
  if (!e) return null;
  if (Date.now() - e.ts > CACHE_TTL_MS) { cache.delete(key); return null; }
  return e.data;
}
function setCache(key, data) {
  cache.set(key, { ts: Date.now(), data });
}

function fetchJson(url) {
  return new Promise((resolve) => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
      timeout: TIMEOUT_MS,
    }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

function pad(n) { return String(n).padStart(2, '0'); }

function dateRange(startYMD, endYMD) {
  const dates = [];
  const toD = s => new Date(+s.slice(0,4), +s.slice(4,6)-1, +s.slice(6,8));
  const fmD = d => d.getFullYear() + pad(d.getMonth()+1) + pad(d.getDate());
  let cur = toD(startYMD), end = toD(endYMD);
  while (cur <= end) { dates.push(fmD(cur)); cur.setDate(cur.getDate()+1); }
  return dates;
}

function seasonStart(div) {
  return div === 1 ? '20260131' : '20260214';
}

function seasonEnd() {
  
  const d = new Date();
  d.setDate(d.getDate() + 21);
  const ymd = d.getFullYear() + pad(d.getMonth()+1) + pad(d.getDate());
  return ymd < '20260601' ? ymd : '20260531';
}

function espnDayUrl(gender, date) {
  const league = gender === 'men' ? 'mens-college-lacrosse' : 'womens-college-lacrosse';
  return `${ESPN_BASE}/${league}/scoreboard?dates=${date}`;
}

function ncaaDayUrl(gender, div, date) {
  const sport = gender === 'men' ? 'lacrosse-men' : 'lacrosse-women';
  const d     = { div: { 2: 'd2', 3: 'd3' } }[div] || (div === 2 ? 'd2' : 'd3');
  const y = date.slice(0,4), mo = date.slice(4,6), dy = date.slice(6,8);
  return `${NCAA_BASE}/scoreboard/${sport}/${div===2?'d2':'d3'}/${y}/${mo}/${dy}/all-conf`;
}

async function fetchAllDates(urls, batchSize = 20) {
  const results = [];
  for (let i = 0; i < urls.length; i += batchSize) {
    const batch = urls.slice(i, i + batchSize);
    const data  = await Promise.all(batch.map(fetchJson));
    results.push(...data);
  }
  return results;
}

async function fetchFullSeason(div, gender) {
  const cacheKey = `season_${div}_${gender}`;
  const cached   = getCache(cacheKey);
  if (cached) return cached;

  const genders = gender === 'both' ? ['men', 'women'] : [gender];
  const dates   = dateRange(seasonStart(div), seasonEnd());
  const allGames = [];
  const seen    = new Set();

  for (const g of genders) {
    const urls = dates.map(d =>
      div === 1 ? espnDayUrl(g, d) : ncaaDayUrl(g, div, d)
    );

    const responses = await fetchAllDates(urls, 20);

    responses.forEach((data, idx) => {
      if (!data) return;
      const games = div === 1
        ? parseEspn(data, g)
        : parseNcaa(data, g);
      for (const gm of games) {
        const key = gm.id || `${gm.epoch}|${gm.home.abbr}|${gm.away.abbr}`;
        if (seen.has(key)) continue;
        seen.add(key);
        allGames.push(gm);
      }
    });
  }

  setCache(cacheKey, allGames);
  return allGames;
}

function parseEspn(data, gender) {
  return (data.events || []).map(ev => {
    const comp = (ev.competitions || [{}])[0];
    const stt  = (comp.status || {}).type || {};
    const cs   = comp.competitors || [];
    const home = cs.find(c => c.homeAway === 'home') || {};
    const away = cs.find(c => c.homeAway === 'away') || {};

    const mkT = c => {
      const t  = c.team || {};
      const rc = (c.records || [{}])[0] || {};
      return {
        abbr:   t.abbreviation || '???',
        short:  t.shortDisplayName || t.displayName || '???',
        score:  c.score || '0',
        record: rc.summary || '0-0',
        winner: c.winner || false,
      };
    };

    const addr  = (comp.venue || {}).address || {};
    const bcast = (comp.broadcasts || []).map(b => (b.names||[])[0]).filter(Boolean).join(', ');
    const notes = comp.notes || [];
    let epoch = 0;
    try { epoch = Math.floor(new Date(ev.date).getTime() / 1000); } catch {}

    return {
      id:          ev.id || '',
      date:        ev.date || '',
      epoch,
      status:      (stt.state || 'pre').toLowerCase(),
      status_desc: stt.shortDetail || '',
      home:        mkT(home),
      away:        mkT(away),
      location:    [addr.city, addr.state].filter(Boolean).join(', '),
      broadcast:   bcast,
      note:        notes[0] ? notes[0].headline || '' : '',
      gender,
    };
  });
}

function parseNcaa(data, gender) {
  return (data.games || []).map(entry => {
    const g   = entry.game || {};
    const raw = (g.gameState || 'pre').toLowerCase();
    const status = raw === 'live' || raw === 'linescore' ? 'in'
                 : raw === 'final' || raw === 'post'     ? 'post' : 'pre';
    let desc = '';
    if (status === 'in')        desc = `${g.currentPeriod||''} ${g.contestClock||''}`.trim();
    else if (status === 'post') desc = g.finalMessage || 'Final';
    else                        desc = g.startTime || '';

    const mkT = side => {
      const nm = side.names || {};
      return {
        abbr:   (nm.char6 || nm.short || '???').slice(0, 6),
        short:  nm.short || nm.char6 || '???',
        score:  side.score || '0',
        record: (side.description || '').replace(/[()]/g, '').trim() || '0-0',
        winner: side.winner || false,
      };
    };

    return {
      id:          g.gameID || '',
      date:        g.startDate || '',
      epoch:       parseInt(g.startTimeEpoch || 0, 10),
      status,
      status_desc: desc,
      home:        mkT(g.home || {}),
      away:        mkT(g.away || {}),
      location:    '',
      broadcast:   g.network || '',
      note:        '',
      gender,
    };
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  const url  = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  try {
    if (path.startsWith('/api/season/')) {
      const parts  = path.split('/');
      const div    = parseInt(parts[3], 10);
      const gender = parts[4];

      if (![1,2,3].includes(div) || !['men','women','both'].includes(gender)) {
        res.writeHead(400); res.end('{}'); return;
      }

      const games = await fetchFullSeason(div, gender);
      res.end(JSON.stringify(games));

    } else if (path === '/api/cache/clear') {
      cache.clear();
      res.end(JSON.stringify({ ok: true, message: 'Cache cleared' }));

    } else {
      res.writeHead(404);
      res.end('{}');
    }
  } catch (e) {
    console.error('Server error:', e.message);
    res.writeHead(500);
    res.end('{}');
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`LaxStats API running on port ${PORT}`);
});
