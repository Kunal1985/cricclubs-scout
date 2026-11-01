// Scan teams of a legacy (.do) CricClubs club into data/store, then publish.
// Usage: CHROME_PATH=... node scripts/legacy-team.js <ClubCode> "<Team name>" [...more teams]
//   FULL=1        refetch every season's match list (default: last/prev2 only when not yet scanned)
//   REPARSE=1     (or --reparse) rebuild team data from the raw cache with zero network requests
//   CONCURRENCY=n parallel scorecard tabs (default 2, max 4; drops to 1 on any Cloudflare sign)
// Raw scorecard HTML (scripts/styles stripped, gzipped) is cached forever under
// data/store/leagues/<code>/raw/scorecards/<matchId>.html.gz; grounds in raw/grounds.json.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const store = require('../lib/store');
const { Pager, pool, stats, state, concurrency } = require('../lib/pager');
const argv = process.argv.slice(2);
const REPARSE = process.env.REPARSE === '1' || argv.includes('--reparse');
const FULL = process.env.FULL === '1' || argv.includes('--full');
const [code, ...teams] = argv.filter(a => !/^--/.test(a));
const base = `https://cricclubs.com/${code}`;
const rawDir = path.join(store.STORE, 'leagues', store.codeKey(code), 'raw');
const rawFile = mid => path.join(rawDir, 'scorecards', mid + '.html.gz');
const groundsFile = path.join(rawDir, 'grounds.json');
// Toss lives only inside an inline script's ball-by-ball JSON; keep it in a <template> (no innerText).
const keepToss = h => { const t = (h.match(/<strong>([^<]*won the toss[^<]*)<\/strong>/) || [])[1]; return t ? `<template id="cs-toss"><strong>${t}</strong></template>` : ''; };
const strip = h => keepToss(h) + h.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<!--[\s\S]*?-->/g, '').replace(/<link[^>]*>/gi, '');
const readRaw = mid => { try { return zlib.gunzipSync(fs.readFileSync(rawFile(mid))).toString('utf8'); } catch { return null; } };
function writeRaw(mid, html) { fs.mkdirSync(path.dirname(rawFile(mid)), { recursive: true }); const t = rawFile(mid) + '.tmp'; fs.writeFileSync(t, zlib.gzipSync(strip(html))); fs.renameSync(t, rawFile(mid)); }
const readJSON = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJSON = (f, o) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f + '.tmp', JSON.stringify(o, null, 1)); fs.renameSync(f + '.tmp', f); };
// A completed match has a result line; only those are cached forever.
const isFinal = html => /won by|Forfeit|No Result|tied|Abandon|Winner:/i.test(html);
const PARSE = () => {
    const txt = e => (e ? e.textContent : '').replace(/\s+/g, ' ').trim();
    const body = document.body.innerText.replace(/[ \t]+/g, ' ');
    const lines = body.split('\n').map(l => l.trim()).filter(Boolean); const out = { header: body, result: lines.find(l => /won by|Forfeit|No Result|tied|Abandon/i.test(l) && l.length < 120) || '', innings: [] };
    const toss = (document.documentElement.innerHTML.match(/<strong>([^<]*won the toss[^<]*)<\/strong>/) || [])[1] || null;
    out.toss = toss;
    for (const tb of document.querySelectorAll('table')) {
      const head = txt(tb.querySelector('thead'));
      const rows = [...tb.querySelectorAll('tbody tr')].map(tr => [...tr.children]);
      if (/innings R B 4s 6s SR/.test(head) || /^.*innings\s+R\s+B/.test(head)) {
        const team = head.replace(/\s+innings.*$/, '').trim();
        const bat = []; let extras = null, total = null;
        for (const c of rows) {
          const t0 = txt(c[0]);
          if (/^Extras/.test(t0)) { extras = txt(tb.querySelector('tbody')).match(/Extras.*?\(b (\d+) lb (\d+) w (\d+) nb (\d+)/); continue; }
          if (/^Total/.test(t0)) { const m = c.map(txt).join(' ').match(/\((\d+) wickets?,\s*([\d.]+) overs?\s*\)/) || []; total = { w: m[1], o: m[2], r: c.map(txt).filter(x => /^\d+$/.test(x)).pop() }; continue; }
          const b = c[0].querySelector('b'); if (!b || c.length < 6) continue;
          const nums = c.slice(-5).map(txt);
          const how = txt(c[1]);
          bat.push({ name: txt(b).replace(/[*†\u2020]/g, '').trim(), howText: how, r: +nums[0], b: +nums[1], f: +nums[2], s: +nums[3] });
        }
        out.innings.push({ team, bat, extras, total, bowl: [] });
      } else if (/O\s+M\s+Dot\s+R\s+W\s+Econ/.test(head) && out.innings.length) {
        const inn = out.innings[out.innings.length - 1];
        for (const c of rows) {
          const b = c.map(x => x.querySelector('b')).find(x => x && x.closest('a')); if (!b) continue;
          const name = txt(b).replace(/[*†\u2020]/g, '').trim();
          const i = c.findIndex(x => x.contains(b));
          const v = c.slice(i + 1).map(txt);
          const ex = v.slice(6).join(' ');
          inn.bowl.push({ name, o: v[0], dots: +v[2], r: +v[3], w: +v[4], wd: +((ex.match(/(\d+)\s*w\b/) || [])[1] || 0), nb: +((ex.match(/(\d+)\s*nb\b/) || [])[1] || 0) });
        }
      }
    }
    return out;
  };
const FIXTURES = () => [...document.querySelectorAll('tr')].map(tr => [...tr.children].map(c => c.textContent.replace(/\s+/g, ' ').trim())).filter(r => r.length >= 8 && r.some(c => /^\d\d\/\d\d\/\d{4}$/.test(c)));
const HOW = t => { t = t.trim(); if (!t || /^not out|^retired not|^dnb/i.test(t)) return null;
  if (/^run out/i.test(t)) return 'ro'; if (/^st /i.test(t)) return 'st'; if (/^lbw/i.test(t)) return 'lbw';
  if (/^c\s*&\s*b/i.test(t)) return 'ct'; if (/^c\s*[†\u2020]/.test(t)) return 'ctw'; if (/^c /i.test(t)) return 'ct';
  if (/^b /i.test(t)) return 'b'; if (/hit wicket/i.test(t)) return 'hw'; if (/retired/i.test(t)) return 'rt'; return 'other'; };
const balls = o => { const [a, b] = String(o).split('.'); return Number(a) * 6 + Number(b || 0); };
// Forfeit/no-innings: take the other "Name 123/4" score line from the header that is not us (any league).
function forfeitOpponent(header, team) {
  for (const m of header.matchAll(/^\s*([^\n/]*?\S)\s+\d+\/\d+/gm)) { const n = m[1].trim(); if (n && n !== team && !n.includes(team) && n.length < 60) return n; }
  return undefined;
}
function buildMatch(sc, mid, s, team) {
  const hm = sc.header.match(/(\d\d)\/(\d\d)\/(\d{4})/);
  const date = hm ? `${hm[3]}-${hm[1]}-${hm[2]}` : null;
  const res = sc.result.trim();
  const winner = (res.match(/Winner: (.+)$/) || res.match(/^(.+?) won /) || [])[1];
  const inns = sc.innings;
  if (inns.length < 1) return null;
  const ours = inns.find(i => i.team === team), theirs = inns.find(i => i.team !== team);
  const opp = theirs ? theirs.team : forfeitOpponent(sc.header, team);
  let tossWonByUs = null, tossDecision = null;
  if (sc.toss) { tossWonByUs = sc.toss.startsWith(team + ' won'); tossDecision = /bat/i.test(sc.toss) ? 'bat' : 'bowl'; }
  const outcome = winner ? (winner.trim() === team ? 'W' : 'L') : /tie/i.test(res) ? 'T' : 'NR';
  return {
    id: 'legacy-' + mid, date, series: s.name, seriesId: s.id, opponent: opp, ground: null, result: res, forfeit: /forfeit|abandon/i.test(res) || !(ours && ours.bat.length || theirs && theirs.bat.length), outcome,
    tossWonByUs, tossDecision, battedFirst: inns[0].team === team,
    innings: inns.map(i => ({ team: i.team, runs: Number(i.total && i.total.r) || 0, wkts: Number(i.total && i.total.w) || 0, overs: String(i.total && i.total.o || '0') })),
    batting: ours ? ours.bat.map((x, n) => { const o = { name: x.name, r: x.r, b: x.b, f: x.f, s: x.s, out: !!HOW(x.howText), pos: n + 1 }; if (o.out) o.how = HOW(x.howText); return o; }) : [],
    bowling: theirs ? theirs.bowl.map(x => ({ name: x.name, balls: balls(x.o), r: x.r, w: x.w, dots: x.dots, wd: x.wd, nb: x.nb })) : [],
    dismissals: theirs ? theirs.bat.filter(x => HOW(x.howText)).map(x => ({ how: HOW(x.howText), text: x.howText })) : [],
    _hm: hm && `${hm[1]}/${hm[2]}/${hm[3]}`,
  };
}

const pager = new Pager();
async function clubIdFor(league) {
  if (league.clubId) return league.clubId;
  if (REPARSE) throw new Error('reparse: clubId not saved in league.json');
  const h = await pager.html(`${base}/viewPointsTable.do`, { kind: 'pointsTable' });
  league.clubId = h.match(/clubId=(\d+)/)[1];
  store.writeLeague(league);
  return league.clubId;
}
async function matchIds(s, tid, gid, clubId) {
  const h = await pager.html(`${base}/listMatches.do?league=${gid}&teamId=${tid}&internalClubId=null&year=null&clubId=${clubId}`, { kind: 'listMatches', ready: 'table' });
  return [...new Set(h.match(/viewScorecard\.do\?matchId=\d+/g) || [])].map(x => x.split('=')[1]);
}
async function download(mids, clubId) {
  const need = mids.filter(m => !fs.existsSync(rawFile(m)));
  stats.cached += mids.length - need.length;
  const n = concurrency();
  const slots = Array.from({ length: n }, () => ({ pg: null }));
  await pool(need, n, async (mid, w) => {
    try {
      const h = await pager.html(`${base}/viewScorecard.do?matchId=${mid}&clubId=${clubId}`, { ready: 'table', slot: slots[w], kind: 'scorecard' });
      if (isFinal(h)) writeRaw(mid, h); else console.error('  not final yet, not cached', mid);
      return h;
    } catch (e) { console.error('  scorecard failed', mid, e.message); }
  });
  for (const s of slots) if (s.pg) await pager.closeTab(s.pg);
}

async function scanTeam(league, team, clubId) {
  const prev = store.readTeam(code, team) || { series: {}, matches: {} };
  const grounds = readJSON(groundsFile, {});
  const standings = store.listStandings(code);
  const doc = { team, league: { code, name: league.name }, series: {}, matches: {} };
  const seen = new Set();
  for (const k of store.SEASON_KEYS) {
    const s = league.seasons[k]; if (!s || !s.teams || !s.teams[team]) continue;
    if (league.excludeSeries && new RegExp(league.excludeSeries, 'i').test(s.name)) continue;
    if (seen.has(s.id)) continue; seen.add(s.id);
    const old = prev.series[s.id];
    // Past seasons are fixed: reuse the saved list. Current season (or FULL) refetches the list only.
    let mids, scrapedAt;
    if (REPARSE || (old && k !== 'current' && !FULL)) {
      if (!old) { console.error(`  ${k} ${s.name}: not scanned before, skipped in reparse`); continue; }
      mids = old.matchIds.map(id => id.replace(/^legacy-/, '')); scrapedAt = old.scrapedAt;
      if (!REPARSE) {
        const missing = mids.filter(m => !fs.existsSync(rawFile(m)) && !prev.matches['legacy-' + m]);
        if (missing.length) await download(missing, clubId);
        for (const id of old.matchIds) if (prev.matches[id] && !readRaw(id.replace(/^legacy-/, ''))) doc.matches[id] = prev.matches[id];
      }
    } else {
      const tid = s.teams[team];
      const st = standings.find(d => d.series.id === s.id);
      const gname = st && st.teams[team] && st.teams[team].group;
      const gid = ((s.groups || []).find(g => (g.name === gname) || ('Group ' + g.name) === gname) || {}).id;
      mids = await matchIds(s, tid, gid, clubId); scrapedAt = new Date().toISOString();
      await download(mids, clubId);
      s._gid = gid;
    }
    const ids = []; const noGround = [];
    for (const mid of mids) {
      const id = 'legacy-' + mid;
      const html = readRaw(mid);
      if (!html) { if (doc.matches[id]) ids.push(id); else if (prev.matches[id]) { doc.matches[id] = prev.matches[id]; ids.push(id); } else console.error('  missing scorecard', mid); continue; }
      const sc = await pager.parse(html, PARSE);
      const m = buildMatch(sc, mid, s, team);
      if (!m) { console.error('  no innings', mid); continue; }
      m.ground = grounds[mid] !== undefined ? grounds[mid] : prev.matches[id] ? prev.matches[id].ground : undefined;
      if (m.ground === undefined) noGround.push(m);
      doc.matches[id] = m; ids.push(id);
    }
    // Grounds are not on scorecards: use raw/grounds.json or the saved match; only if a match still
    // lacks one, load fixtures.do once for this season (URL built from stored ids) and cache per matchId.
    if (noGround.length && !REPARSE) {
      try {
        const gid = s._gid || ((s.groups || []).find(g => { const st = standings.find(d => d.series.id === s.id); const gn = st && st.teams[team] && st.teams[team].group; return g.name === gn || ('Group ' + g.name) === gn; }) || {}).id;
        const h = await pager.html(`${base}/fixtures.do?league=${gid}&teamId=${s.teams[team]}&clubId=${clubId}&year=${s.year}`, { kind: 'fixtures' });
        const fx = await pager.parse(h, FIXTURES);
        for (const m of noGround) { const r = m._hm && fx.find(r => r.includes(m._hm) && r.includes(m.opponent)); m.ground = r ? r[r.indexOf(m._hm) + 4] || null : null; if (m.ground) grounds[m.id.slice(7)] = m.ground; }
      } catch (e) { console.error('  fixtures failed', e.message); }
    }
    for (const m of noGround) if (m.ground === undefined) m.ground = null;
    for (const id of ids) { const m = doc.matches[id]; if (m && m.ground !== undefined && grounds[id.slice(7)] === undefined && readRaw(id.slice(7))) grounds[id.slice(7)] = m.ground; delete m._hm; }
    for (const id of ids) { const m = doc.matches[id]; console.error(' ', k, id, m.date, m.opponent, '|', m.result, '| ground', m.ground, '| bat', m.batting.length, 'bowl', m.bowling.length); }
    doc.series[s.id] = { name: s.name, scrapedAt, matchIds: ids };
    if (!REPARSE) writeJSON(groundsFile, grounds);
    store.writeTeam(code, team, { ...doc, series: { ...prev.series, ...doc.series }, matches: { ...prev.matches, ...doc.matches } }); // partial progress
  }
  store.writeTeam(code, team, doc);
  if (!REPARSE) writeJSON(groundsFile, grounds);
  return Object.keys(doc.matches).length;
}

(async () => {
  const t0 = Date.now();
  const league = store.readLeague(code);
  if (!league) throw new Error('league not indexed: ' + code);
  const clubId = await clubIdFor(league);
  const report = {};
  for (const team of teams) report[team] = await scanTeam(league, team, clubId);
  store.publish();
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.error('stats', JSON.stringify({ ...stats, concurrency: concurrency(), slowMode: state.slow, secs, reparse: REPARSE }));
  console.log(JSON.stringify(report));
  await pager.close();
})().catch(async e => { console.error(e); await pager.close(); process.exit(1); });
