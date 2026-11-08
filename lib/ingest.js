// League-level ingest shared by both readers: per-season results index + official CricClubs
// player points (Rankings page). Loaded once per league per season; past seasons never refetched,
// the current season only after the weekend rule (same helper the site uses, site/app.js scan-window).
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const store = require('./store');

const appSrc = fs.readFileSync(path.join(store.ROOT, 'site', 'app.js'), 'utf8');
const block = appSrc.match(/\/\* scan-window:start \*\/([\s\S]*?)\/\* scan-window:end \*\//);
const win = {}; vm.runInNewContext(block[1], win);
const { nextScanAfter, formatPt } = win;

const dir = (code, kind) => path.join(store.STORE, 'leagues', store.codeKey(code), kind);
const seasonFile = (code, kind, s) => path.join(dir(code, kind), store.slug(s.name) + '.json');
const readJSON = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const readResults = (code, s) => s ? readJSON(seasonFile(code, 'results', s)) : null;
const readRankings = (code, s) => s ? readJSON(seasonFile(code, 'rankings', s)) : null;
function writeSeason(code, kind, s, doc) { const f = seasonFile(code, kind, s); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f + '.tmp', JSON.stringify(doc, null, 1)); fs.renameSync(f + '.tmp', f); }

// Current season may be refetched once the first match weekend strictly after the last refresh
// has passed (opens Monday 12:00 PT). Returns { due, next }.
function refreshDue(league, now = new Date()) {
  const last = league.ingest && league.ingest.refreshedAt;
  if (!last) return { due: true, next: null };
  const next = nextScanAfter(last, { matchDays: league.matchDays });
  return { due: next.getTime() <= now.getTime(), next, label: formatPt(next) };
}
// Which seasons to (re)load: past seasons only when never ingested; current when due (or forced).
function plan(league, keys, { force = false, now = new Date() } = {}) {
  const due = refreshDue(league, now);
  const out = [];
  for (const k of keys) {
    const s = league.seasons && league.seasons[k]; if (!s) continue;
    const have = readResults(league.code, s) && readRankings(league.code, s);
    if (force || !have || (k === 'current' && due.due)) out.push({ key: k, s });
    else console.error(`  ${k} ${s.name}: ${k === 'current' ? 'refresh not due until ' + due.label : 'past season already ingested'}`);
  }
  return out;
}
function markRefreshed(league, keys, pages, secs) {
  league.ingest = league.ingest || {};
  league.ingest.refreshedAt = new Date().toISOString();
  league.ingest.seasons = league.ingest.seasons || {};
  for (const k of keys) { const s = league.seasons[k]; if (s) league.ingest.seasons[s.id] = { name: s.name, at: league.ingest.refreshedAt }; }
  if (pages) league.ingest.last = { pages, secs };
}

const norm = s => String(s || '').toLowerCase().replace(/\(.*?\)/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
// Results index -> one team's matchIds (by team id first, name as fallback), newest first (same order as the fixtures list).
function teamMatchIds(index, team, teamId) {
  if (!index || !Array.isArray(index.matches)) return null;
  const n = norm(team);
  const hit = m => (teamId != null && (m.teamIds || []).map(String).includes(String(teamId))) || (m.teams || []).some(t => norm(t) === n);
  return index.matches.filter(hit).sort((a, b) => String(b.date).localeCompare(String(a.date)) || Number(b.matchId) - Number(a.matchId) || String(b.matchId).localeCompare(String(a.matchId))).map(m => String(m.matchId));
}
function groundsFrom(index) { const g = {}; for (const m of (index && index.matches) || []) if (m.ground) g[String(m.matchId)] = m.ground; return g; }

// Official points for one team's players in one season: { normName: row }.
function teamPoints(rankings, team) {
  if (!rankings || !Array.isArray(rankings.players)) return null;
  const n = norm(team); const out = {};
  for (const p of rankings.players) if (norm(p.team) === n) out[norm(p.name)] = { name: p.name, matches: p.matches, batting: p.batting, bowling: p.bowling, fielding: p.fielding, other: p.other, mom: p.mom, total: p.total };
  return out;
}
module.exports = { nextScanAfter, formatPt, refreshDue, plan, markRefreshed, readResults, readRankings, writeSeason, teamMatchIds, groundsFrom, teamPoints, norm };
