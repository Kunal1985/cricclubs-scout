// League-level ingest for a legacy (.do) club: per season, the Results index and official player points.
// Usage: CHROME_PATH=... node scripts/legacy-ingest.js <ClubCode> [--force]
//   Past seasons load once; the current season reloads only after the weekend rule (lib/ingest.refreshDue).
// Pages per season:
//   listMatches.do?league=<seasonId>&clubId=   every completed match: id, type, date, teams, result (all groups)
//   fixtures.do?league=<seasonId>&clubId=      same matches with team ids + ground
//   playerRankings.do?divisions=all&league=<seasonId>&clubId=  official points, capped at 200 rows by CricClubs;
//     when capped, one playerRankings.do?league=<seasonId>&teamId=<id>&clubId= per team instead.
const store = require('../lib/store');
const ingest = require('../lib/ingest');
const { Pager, pool, stats, concurrency } = require('../lib/pager');
const argv = process.argv.slice(2);
const FORCE = process.env.FORCE === '1' || argv.includes('--force');
const [code] = argv.filter(a => !/^--/.test(a));
const base = `https://cricclubs.com/${code}`;
const pager = new Pager();
const CAP = 200;
const lite = h => h.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<link[^>]*>/gi, '');
const txt = h => String(h || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
// Server-rendered tables, parsed with plain string scans (no browser tab: these pages are 1-2 MB).
function ROWS(h) {
  const out = [];
  for (const m of lite(h).matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const mid = (m[1].match(/viewScorecard\.do\?matchId=(\d+)/) || [])[1]; if (!mid) continue;
    const c = [...m[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map(x => txt(x[1]));
    const d = c.findIndex(x => /^\d\d\/\d\d\/\d{4}$/.test(x)); if (d < 0) continue;
    out.push({ mid, d, c, teamIds: [...m[1].matchAll(/teamId=(\d+)/g)].map(x => x[1]) });
  }
  return out;
}
function RANK(h) {
  const i = h.indexOf('id="tablePlayerRankings"'); if (i < 0) return null;
  const t = lite(h.slice(i)); const thead = (t.match(/<thead>([\s\S]*?)<\/thead>/) || [])[1] || '';
  const head = [...thead.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map(x => txt(x[1]));
  const body = t.slice(t.indexOf('</thead>'));
  const rows = body.split(/<tr[^>]*>\s*(?=<th align="left">\d+<\/th>)/).slice(1).map(chunk => {
    const team = txt((chunk.match(/<table>([\s\S]*?)<\/table>/) || [])[1]);
    const flat = chunk.replace(/<table>[\s\S]*?<\/table>/, team);
    const cells = [...flat.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map(x => txt(x[1]));
    return { cells, playerId: (chunk.match(/playerId=(\d+)/) || [])[1] };
  });
  return { head, rows };
}
const iso = mdY => { const m = String(mdY).match(/(\d\d)\/(\d\d)\/(\d{4})/); return m ? `${m[3]}-${m[1]}-${m[2]}` : null; };
const num = v => { const n = Number(String(v).replace(/,/g, '')); return isFinite(n) ? n : null; };
function rankRows(r) {
  if (!r) return [];
  const at = name => r.head.findIndex(h => h.toLowerCase().startsWith(name.toLowerCase()));
  const col = { name: at('Player'), group: at('Group'), team: at('Team'), matches: at('Matches'), batting: at('Batting'), bowling: at('Bowling'), fielding: at('Fielding'), other: at('Other'), mom: at('MOM'), total: at('Total') };
  return r.rows.filter(x => x.cells.length >= r.head.length && x.playerId).map(x => ({ playerId: x.playerId, name: x.cells[col.name], group: col.group >= 0 ? x.cells[col.group] : null, team: x.cells[col.team],
    matches: num(x.cells[col.matches]), batting: num(x.cells[col.batting]), bowling: num(x.cells[col.bowling]), fielding: num(x.cells[col.fielding]), other: col.other >= 0 ? num(x.cells[col.other]) : null, mom: col.mom >= 0 ? num(x.cells[col.mom]) : null, total: num(x.cells[col.total]) }));
}
async function results(s, sid, clubId, idName) {
  const lm = await pager.html(`${base}/listMatches.do?league=${sid}&clubId=${clubId}`, { kind: 'results', ready: 'table tbody tr' });
  const fx = await pager.html(`${base}/fixtures.do?league=${sid}&clubId=${clubId}`, { kind: 'fixtures', ready: 'table tbody tr' });
  const lr = ROWS(lm), fr = ROWS(fx);
  const fxBy = new Map(); for (const r of fr) if (!fxBy.has(r.mid)) fxBy.set(r.mid, r);
  const matches = []; const seen = new Set(); const unmapped = new Set();
  for (const r of lr) { if (seen.has(r.mid)) continue; seen.add(r.mid);
    // listMatches row: #, Match Type, Date, Team One, Team two, Result, Scores Summary, Points
    const f = fxBy.get(r.mid); const fc = f && f.c;
    const teamIds = f && f.teamIds.length === 2 ? f.teamIds : r.teamIds;
    const shown = fc ? [fc[f.d + 2], fc[f.d + 3]] : [r.c[r.d + 1], r.c[r.d + 2]];
    const teams = teamIds.length === 2 ? teamIds.map((id, i) => { const n = idName[id]; if (!n) unmapped.add(`${shown[i]} (team id ${id} not in season teams)`); else if (n !== shown[i]) unmapped.add(`${shown[i]} -> ${n}`); return n || shown[i]; }) : shown;
    matches.push({ matchId: r.mid, scorecard: `${base}/viewScorecard.do?matchId=${r.mid}&clubId=${clubId}`, date: iso(r.c[r.d]), type: r.c[r.d - 1] || null, teams, teamIds, ground: fc ? fc[f.d + 4] || null : null, result: r.c[r.d + 3] || null, summary: r.c[r.d + 4] || null });
  }
  for (const r of fr) if (!seen.has(r.mid)) { seen.add(r.mid); matches.push({ matchId: r.mid, scorecard: `${base}/viewScorecard.do?matchId=${r.mid}&clubId=${clubId}`, date: iso(r.c[r.d]), type: r.c[r.d - 1] || null, teams: r.teamIds.map((id, i) => idName[id] || r.c[r.d + 2 + i]), teamIds: r.teamIds, ground: r.c[r.d + 4] || null, result: null, summary: null }); }
  return { matches, unmapped: [...unmapped] };
}
async function rankings(s, sid, clubId) {
  const h = await pager.html(`${base}/playerRankings.do?divisions=all&league=${sid}&clubId=${clubId}`, { kind: 'rankings', ready: '#tablePlayerRankings, .footer, footer' });
  let rows = rankRows(RANK(h)); let perTeam = false;
  if (rows.length >= CAP) {
    perTeam = true; const all = new Map();
    const n = concurrency(); const slots = Array.from({ length: n }, () => ({ pg: null }));
    await pool(Object.entries(s.teams || {}), n, async ([team, tid], w) => {
      try { const th = await pager.html(`${base}/playerRankings.do?league=${sid}&teamId=${tid}&clubId=${clubId}`, { kind: 'rankingsTeam', ready: '#tablePlayerRankings, .footer, footer', slot: slots[w] });
        for (const r of rankRows(RANK(th))) all.set(r.playerId + '|' + r.team, r);
      } catch (e) { console.error('  rankings failed', team, e.message); }
    });
    for (const sl of slots) if (sl.pg) await pager.closeTab(sl.pg);
    rows = [...all.values()].sort((a, b) => (b.total || 0) - (a.total || 0));
  }
  return { players: rows, perTeam };
}
(async () => {
  const t0 = Date.now();
  const league = store.readLeague(code);
  if (!league) throw new Error('league not indexed: ' + code + ' (run legacy-league.js first)');
  const clubId = league.clubId; const report = {};
  const todo = ingest.plan(league, store.SEASON_KEYS, { force: FORCE });
  for (const { key, s } of todo) {
    const ts = Date.now(), p0 = stats.pages; const sid = s.id.replace(/^legacy-/, '');
    const idName = Object.fromEntries(Object.entries(s.teams || {}).map(([n, id]) => [String(id), n]));
    const r = await results(s, sid, clubId, idName);
    const rk = await rankings(s, sid, clubId);
    const teamNames = new Set(Object.keys(s.teams || {}));
    const rankTeamsUnknown = [...new Set(rk.players.map(p => p.team))].filter(t => !teamNames.has(t));
    const fetchedAt = new Date().toISOString();
    ingest.writeSeason(code, 'results', s, { season: { key, id: s.id, name: s.name }, fetchedAt, source: [`${base}/listMatches.do?league=${sid}&clubId=${clubId}`, `${base}/fixtures.do?league=${sid}&clubId=${clubId}`], matches: r.matches });
    ingest.writeSeason(code, 'rankings', s, { season: { key, id: s.id, name: s.name }, fetchedAt, source: `${base}/playerRankings.do?divisions=all&league=${sid}&clubId=${clubId}`, perTeam: rk.perTeam, players: rk.players });
    report[key] = { season: s.name, pages: stats.pages - p0, secs: +((Date.now() - ts) / 1000).toFixed(1), matches: r.matches.length, noGround: r.matches.filter(m => !m.ground).length, players: rk.players.length, perTeam: rk.perTeam, renamed: r.unmapped, rankTeamsUnknown };
    console.error(' ', key, JSON.stringify(report[key]));
  }
  if (todo.length) { ingest.markRefreshed(league, todo.map(t => t.key), stats.pages, +((Date.now() - t0) / 1000).toFixed(1)); store.writeLeague(league); }
  store.publish();
  console.log(JSON.stringify({ code, secs: +((Date.now() - t0) / 1000).toFixed(1), stats: { pages: stats.pages, byKind: stats.byKind, retries: stats.retries, failures: stats.failures }, seasons: report }));
  await pager.close();
})().catch(async e => { console.error(e); await pager.close(); process.exit(1); });
