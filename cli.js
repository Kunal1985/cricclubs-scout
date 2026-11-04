// Scraper CLI. GitHub Actions calls `node cli.js run` with MODE, LEAGUE, and TEAM
// already sanitized. Local use: node cli.js league|scan|weekly|publish [args]
const fs = require('fs');
const path = require('path');
const cc = require('./lib/cc');
const { normMatch } = require('./lib/normalize');
const store = require('./lib/store');
const ingest = require('./lib/ingest');
const { buildStandingsDoc } = require('./lib/standings');
const { sanitizeLeague, sanitizeTeam, siteUrl, commentFor } = require('./lib/issue');

const TZ = 'America/Los_Angeles';
const RESULT = path.join(store.ROOT, 'scan-result.json');
const os = require('os');
// Standings refresh once per league per run. A batch runner sets SCAN_RUN_ID so separate
// team processes share the record; past seasons never change, so an existing file is final.
const RUN_FILE = process.env.SCAN_RUN_ID ? path.join(os.tmpdir(), `cricscout-run-${process.env.SCAN_RUN_ID}.json`) : null;
const refreshedStandings = new Set(RUN_FILE ? (() => { try { return JSON.parse(fs.readFileSync(RUN_FILE, 'utf8')); } catch { return []; } })() : []);
function markRefreshed(key) {
  refreshedStandings.add(key);
  if (RUN_FILE) { let cur = []; try { cur = JSON.parse(fs.readFileSync(RUN_FILE, 'utf8')); } catch {} fs.writeFileSync(RUN_FILE, JSON.stringify([...new Set([...cur, key])])); }
}

function laDate(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
function seriesIso(s) {
  const [mm, dd, yy] = (s.startDate || '').split('/');
  return yy ? `${yy}-${mm}-${dd}` : '';
}
function matchTeam(league, name) {
  const want = String(name || '').trim().toLowerCase();
  return (league.teams || []).find(t => t.toLowerCase() === want) || null;
}
function seasonBits(league) {
  const s = league.seasons || {};
  const out = { current: s.current?.name || null, last: s.last?.name || null };
  if (s.prev2 && s.prev2.name) out.prev2 = s.prev2.name;
  return out;
}
function asOfFromTeam(code, team) {
  const t = store.readTeam(code, team);
  const times = Object.values((t && t.series) || {}).map(s => s.scrapedAt).filter(Boolean).sort();
  if (!times.length) return '';
  return 'data as of ' + times[times.length - 1].slice(0, 10);
}

function finish(result, code) {
  result.comment = commentFor(result);
  result.close = code !== 1;
  fs.writeFileSync(RESULT, JSON.stringify(result, null, 2) + '\n');
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, result.comment.replace(/<!--[\s\S]*?-->\n?/g, '') + '\n');
  }
  console.log(JSON.stringify({ ok: !!result.ok, kind: result.kind || null, error: result.error || null }));
  process.exitCode = code;
  return result;
}

async function ensureLeague(input, { refresh = false } = {}) {
  const code = sanitizeLeague(input);
  if (!code) return { error: 'Invalid league. Use a CricClubs league code or a cricclubs.com URL.' };
  const cached = store.readLeague(code);
  if (cached && !refresh) return { league: cached, cached: true };
  const info = await cc.leagueInfo(code);
  if (!info) return { error: `League "${code}" was not found on CricClubs.` };
  const y = Number(laDate().slice(0, 4));
  const today = laDate();
  const all = [...await cc.seriesForYear(info.code, info.id, y), ...await cc.seriesForYear(info.code, info.id, y - 1), ...await cc.seriesForYear(info.code, info.id, y - 2)];
  const started = all.filter(s => seriesIso(s) && seriesIso(s) <= today).sort((a, b) => seriesIso(b).localeCompare(seriesIso(a)));
  const seasons = {};
  // Three newest started series: current, last, prev2.
  for (const [k, s] of [['current', started[0]], ['last', started[1]], ['prev2', started[2]]]) {
    if (!s) continue;
    const old = cached && Object.values(cached.seasons || {}).find(o => o.id === s.id);
    // A past season's team list is fixed: reuse it instead of loading the page again.
    seasons[k] = { ...s, teams: (k !== 'current' && old && old.teams && Object.keys(old.teams).length) ? old.teams : await cc.seriesTeams(info.code, info.id, s) };
  }
  if (!seasons.current) return { error: `League "${info.name}" has no seasons in ${y - 2}–${y}.` };
  const teams = [...new Set(Object.values(seasons).flatMap(s => Object.keys(s.teams)))].sort((a, b) => a.localeCompare(b));
  const league = { ...info, checkedAt: new Date().toISOString(), seasons, teams, logos: (cached && cached.logos) || {} };
  if (cached && cached.ingest) league.ingest = cached.ingest; if (cached && cached.matchDays) league.matchDays = cached.matchDays;
  store.writeLeague(league);
  console.error(`league ${league.code} (${league.name}) current=${seasons.current.name} teams=${teams.length}`);
  await refreshStandings(league, store.SEASON_KEYS);
  return { league, cached: false };
}

async function refreshStandings(league, keys, { missingOnly = false } = {}) {
  const seasons = [...new Set(keys)].map(k => league.seasons[k]).filter(s => s && s.id);
  const have = new Set(store.listStandings(league.code).map(d => d.series && d.series.id));
  const cur = league.seasons.current && league.seasons.current.id;
  const pending = seasons.filter(s => !refreshedStandings.has(league.code + '|' + s.id) && ((!missingOnly && s.id === cur) || !have.has(s.id)));
  if (!pending.length) return;
  let all = null;
  const logos = { ...(league.logos || {}) };
  let changed = false;
  for (const s of pending) {
    try {
      if (!all) all = await cc.allSeriesList(league.code);
      const pt = await cc.fetchPointsTable(league.code, league.id, s);
      const po = await cc.fetchPlayoffs(league.code, league.id, s, all, pt);
      const doc = buildStandingsDoc(pt, po);
      store.writeStandings(league.code, s.name, doc);
      Object.assign(logos, doc.logos || {});
      markRefreshed(league.code + '|' + s.id);
      changed = true;
      console.error('standings', s.name);
    } catch (e) {
      console.error('standings failed', s.name, e.message);
    }
  }
  if (changed) {
    league.logos = logos;
    store.writeLeague(league);
  }
}

// Raw match lists (the JSON the results page fetched), so 'reparse' can rebuild offline.
const rawListFile = (code, sid, tid) => path.join(store.STORE, 'leagues', store.codeKey(code), 'raw', 'lists', `${sid}-${tid}.json`);
function writeRawList(code, sid, tid, list) { const f = rawListFile(code, sid, tid); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(list)); }
// Rebuild a team's matches from cached match lists + cached scorecards. Zero network.
function reparseTeam(league, team) {
  const canonical = matchTeam(league, team);
  const t = canonical && store.readTeam(league.code, canonical);
  if (!t) return { error: `Team "${team}" has no saved data in ${league.code}.` };
  let rebuilt = 0, kept = 0;
  for (const s of Object.values(league.seasons || {})) {
    const st = t.series[s.id]; const tid = s.teams && s.teams[canonical]; if (!st || !tid) continue;
    let list; try { list = JSON.parse(fs.readFileSync(rawListFile(league.code, s.id, tid), 'utf8')); } catch { console.error('no cached list for', s.name, '- kept saved matches'); kept += st.matchIds.length; continue; }
    for (const m of list) { const mid = m.scoreSummary.matchId; const raw = store.readScore(league.code, mid); if (!raw) { kept++; continue; } t.matches[mid] = normMatch(m, raw, tid, canonical, s); rebuilt++; }
  }
  store.writeTeam(league.code, canonical, t);
  return { ok: true, team: canonical, rebuilt, kept };
}

async function scanTeam(league, team, { currentOnly = false } = {}) {
  const canonical = matchTeam(league, team);
  if (!canonical) return { error: `Team "${team}" is not in a cached season of ${league.name}.` };
  const t = store.readTeam(league.code, canonical) || { team: canonical, league: league.code, series: {}, matches: {} };
  t.team = canonical;
  t.league = league.code;
  const plan = [];
  for (const k of store.SEASON_KEYS) {
    if (currentOnly && k !== 'current') continue;
    const s = league.seasons[k];
    if (!s || !s.teams || !s.teams[canonical]) continue;
    const st = t.series[s.id];
    if (!st) plan.push({ key: k, s, mode: 'full' });
    else if (k === 'current' || ingest.readResults(league.code, s)) plan.push({ key: k, s, mode: 'incremental' });
  }
  let newMatches = 0;
  for (const p of plan) {
    const tid = p.s.teams[canonical];
    // League ingest saved the season's completed matches: filter to this team, no list page.
    const idx = ingest.readResults(league.code, p.s);
    let list = idx && Array.isArray(idx.items) ? idx.items.filter(m => m.teamOne.id === tid || m.teamTwo.id === tid) : null;
    if (list && list.length) console.error(`${p.s.name}: ${list.length} matches from results index`);
    else { if (idx) console.error(`fallback: ${p.s.name} results index has no ${canonical} matches`); list = await cc.teamMatchList(league.code, league.id, p.s, tid); }
    writeRawList(league.code, p.s.id, tid, list);
    const fresh = list.filter(m => !t.matches[m.scoreSummary.matchId]);
    console.error(`${p.s.name}: ${list.length} matches, ${fresh.length} new (${p.mode})`);
    for (const m of fresh) {
      const mid = m.scoreSummary.matchId;
      let raw = store.readScore(league.code, mid);
      if (!raw) {
        raw = await cc.scorecard(league.code, mid);
        store.writeScore(league.code, mid, raw);
      }
      t.matches[mid] = normMatch(m, raw, tid, canonical, p.s);
      newMatches++;
    }
    const idx2 = ingest.readResults(league.code, p.s);
    t.series[p.s.id] = { name: p.s.name, scrapedAt: (idx2 && idx2.fetchedAt) || new Date().toISOString(), matchIds: list.map(m => m.scoreSummary.matchId) };
    store.writeTeam(league.code, canonical, t);
  }
  // Standings for the current season refresh with the league ingest; a team scan only fills gaps.
  await refreshStandings(league, plan.map(p => p.key), { missingOnly: true });
  return { ok: true, team: canonical, newMatches, seasons: plan.map(p => p.s.name) };
}

function leagueResult(league, extra = {}) {
  const bits = seasonBits(league);
  return {
    ok: true,
    kind: 'league',
    code: league.code,
    name: league.name,
    teamCount: (league.teams || []).length,
    current: bits.current,
    last: bits.last,
    url: siteUrl(league.code),
    ...extra
  };
}

async function addLeague(input, { refresh = true } = {}) {
  const res = await ensureLeague(input, { refresh });
  if (res.error) return finish({ ok: false, error: res.error }, 2);
  store.publish();
  return finish(leagueResult(res.league), 0);
}

async function scanOne(input, teamInput, { refreshLeague = false, currentOnly = false } = {}) {
  const teamCheck = sanitizeTeam(teamInput);
  if (!teamCheck.ok) return finish({ ok: false, error: teamCheck.error }, 2);
  if (!teamCheck.value) return addLeague(input, { refresh: true });
  let res = await ensureLeague(input, { refresh: refreshLeague });
  if (res.error) return finish({ ok: false, error: res.error }, 2);
  let league = res.league;
  let team = matchTeam(league, teamCheck.value);
  if (!team) {
    res = await ensureLeague(league.code, { refresh: true });
    if (res.error) return finish({ ok: false, error: res.error }, 2);
    league = res.league;
    team = matchTeam(league, teamCheck.value);
  }
  if (!team) {
    const sample = (league.teams || []).slice(0, 40).join(', ');
    return finish({ ok: false, error: `Team "${teamCheck.value}" is not in a cached season of ${league.name}. Teams: ${sample}` }, 2);
  }
  const scan = await scanTeam(league, team, { currentOnly });
  if (scan.error) return finish({ ok: false, error: scan.error }, 2);
  store.publish();
  const bits = seasonBits(league);
  return finish({
    ok: true,
    kind: 'team',
    code: league.code,
    name: league.name,
    team: scan.team,
    newMatches: scan.newMatches,
    current: bits.current,
    last: bits.last,
    url: siteUrl(league.code, scan.team),
    asOf: asOfFromTeam(league.code, scan.team)
  }, 0);
}

// League ingest (DDCL reader): per season, every completed match (results index) and the official
// player points. Past seasons load once; the current season again only after the weekend rule.
async function ingestLeague(input, { force = false } = {}) {
  const res = await ensureLeague(input, { refresh: false });
  if (res.error) return finish({ ok: false, error: res.error }, 2);
  const out = await ingestCore(res.league, { force });
  store.publish();
  console.log(JSON.stringify(out));
}
async function ingestCore(league, { force = false } = {}) {
  const t0 = Date.now(); const report = {};
  const todo = ingest.plan(league, store.SEASON_KEYS, { force });
  for (const { key, s } of todo) {
    const ts = Date.now(), p0 = cc.stats.pages;
    const ms = await cc.seriesMatchesAll(league.code, league.id, s);
    const items = ms.completed.filter(m => m.scoreSummary && m.scoreSummary.matchId);
    const matches = items.map(m => ({ matchId: m.scoreSummary.matchId, scorecard: `https://cricclubs.com/${league.code}/results/${m.scoreSummary.matchId}`, date: String(m.matchDateTime || '').slice(0, 10), type: m.matchType || null,
      teams: [m.teamOne.name, m.teamTwo.name], teamIds: [m.teamOne.id, m.teamTwo.id], ground: (m.ground || {}).name || null, result: m.scoreSummary.result || null, summary: m.scoreSummary.scoreSummary || null }));
    let players = await cc.playerRankings(league.code, league.id, s); let perTeam = false;
    if (players.length >= 200) {
      perTeam = true; const all = new Map();
      for (const [team, tid] of Object.entries(s.teams || {})) {
        try { for (const p of await cc.playerRankings(league.code, league.id, s, tid)) all.set(p.playerId + '|' + p.team, p); } catch (e) { console.error('rankings failed', team, e.message); }
      }
      players = [...all.values()].sort((a, b) => (b.total || 0) - (a.total || 0));
    }
    const fetchedAt = new Date().toISOString();
    const base = `https://cricclubs.com/${league.code}`;
    ingest.writeSeason(league.code, 'results', s, { season: { key, id: s.id, name: s.name }, fetchedAt, source: `${base}/results?leagueId=${league.id}&year=${s.year}&series=${s.id}`, total: ms.total, matches, items });
    ingest.writeSeason(league.code, 'rankings', s, { season: { key, id: s.id, name: s.name }, fetchedAt, source: `${base}/statistics/rankings-records?leagueId=${league.id}&year=${s.year}&series=${s.id}`, perTeam, players });
    if (key === 'current') await refreshStandings(league, ['current']);
    const names = new Set(Object.keys(s.teams || {}));
    report[key] = { season: s.name, pages: cc.stats.pages - p0, secs: +((Date.now() - ts) / 1000).toFixed(1), matches: matches.length, total: ms.total, noGround: matches.filter(m => !m.ground).length, players: players.length, perTeam,
      unknownTeams: [...new Set([...matches.flatMap(m => m.teams), ...players.map(p => p.team)])].filter(n => !names.has(n)) };
    console.error(key, JSON.stringify(report[key]));
  }
  if (todo.length) { ingest.markRefreshed(league, todo.map(t => t.key), cc.stats.pages, +((Date.now() - t0) / 1000).toFixed(1)); store.writeLeague(league); }
  return { code: league.code, secs: +((Date.now() - t0) / 1000).toFixed(1), pages: cc.stats.pages, byKind: cc.stats.byKind, seasons: report };
}

async function weekly() {
  const leagues = store.listLeagues();
  const summary = [];
  for (const cached of leagues) {
    let league = cached;
    try {
      const res = await ensureLeague(cached.code, { refresh: true });
      if (res.league) league = res.league;
      else console.error('league refresh skipped', cached.code, res.error);
    } catch (e) {
      console.error('league refresh failed', cached.code, e.message);
    }
    try { await ingestCore(league); } catch (e) { console.error('league ingest failed', league.code, e.message); }
    await refreshStandings(league, ['current']);
    const teams = store.listScannedTeams(league.code);
    for (const t of teams) {
      if (!matchTeam(league, t.team)) {
        console.error('skip', t.team, 'not in', league.code);
        continue;
      }
      const scan = await scanTeam(league, t.team, { currentOnly: true });
      summary.push({ league: league.code, team: t.team, newMatches: scan.newMatches || 0, error: scan.error || null });
      console.error('weekly', league.code, t.team, scan.error || (scan.newMatches + ' new'));
    }
  }
  store.publish();
  return finish({ ok: true, kind: 'weekly', summary, url: siteUrl(), name: 'weekly', code: '', current: null, last: null, teamCount: summary.length }, 0);
}

function argLeague() { return process.env.LEAGUE || process.argv[3] || ''; }
function argTeam() {
  if (process.env.LEAGUE !== undefined && process.env.TEAM !== undefined) return process.env.TEAM;
  return process.argv[4] || '';
}

async function run() {
  const cmd = process.argv[2];
  if (cmd === 'publish') {
    const index = store.publish();
    console.log(JSON.stringify({ leagues: index.leagues.length }));
    return;
  }
  if (cmd === 'seed-standings') {
    const dir = path.join(store.ROOT, 'samples');
    const league = store.readLeague('DublinandDanvilleCricketLeague');
    if (!league) throw new Error('DDCL league cache is missing');
    const logos = { ...(league.logos || {}) };
    const files = fs.readdirSync(dir).filter(f => /^normalized_.*\.json$/.test(f));
    for (const f of files) {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      const doc = buildStandingsDoc(raw.pointsTable, raw.playoffs);
      store.writeStandings(league.code, doc.series.name, doc);
      Object.assign(logos, doc.logos || {});
      console.error('seeded', doc.series.name, Object.keys(doc.teams).length);
    }
    league.logos = logos;
    store.writeLeague(league);
    store.publish();
    return;
  }
  if (cmd === 'league') return addLeague(argLeague(), { refresh: process.env.REFRESH === '1' || process.argv.includes('--refresh') });
  if (cmd === 'scan') return scanOne(argLeague(), argTeam(), { refreshLeague: false });
  if (cmd === 'weekly') return weekly();
  if (cmd === 'ingest') return ingestLeague(argLeague(), { force: process.env.FORCE === '1' || process.argv.includes('--force') });
  if (cmd === 'reparse') {
    const league = store.readLeague(sanitizeLeague(argLeague()));
    if (!league) throw new Error('league not cached');
    const r = reparseTeam(league, argTeam()); store.publish(); console.log(JSON.stringify(r)); return;
  }
  if (cmd === 'run') {
    const mode = process.env.MODE;
    if (mode === 'weekly') return weekly();
    if (mode === 'league') return addLeague(process.env.LEAGUE || '', { refresh: true });
    if (mode === 'scan') return scanOne(process.env.LEAGUE || '', process.env.TEAM || '', { refreshLeague: false });
    return finish({ ok: false, error: 'Unknown MODE. Expected weekly, league, or scan.' }, 1);
  }
  console.error('Usage: node cli.js publish|league|ingest|scan|weekly|run');
  process.exitCode = 1;
}

run().catch(e => {
  console.error(e);
  finish({ ok: false, error: String(e.message || e) }, 1);
}).finally(async () => { await cc.close(); console.error('stats', JSON.stringify(cc.stats)); });
