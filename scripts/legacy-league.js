// Index a legacy (server-rendered .do) CricClubs club: seasons, groups, teams, logos, standings.
// Usage: CHROME_PATH=... node scripts/legacy-league.js <ClubCode> "<Display name>"
const store = require('../lib/store');
const [code, dispName] = process.argv.slice(2);
const { Pager, stats } = require('../lib/pager');
const pager = new Pager();
const dec = s => s.replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
const slot = { pg: null };
const get = url => pager.html(url, { slot, kind: url.includes('league=') ? 'groupPointsTable' : 'pointsTable' });
const dropdowns = h => [...h.matchAll(/<ul class="dropdown-menu[^"]*"[^>]*>([\s\S]*?)<\/ul>/g)].map(m => [...m[1].matchAll(/href="[^"]*viewPointsTable\.do\?league=(\d+)[^"]*">([^<]*)</g)].map(x => ({ id: x[1], name: dec(x[2]) }))).filter(a => a.length);
function table(h, group) {
  const rows = [];
  for (const m of h.matchAll(/<tr>\s*<th>(\d+)<\/th>([\s\S]*?)<\/tr>/g)) {
    const cells = [...m[2].matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map(c => c[1]);
    const logo = (cells[0].match(/<img src="([^"]+)"/) || [])[1] || null;
    const tid = (cells[0].match(/teamId=(\d+)/) || [])[1];
    const n = i => Number(dec(cells[i] || '')) || 0;
    rows.push({ position: +m[1], name: dec(cells[0]), teamId: tid, logo, played: n(1), won: n(2), lost: n(3), nr: n(4), tie: n(5), points: n(6), nrr: Number(dec(cells[8] || '')) || 0 });
  }
  return rows.map(r => ({ ...r, of: rows.length, group }));
}
async function season(firstId) {
  const h = await get(`https://cricclubs.com/${code}/viewPointsTable.do?league=${firstId}&clubId=`);
  const dd = dropdowns(h); const groups = dd.length > 1 ? dd[dd.length - 1] : [{ id: firstId, name: '' }];
  const name = dec((h.match(/<title>([^<]*)/) || [])[1] || '');
  const all = []; const teams = {}; const teamGroups = {};
  for (const g of groups) {
    const gh = g.id === firstId ? h : await get(`https://cricclubs.com/${code}/viewPointsTable.do?league=${g.id}&clubId=`);
    for (const r of table(gh, g.name ? (/^(group|division|div)/i.test(g.name) ? g.name : 'Group ' + g.name) : null)) { all.push(r); teams[r.name] = r.teamId; teamGroups[r.name] = g.id; }
    console.error(' group', g.name, g.id, Object.keys(teams).length);
  }
  return { groups, all, teams, teamGroups };
}
// Per-season team -> group id (league= in fixtures.do), derived from saved standings when a past season is reused.
function groupsFromStandings(s, standings) {
  const st = standings.find(d => d.series && d.series.id === s.id); const out = {};
  for (const n of Object.keys(s.teams || {})) { const gn = st && st.teams[n] && st.teams[n].group; const g = (s.groups || []).find(g => g.name === gn || 'Group ' + g.name === gn || (!gn && (s.groups || []).length === 1)); if (g) out[n] = g.id; }
  return out;
}
(async () => {
  const prev = store.readLeague(code);
  const prevStandings = store.listStandings(code);
  const h = await get(`https://cricclubs.com/${code}/viewPointsTable.do`);
  const series = dropdowns(h)[0].filter((s, i, a) => a.findIndex(t => t.id === s.id) === i);
  const skip = /corporate|playoff|charity|practice|tournament|knock/i;
  const cfg = (require('./legacy-config.json')[code.toLowerCase()]) || {};
  const excl = cfg.excludeSeries ? new RegExp(cfg.excludeSeries, 'i') : null;
  const main = series.filter(s => !skip.test(s.name) && !(excl && excl.test(s.name)));
  // Three newest non-excluded series: current, last, prev2 (store.SEASON_KEYS).
  const picks = { current: main[0], last: main[1], prev2: main[2] };
  console.error('series', JSON.stringify(picks));
  const clubId = (h.match(/clubId=(\d+)/) || [])[1] || (prev && prev.clubId) || null;
  const league = { code, clubId, timeLimitSec: cfg.timeLimitSec || (prev && prev.timeLimitSec) || undefined, name: dispName || (prev && prev.name) || code, checkedAt: new Date().toISOString(), legacy: true, excludeSeries: cfg.excludeSeries || null, seasons: {}, teams: [], logos: {} };
  const names = new Set();
  for (const [k, s] of Object.entries(picks)) {
    if (!s) continue;
    // Past seasons never change: reuse the saved season + standings instead of reloading every group page.
    const old = prev && Object.values(prev.seasons || {}).find(o => o.id === 'legacy-' + s.id);
    if (k !== 'current' && old && prevStandings.some(d => d.series && d.series.id === old.id) && process.env.FULL !== '1') {
      league.seasons[k] = old.teamGroups ? old : { ...old, teamGroups: groupsFromStandings(old, prevStandings) }; for (const [n, l] of Object.entries(prev.logos || {})) if (!league.logos[n]) league.logos[n] = l;
      console.error(' reuse', k, s.name); continue;
    }
    const r = await season(s.id);
    const year = Number((s.name.match(/20\d\d/) || [])[0]) || null;
    league.seasons[k] = { id: 'legacy-' + s.id, name: s.name, startDate: null, year, teams: r.teams, teamGroups: r.teamGroups, groups: r.groups.map(g => ({ id: g.id, name: g.name })) };
    for (const x of r.all) { if (x.logo && !league.logos[x.name]) league.logos[x.name] = x.logo; if (k === 'current') names.add(x.name); }
    const doc = { series: { id: 'legacy-' + s.id, name: s.name }, playoffs: { found: false, pending: false }, teams: {} };
    for (const x of r.all) doc.teams[x.name] = { position: x.position, of: x.of, group: x.group, played: x.played, won: x.won, lost: x.lost, nr: x.nr, points: x.points, nrr: x.nrr, logo: x.logo, playoff: null };
    store.writeStandings(code, s.name, doc);
  }
  league.teams = [...names].sort((a, b) => a.localeCompare(b));
  store.writeLeague(league);
  store.publish();
  console.log(JSON.stringify({ code, current: league.seasons.current && league.seasons.current.name, groups: league.seasons.current && league.seasons.current.groups.length, teams: league.teams.length, last: league.seasons.last && league.seasons.last.name, prev2: league.seasons.prev2 && league.seasons.prev2.name }));
  console.error('stats', JSON.stringify(stats));
  await pager.close();
})().catch(async e => { console.error(e); await pager.close(); process.exit(1); });
