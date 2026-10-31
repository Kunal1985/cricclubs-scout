const $ = s => document.querySelector(s);
let LEAGUE = null, DATA = null, CATALOG = [];
let pollTimer = null, pollGen = 0;
const pct = (a, b) => b ? Math.round(100 * a / b) + '%' : '–', ov = b => Math.floor(b / 6) + '.' + b % 6, f1 = x => isFinite(x) ? x.toFixed(1) : '–';
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const ini = n => String(n).split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase();
const HUES = ['#2fd27a', '#ffc83d', '#4cc3ff', '#ff8a95', '#b78cff', '#7ee0c3', '#ffa05c'];
const hue = n => HUES[[...n].reduce((s, c) => s + c.charCodeAt(0), 0) % HUES.length];
const slug = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
function remember(k, v) { try { localStorage[k] = v; } catch (e) {} }
function recall(k) { try { return localStorage[k] || ''; } catch (e) { return ''; } }
function msg(t) { const m = $('#msg'); m.hidden = !t; m.textContent = t || ''; }
function parseLeague(s) {
  s = String(s || '').trim();
  const m = s.match(/cricclubs\.com\/([A-Za-z0-9_-]+)/i);
  const code = m ? m[1] : s.replace(/^\/+|\/.*$/g, '');
  return /^[A-Za-z0-9_-]{2,80}$/.test(code) ? code : null;
}
function stopPoll() { pollGen++; if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }
function asOf(data) {
  const times = Object.values(data.seasons || {}).map(s => s.scrapedAt).filter(Boolean).sort();
  if (!times.length) return '';
  const pretty = new Date(times[times.length - 1]).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  const names = Object.values(data.seasons || {}).filter(s => s && s.scrapedAt).map(s => s.name).join(' · ');
  return 'data as of ' + pretty + (names ? ' · ' + names : '');
}
function welcomeHTML() {
  return `<section class="welcome" id="welcome"><div class="wball"></div><h1>Know your<br><span>opponent.</span></h1><p>Pick a cached league or add one, then scout a team: form, match-ups, key players, toss habits and grounds.</p><div class="eg">Try <button class="chip" type="button" data-lg="DublinandDanvilleCricketLeague">DublinandDanvilleCricketLeague</button></div></section>`;
}
function requestPanel(title, html) {
  return `<section class="welcome"><div class="wball"></div><h1>${esc(title)}</h1><p class="lead">${html}</p><img class="soon" src="coming-soon.gif" alt="Coming soon"><p class="hint" id="pollhint"></p></section>`;
}
function leagueByCode(code) { return CATALOG.find(l => l.code.toLowerCase() === String(code || '').toLowerCase()) || null; }
async function loadCatalog() {
  const r = await fetch('data/index.json', { cache: 'no-store' });
  if (!r.ok) throw new Error('Could not load cached leagues (' + r.status + ')');
  const j = await r.json();
  CATALOG = j.leagues || [];
  const sel = $('#leagueSel');
  const cur = sel.value;
  sel.innerHTML = '<option value="">Cached leagues…</option>' + CATALOG.map(l => `<option value="${esc(l.code)}">${esc(l.name)} · ${esc(l.code)}</option>`).join('');
  if (cur && CATALOG.some(l => l.code === cur)) sel.value = cur;
}
function teamLogo(name) {
  return (LEAGUE && LEAGUE.logos && LEAGUE.logos[name]) || (DATA && DATA.logos && DATA.logos[name]) || '';
}
function face(name, url, cls) {
  if (url) return `<img class="${cls || 'logo-img'}" alt="" src="${esc(url)}">`;
  return `<span class="av sm" style="background:${hue(name)}">${esc(ini(name))}</span>`;
}
function syncTeamButton() {
  const btn = $('#teamBtn'); if (!btn) return;
  const name = $('#team').value;
  btn.disabled = $('#team').disabled;
  if (!name) { btn.innerHTML = '<span>Select a team</span>'; return; }
  btn.innerHTML = face(name, teamLogo(name), 'logo-img') + `<span>${esc(name)}</span>`;
}
function fillTeams(league, keep) {
  LEAGUE = league;
  $('#league').textContent = `${league.name} · ${league.seasons.current?.name || ''}`;
  const teams = league.teams || [];
  $('#team').innerHTML = '<option value="">Select team (' + teams.length + ')</option>' + teams.map(t => `<option value="${esc(t)}">${esc(t)}</option>`).join('');
  $('#team').disabled = false;
  const menu = $('#teamMenu');
  if (menu) menu.innerHTML = teams.map(t => `<button type="button" data-team="${esc(t)}">${face(t, (league.logos || {})[t], 'logo-img')}<span>${esc(t)}</span></button>`).join('');
  if (keep && teams.includes(keep)) $('#team').value = keep;
  syncTeamButton();
}
function watch(url, onHit) {
  stopPoll();
  const gen = pollGen;
  let n = 0;
  const max = 40;
  const hint = () => {
    const h = $('#pollhint'); if (!h) return;
    h.textContent = n >= max
      ? 'Coming Soon!'
      : `Checking every 30s… (${n}/${max})`;
  };
  const tick = async () => {
    if (gen !== pollGen) return;
    n++;
    try {
      const r = await fetch(url, { cache: 'no-store' });
      if (r.ok) {
        const data = await r.json();
        if (gen !== pollGen) return;
        stopPoll();
        onHit(data);
        return;
      }
    } catch (e) {}
    if (n >= max && pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    hint();
  };
  hint();
  pollTimer = setInterval(tick, 30000);
}
async function loadStandings(code, seasons) {
  const out = {};
  await Promise.all(['current', 'last'].map(async k => {
    const s = seasons && seasons[k];
    if (!s || !s.name) return;
    try {
      const r = await fetch(`data/leagues/${code.toLowerCase()}/standings/${slug(s.name)}.json`, { cache: 'no-store' });
      if (r.ok) out[k] = await r.json();
    } catch (e) {}
  }));
  return out;
}
let reportGen = 0;
async function showReport(data, gen = ++reportGen) {
  const standings = LEAGUE ? await loadStandings(LEAGUE.code, data.seasons) : {};
  if (gen !== reportGen || ($('#team').value && $('#team').value !== data.team)) return;
  DATA = data;
  DATA.standings = standings;
  if (!DATA.logo && teamLogo(DATA.team)) DATA.logo = teamLogo(DATA.team);
  $('#scraped').textContent = asOf(DATA);
  syncTeamButton();
  render();
}
async function loadTeam() {
  const team = $('#team').value;
  if (!team || !LEAGUE) return;
  const gen = ++reportGen;
  stopPoll();
  remember('team_' + LEAGUE.code, team);
  msg('');
  DATA = null;
  $('#scraped').textContent = '';
  const code = LEAGUE.code;
  const url = `data/leagues/${code.toLowerCase()}/teams/${slug(team)}.json`;
  let res;
  try { res = await fetch(url, { cache: 'no-store' }); }
  catch (e) { msg('Network error: ' + e.message); return; }
  if (res.ok) { const data = await res.json(); if (gen === reportGen) showReport(data, gen); return; }
  if (gen !== reportGen) return;
  $('#main').innerHTML = requestPanel('Not scanned yet', 'Coming Soon!');
  watch(url, data => { if ($('#team').value === team && LEAGUE && LEAGUE.code === code) showReport(data); });
}
function selectCached(code, team) {
  const league = leagueByCode(code);
  if (!league) return false;
  $('#leagueSel').value = league.code;
  $('#lg').value = league.code;
  remember('lg', league.code);
  const keep = team || recall('team_' + league.code);
  fillTeams(league, keep);
  if (keep && (league.teams || []).includes(keep)) loadTeam();
  else { stopPoll(); DATA = null; $('#scraped').textContent = ''; $('#main').innerHTML = welcomeHTML(); }
  return true;
}
async function addLeague(input) {
  msg('');
  const code = parseLeague(input);
  if (!code) { msg('Enter a league code like DublinandDanvilleCricketLeague or a cricclubs.com URL.'); return; }
  if (selectCached(code)) return;
  const leagueUrl = `data/leagues/${code.toLowerCase()}/league.json`;
  try {
    const r = await fetch(leagueUrl, { cache: 'no-store' });
    if (r.ok) {
      const league = await r.json();
      if (!leagueByCode(league.code)) CATALOG.push(league);
      if (![...$('#leagueSel').options].some(o => o.value === league.code)) {
        $('#leagueSel').insertAdjacentHTML('beforeend', `<option value="${esc(league.code)}">${esc(league.name)} · ${esc(league.code)}</option>`);
      }
      selectCached(league.code);
      return;
    }
  } catch (e) { msg('Network error: ' + e.message); return; }
  stopPoll();
  LEAGUE = null;
  DATA = null;
  $('#leagueSel').value = '';
  $('#team').innerHTML = '<option value="">Select a team</option>';
  $('#team').disabled = true;
  if ($('#teamMenu')) $('#teamMenu').innerHTML = '';
  syncTeamButton();
  $('#league').textContent = 'Not cached';
  $('#scraped').textContent = '';
  $('#main').innerHTML = requestPanel('League not cached', 'Coming Soon!');
  watch(leagueUrl, async () => {
    try { await loadCatalog(); } catch (e) {}
    if (selectCached(code)) return;
    const again = await fetch(leagueUrl, { cache: 'no-store' });
    if (!again.ok) return;
    const league = await again.json();
    if (!leagueByCode(league.code)) CATALOG.push(league);
    selectCached(league.code);
  });
}
function ordinal(n) {
  const v = n % 100;
  const suf = (v >= 11 && v <= 13) ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th');
  return n + suf;
}
function nrrText(n) {
  const x = Number(n);
  if (!isFinite(x)) return '–';
  return (x > 0 ? '+' : '') + x.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
}
function standingsHTML() {
  if (!DATA || !DATA.standings) return '';
  const p = $('#period').value;
  const keys = p === 'last' ? ['last'] : p === 'all' ? ['current', 'last'] : ['current'];
  return keys.map(k => {
    const doc = DATA.standings[k];
    const row = doc && doc.teams && doc.teams[DATA.team];
    if (!row) return '';
    const pos = `${ordinal(row.position)} of ${row.of}${row.group ? ' · ' + row.group : ''}`;
    const po = row.playoff ? `<p class="st-po${row.playoff.muted ? ' muted' : ''}">${esc(row.playoff.text)}</p>` : '';
    return card('🏆', 'Standings', `<div class="st-pos">${esc(pos)}</div><div class="st-line"><span><b>${row.played}</b> Played</span><span><b class="g">${row.won}</b> W</span><span><b class="r">${row.lost}</b> L</span><span><b>${row.nr}</b> NR</span><span><b class="y">${row.points}</b> Total points</span><span><b>${esc(nrrText(row.nrr))}</b> NRR</span></div>${po}`, doc.series && doc.series.name);
  }).join('');
}
function badgeHTML(name, url) {
  const letters = esc(ini(name));
  if (!url) return `<div class="badge">${letters}</div>`;
  return `<div class="badge has-logo">${face(name, url, 'logo-img')}<span class="fallback">${letters}</span></div>`;
}
function pick() {
  const p = $('#period').value, M = DATA.matches, S = DATA.seasons;
  if (p === 'last5') return [M.slice(0, 5), 'Last 5 matches'];
  if (p === 'current') return [M.filter(m => m.seriesId === S.current?.id), S.current?.name || 'Current season'];
  if (p === 'last') return [M.filter(m => m.seriesId === S.last?.id), (S.last?.name || 'Last season') + (S.last && !S.last.inSeason ? ' (did not play)' : '')];
  return [M, 'Both seasons'];
}
const wl = ms => ({ n: ms.length, w: ms.filter(m => m.outcome === 'W').length, l: ms.filter(m => m.outcome === 'L').length });
const card = (icon, t, h, tag) => `<section class="card"><div class="ch"><span class="ic" aria-hidden="true">${icon}</span><h2>${t}</h2>${tag ? `<span class="tag">${tag}</span>` : ''}</div>${h}</section>`;
const tbl = (cols, rows) => `<table><tr>${cols.map(c => `<th>${c}</th>`).join('')}</tr>${rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</table>`;
function donut(parts, center) {
  const tot = parts.reduce((s, p) => s + p.v, 0) || 1; let a = 0; const R = 40, C = 2 * Math.PI * R;
  const arcs = parts.map(p => { const len = C * p.v / tot, s = `<circle r="${R}" cx="50" cy="50" fill="none" stroke="${p.c}" stroke-width="14" stroke-dasharray="${len} ${C - len}" stroke-dashoffset="${-a}" transform="rotate(-90 50 50)"/>`; a += len; return s; }).join('');
  return `<svg class="donut" viewBox="0 0 100 100" role="img" aria-label="${parts.map(p => p.l + ' ' + p.v).join(', ')}"><circle r="${R}" cx="50" cy="50" fill="none" stroke="#ffffff10" stroke-width="14"/>${arcs}<text x="50" y="49" text-anchor="middle" fill="#eef5f0" font-size="20" font-family="Bebas Neue,Impact,sans-serif">${center[0]}</text><text x="50" y="63" text-anchor="middle" fill="#9fb5a8" font-size="8">${center[1]}</text></svg><div class="leg">${parts.map(p => `<span><i style="background:${p.c}"></i>${p.l} ${p.v}</span>`).join('')}</div>`;
}
function render() {
  if (!DATA) return;
  const [ms, label] = pick(); const half = $('#period').value === 'last5';
  $('#scraped').textContent = asOf(DATA);
  const hero = extra => `<section class="hero"><div class="htop">${badgeHTML(DATA.team, DATA.logo || teamLogo(DATA.team))}<div><div class="hname">${esc(DATA.team)}</div><div class="hsub">${esc(label)} · ${ms.length} matches</div></div></div>${extra}</section>`;
  const stand = standingsHTML();
  if (!ms.length) { $('#main').innerHTML = hero('<p class="hsum">No completed matches in this period.</p>') + stand + howToBeat(); return; }
  const played = ms.filter(m => !m.forfeit), o = wl(ms); const us = m => m.innings.find(i => i.team === DATA.team), them = m => m.innings.find(i => i.team !== DATA.team);
  const avg = a => a.length ? Math.round(a.reduce((s, x) => s + x, 0) / a.length) : NaN;
  const bat = {}, bowl = {}, fld = {};
  for (const m of played) {
    for (const b of m.batting) { const x = bat[b.name] ??= { name: b.name, inn: 0, r: 0, b: 0, outs: 0, hs: -1, no: false }; x.inn++; x.r += b.r; x.b += b.b; x.outs += b.out ? 1 : 0; if (b.r > x.hs || (b.r === x.hs && !b.out)) { x.hs = b.r; x.no = !b.out; } }
    for (const w of m.bowling) { const x = bowl[w.name] ??= { name: w.name, balls: 0, r: 0, w: 0, bw: -1, br: 0 }; x.balls += w.balls; x.r += w.r; x.w += w.w; if (w.w > x.bw || (w.w === x.bw && w.r < x.br)) { x.bw = w.w; x.br = w.r; } }
    for (const [n, k, c] of m.fielding || []) { const x = fld[n] ??= { name: n, c: 0, k: 0, r: 0, s: 0 }; x[k] += c; }
  }
  const B = Object.values(bat), W = Object.values(bowl), sr = x => x.b ? 100 * x.r / x.b : NaN, ec = x => x.balls ? 6 * x.r / x.balls : NaN, imp = x => x.b ? x.r * x.r / x.b : 0;
  const minInn = half ? 2 : 3, minB = half ? 15 : 30, minOv = half ? 2 : 6; const qB = B.filter(x => x.inn >= minInn && x.b >= minB), qW = W.filter(x => x.balls >= minOv * 6);
  const topBat = [...qB].sort((a, b) => imp(b) - imp(a)).slice(0, 6), topBowl = [...qW].sort((a, b) => b.w - a.w || ec(a) - ec(b)).slice(0, 6), eco = [...qW].sort((a, b) => ec(a) - ec(b)).slice(0, 5);
  const poorBat = [...qB].sort((a, b) => sr(a) - sr(b)).slice(0, 4), poorBowl = [...qW].sort((a, b) => ec(b) - ec(a)).slice(0, 4);
  const teamRuns = played.reduce((s, m) => { const i = us(m); return s + (i ? Number(i.runs) || 0 : 0); }, 0);
  const lowBat = B.filter(x => x.inn >= minInn).sort((a, b) => a.r - b.r || b.inn - a.inn || a.name.localeCompare(b.name)).slice(0, 4);
  const runLead = [...B].sort((a, b) => b.r - a.r)[0], wkLead = [...W].sort((a, b) => b.w - a.w)[0];
  const role = n => { const isB = qB.some(x => x.name === n), isW = qW.some(x => x.name === n); return (fld[n]?.k ? '<span class="role wk">WK</span>' : '') + (isB && isW ? '<span class="role ar">All-rounder</span>' : isW ? '<span class="role bowl">Bowler</span>' : isB ? '<span class="role bat">Batter</span>' : ''); };
  const pl = (i, n, sub, val, k, barPct, col) => `<div class="pl"><span class="rank">${i}</span><span class="av" style="background:${hue(n)}">${esc(ini(n))}</span><div class="pn"><b>${esc(n)}</b><div class="roles">${role(n)}</div><span>${sub}</span><div class="mbar"><i style="width:${Math.max(4, barPct)}%;background:${col};animation-delay:${i * 60}ms"></i></div></div><div class="big"><div class="v">${val}</div><div class="k">${k}</div></div></div>`;
  const ourI = played.map(us).filter(Boolean), oppI = played.map(them).filter(Boolean);
  const bf = played.filter(m => m.battedFirst === true), ch = played.filter(m => m.battedFirst === false), a = wl(bf), c = wl(ch);
  const tw = played.filter(m => m.tossWonByUs), tb = tw.filter(m => m.tossDecision === 'bat'), tbo = tw.filter(m => m.tossDecision === 'bowl'), tl = played.filter(m => m.tossWonByUs === false);
  let h = hero(`<div class="form" aria-label="Recent form">${ms.slice(0, 12).map((m, i) => `<span class="fc ${m.outcome}" style="animation-delay:${i * 40}ms" title="${esc(m.date + ' vs ' + m.opponent)}">${m.outcome}</span>`).join('')}</div>
 <p class="hsum">${o.w}–${o.l} record.${runLead ? ` <b>${esc(runLead.name)}</b> leads the runs (${runLead.r})` : ''}${wkLead ? `, <b>${esc(wkLead.name)}</b> the wickets (${wkLead.w}).` : ''}</p>`);
  h += stand;
  h += `<div class="tiles"><div class="tile"><div class="v"><span class="g">${o.w}</span>–<span class="r">${o.l}</span></div><div class="k">Record</div></div><div class="tile"><div class="v y">${pct(o.w, o.n)}</div><div class="k">Win rate</div></div><div class="tile"><div class="v">${f1(avg(ourI.map(i => i.runs))).replace('.0', '')}</div><div class="k">Avg score</div><div class="s">conc. ${f1(avg(oppI.map(i => i.runs))).replace('.0', '')}</div></div>
 <div class="tile"><div class="v">${pct(a.w, a.n)}</div><div class="k">Bat first win</div><div class="s">${a.w}/${a.n}</div></div><div class="tile"><div class="v">${pct(c.w, c.n)}</div><div class="k">Chasing win</div><div class="s">${c.w}/${c.n}</div></div><div class="tile"><div class="v">${pct(tw.length, played.length)}</div><div class="k">Tosses won</div><div class="s">${tw.length}/${played.length}</div></div></div>`;
  h += card('📋', 'Last results', ms.slice(0, 10).map(m => `<div class="res"><span class="fc ${m.outcome}">${m.outcome}</span><div><b>${face(m.opponent, teamLogo(m.opponent), 'mini')}vs ${esc(m.opponent)}</b><div class="meta">${m.date} · ${esc(m.ground || '')}</div><div class="sc">${m.forfeit ? '<i>Forfeit – no play</i>' : m.innings.map(i => `${esc(i.team)} <b>${i.runs}/${i.wkts}</b> (${i.overs})`).join(' · ')}</div><div class="meta">${esc(m.result)} · <a href="https://cricclubs.com/${encodeURIComponent(LEAGUE.code)}/results/${encodeURIComponent(m.id)}" target="_blank" rel="noopener">Scorecard ↗</a></div></div></div>`).join(''));
  const note = t => `<div class="note">${t}${half ? ' · reduced for last 5' : ''}</div>`; const mxI = Math.max(1, ...topBat.map(imp)), mxW = Math.max(1, ...topBowl.map(x => x.w)), mxE = Math.max(1, ...eco.map(ec));
  h += card('⭐', 'Players to watch', `<h3>Batters</h3>${topBat.map((x, i) => pl(i + 1, x.name, `${x.r} runs · ${x.inn} inns · best ${x.hs}${x.no ? '*' : ''} · avg ${f1(x.outs ? x.r / x.outs : NaN)}`, f1(sr(x)), 'Strike rate', 100 * imp(x) / mxI, 'var(--sky)')).join('') || '<p class="note">Nobody qualifies yet.</p>'}${note(`${minInn}+ inns & ${minB}+ balls · ranked by runs × SR ÷ 100`)}
 <h3>Wicket takers</h3>${topBowl.map((x, i) => pl(i + 1, x.name, `${ov(x.balls)} ov · econ ${f1(ec(x))} · best ${x.bw}/${x.br}`, x.w, 'Wickets', 100 * x.w / mxW, 'var(--red)')).join('') || '<p class="note">Nobody qualifies yet.</p>'}${note(`${minOv}+ overs · ranked by wickets, then economy`)}
 <h3>Most economical</h3>${eco.map((x, i) => pl(i + 1, x.name, `${ov(x.balls)} ov · ${x.w} wkts`, f1(ec(x)), 'Economy', 100 * (1 - ec(x) / (mxE * 1.15)), 'var(--green)')).join('')}${note(`${minOv}+ overs · lowest runs per over`)}`, label);
  const F = Object.values(fld).sort((a, b) => (b.c + b.k + b.r + b.s) - (a.c + a.k + a.r + a.s));
  if (F.length) h += card('🧤', 'Fielders', tbl(['Fielder', 'Ct', 'WK', 'RO', 'St', 'Tot'], F.slice(0, 10).map(x => [`<span class="av" style="background:${hue(x.name)};width:26px;height:26px;font-size:10px;display:inline-grid;vertical-align:middle;margin-right:6px">${esc(ini(x.name))}</span>${esc(x.name)}`, x.c, x.k, x.r, x.s, `<b class="y">${x.c + x.k + x.r + x.s}</b>`])) + `<div class="note">From opponent dismissal text; shared run-outs credit each fielder.${DATA.unresolvedFielders ? ` ${DATA.unresolvedFielders} name(s) unmatched.` : ''}</div>`);
  h += card('📉', 'Weak spots', `<h3>Slowest scorers</h3>${tbl(['Batter', 'SR', 'Runs', 'Balls'], poorBat.map(x => [esc(x.name), `<b class="r">${f1(sr(x))}</b>`, x.r, x.b]))}${note(`${minInn}+ inns & ${minB}+ balls`)}<h3>Most expensive</h3>${tbl(['Bowler', 'Econ', 'Ov', 'Wkts'], poorBowl.map(x => [esc(x.name), `<b class="r">${f1(ec(x))}</b>`, ov(x.balls), x.w]))}${note(`${minOv}+ overs`)}<h3>Lowest batting contribution</h3>${tbl(['Batter', 'Runs', 'Inns', 'Avg', 'Share'], lowBat.map(x => [esc(x.name), x.r, x.inn, f1(x.outs ? x.r / x.outs : NaN), `<b class="r">${pct(x.r, teamRuns)}</b>`]))}${note(`${minInn}+ inns · no balls minimum · % of team runs`)}`);
  h += howToBeat();
  const vs = (lab, w, n) => `<div class="vsr"><div class="lab"><span>${lab}</span><span><b>${w}</b>/${n} won · ${pct(w, n)}</span></div><div class="track"><i style="width:${n ? 100 * w / n : 0}%;background:var(--green)"></i><i style="width:${n ? 100 * (n - w) / n : 0}%;background:var(--red);opacity:.85"></i></div></div>`;
  h += card('📊', 'Match-ups & toss', `<div class="vs">${vs('🏏 Batting first', a.w, a.n)}${vs('🎯 Chasing', c.w, c.n)}${vs('🪙 Won toss', wl(tw).w, tw.length)}${vs('Lost toss', wl(tl).w, tl.length)}</div>
 <div class="charts" style="margin-top:12px"><div class="chart"><div class="t">Toss decision</div>${donut([{ l: 'Bat', v: tb.length, c: '#4cc3ff' }, { l: 'Bowl', v: tbo.length, c: '#ff4d5e' }], [tw.length, 'tosses won'])}</div>
 <div class="chart"><div class="t">Results</div>${donut([{ l: 'Won', v: o.w, c: '#2fd27a' }, { l: 'Lost', v: o.l, c: '#ff4d5e' }], [pct(o.w, o.n), 'win rate'])}</div></div>
 ${tbl(['After toss', 'P', 'W', 'Win%'], [['Won → bat', tb.length, wl(tb).w, pct(wl(tb).w, tb.length)], ['Won → bowl', tbo.length, wl(tbo).w, pct(wl(tbo).w, tbo.length)], ['Lost toss', tl.length, wl(tl).w, pct(wl(tl).w, tl.length)]])}`);
  const notes = []; if (tw.length) notes.push(`Toss winners choose to <b>${tbo.length >= tb.length ? 'bowl' : 'bat'}</b> (${Math.max(tbo.length, tb.length)}/${tw.length}).`);
  if (a.n && c.n) notes.push(`Win rate batting first ${pct(a.w, a.n)} vs chasing ${pct(c.w, c.n)} — ${a.w / a.n > c.w / c.n ? 'stronger setting a total' : a.w / a.n < c.w / c.n ? 'stronger chasing; consider batting first' : 'no clear edge'}.`);
  const ft = bf.map(us).filter(Boolean).map(i => i.runs); if (ft.length) notes.push(`First-innings totals average <b>${Math.round(avg(ft))}</b> (range ${Math.min(...ft)}–${Math.max(...ft)}).`);
  if (ourI.length) notes.push(`Bowled out in <b>${ourI.filter(i => i.wkts >= 10).length}</b> of ${ourI.length} innings.`);
  const tot = B.reduce((s, x) => s + x.r, 0), t2 = [...B].sort((a, b) => b.r - a.r).slice(0, 2); if (tot && t2.length === 2) notes.push(`${esc(t2[0].name)} and ${esc(t2[1].name)} make <b>${pct(t2[0].r + t2[1].r, tot)}</b> of bat runs — get them early.`);
  h += card('🧠', 'Strategy notes', `<ul class="notes">${notes.map(n => `<li>${n}</li>`).join('')}</ul>`);
  const g = {}; for (const m of ms) if (m.ground) (g[m.ground] ??= []).push(m); const gs = Object.entries(g).map(([name, l]) => ({ name, ...wl(l) }));
  const gc = (l, bad) => l.length ? `<div class="grounds">${l.map(x => `<div class="gc ${bad ? 'bad' : ''}"><div class="gn"><b>${esc(x.name)}${x.n < 2 ? '<span class="thin">THIN</span>' : ''}</b><span>${x.w}W · ${x.l}L · ${x.n} played</span></div><div class="gp ${bad ? 'r' : 'g'}">${pct(x.w, x.n)}</div></div>`).join('')}</div>` : '<p class="note">None.</p>';
  h += card('🏟️', 'Favourite grounds', gc(gs.filter(x => x.w).sort((p, q) => q.w / q.n - p.w / p.n || q.n - p.n).slice(0, 4)), 'best win %');
  h += card('🙈', 'Jinxed grounds', gc(gs.filter(x => x.l).sort((p, q) => p.w / p.n - q.w / q.n || q.n - p.n).slice(0, 4), true), 'worst win %');
  $('#main').innerHTML = h;
  function howToBeat() {
    const recent = (DATA.matches || []).slice(0, 5);
    const minInn = 2, minB = 15, minOvBalls = 24;
    const agg = list => {
      const played = list.filter(m => !m.forfeit);
      const usInn = m => (m.innings || []).find(i => i.team === DATA.team);
      const bat = {}, bowl = {}, fld = {}, seen = new Set();
      let teamRuns = 0;
      for (const m of played) {
        const inn = usInn(m); if (inn) teamRuns += Number(inn.runs) || 0;
        for (const b of m.batting || []) {
          seen.add(b.name);
          const x = bat[b.name] ??= { name: b.name, inn: 0, r: 0, b: 0, outs: 0, f: 0, s: 0, how: {}, posSum: 0, posN: 0 };
          x.inn++; x.r += b.r || 0; x.b += b.b || 0; x.outs += b.out ? 1 : 0; x.f += b.f || 0; x.s += b.s || 0;
          if (b.how) x.how[b.how] = (x.how[b.how] || 0) + 1;
          if (b.pos) { x.posSum += b.pos; x.posN++; }
        }
        (m.bowling || []).forEach((w, i) => {
          seen.add(w.name);
          const x = bowl[w.name] ??= { name: w.name, balls: 0, r: 0, w: 0, dots: 0, wd: 0, nb: 0, f: 0, s: 0, bounds: 0, spells: 0, opens: 0 };
          x.balls += w.balls || 0; x.r += w.r || 0; x.w += w.w || 0; x.dots += w.dots || 0; x.wd += w.wd || 0; x.nb += w.nb || 0;
          if (w.f != null || w.s != null) { x.f += w.f || 0; x.s += w.s || 0; x.bounds++; }
          if (i < 2) x.opens++;
          x.spells++;
        });
        for (const [n, k, c] of m.fielding || []) { seen.add(n); const x = fld[n] ??= { c: 0, k: 0, r: 0, s: 0 }; x[k] += c; }
      }
      const B = Object.values(bat), W = Object.values(bowl);
      const srX = x => x.b ? 100 * x.r / x.b : NaN;
      const ecX = x => x.balls ? 6 * x.r / x.balls : NaN;
      const imp = x => x.b ? x.r * x.r / x.b : 0;
      const bf = played.filter(m => m.battedFirst === true), ch = played.filter(m => m.battedFirst === false);
      const twM = played.filter(m => m.tossWonByUs);
      return { played, usInn, B, W, fld, seen, teamRuns, srX, ecX, imp, bf, ch, a: wl(bf), c: wl(ch), twM, tb: twM.filter(m => m.tossDecision === 'bat'), tbo: twM.filter(m => m.tossDecision === 'bowl') };
    };
    const bPct = x => x.r ? 100 * (4 * x.f + 6 * x.s) / x.r : 0;
    const dotEst = x => {
      const other = Math.max(0, x.r - 4 * x.f - 6 * x.s);
      const dots = x.b - x.f - x.s - other;
      return x.b > 0 && dots >= 0 ? 100 * dots / x.b : null;
    };
    const posOf = x => x.posN ? x.posSum / x.posN : null;
    const posTxt = x => { const p = posOf(x); return p == null ? '' : `usually bats at ${Math.round(p)}`; };
    const howInfo = how => {
      const caught = (how.ct || 0) + (how.ctw || 0), timber = (how.b || 0) + (how.lbw || 0);
      const n = Object.values(how || {}).reduce((s, v) => s + v, 0);
      return { n, caught, timber, caughtMaj: n >= 2 && caught / n >= 0.5, timberMaj: n >= 2 && timber / n >= 0.5,
        text: n >= 2 ? `${caught} caught, ${timber} bowled/lbw of ${n} outs` : '' };
    };
    const R = agg(recent);
    const seasonId = DATA.seasons && DATA.seasons.current && DATA.seasons.current.id;
    const scope = [];
    const scopeIds = new Set();
    for (const m of recent.concat((DATA.matches || []).filter(m => !seasonId || m.seriesId === seasonId))) {
      if (!m || scopeIds.has(m.id)) continue;
      scopeIds.add(m.id);
      scope.push(m);
    }
    const G = agg(scope);
    const tips = [];
    const batterTips = [];
    const push = (score, html) => { if (score >= 12 && html) tips.push({ score, html }); };
    const qB = R.B.filter(x => x.inn >= minInn && x.b >= minB);
    const mainB = G.B.filter(x => x.inn >= 3 && x.b >= 30);
    const bowlBalls = R.W.reduce((s, x) => s + x.balls, 0);
    const bowlRuns = R.W.reduce((s, x) => s + x.r, 0);
    const teamEcon = bowlBalls ? 6 * bowlRuns / bowlBalls : null;
    const sloggers = [], rotators = [], slowStarters = [];
    for (const x of mainB) {
      const rate = G.srX(x), bound = bPct(x), dots = dotEst(x), d = howInfo(x.how);
      const where = posTxt(x);
      const lead = where ? where.charAt(0).toUpperCase() + where.slice(1) : `${x.inn} inns`;
      const fours = `${x.f} four${x.f === 1 ? '' : 's'}`, sixes = `${x.s} six${x.s === 1 ? '' : 'es'}`;
      const stat = `${lead}. SR ${f1(rate)}, ${x.r} runs off ${x.b} balls, ${fours}, ${sixes}, ${Math.round(bound)}% in boundaries${dots != null ? `, about ${Math.round(dots)}% dots` : ''}${d.text ? ', ' + d.text : ''}. Sample: ${scope.length} matches (this season and the last 5).`;
      const sixShare = x.r ? 6 * x.s / x.r : 0;
      let kind = '', plan = '';
      if (rate >= 130 || bound >= 50 || (x.s >= 3 && sixShare >= 0.3)) {
        kind = 'a slogger';
        plan = 'Take the pace off, bowl cutters and wide yorkers, and protect the long boundaries.';
      } else if (dots != null && dots <= 45 && bound <= 45 && ((rate >= 90 && rate <= 125) || (rate >= 65 && rate < 90 && bound <= 20))) {
        kind = 'a rotation specialist';
        plan = 'Cut off the single with a ring field, bowl for dots, and squeeze them so the pressure moves to the other end.';
      } else if (dots != null && dots >= 48) {
        kind = 'a slow starter';
        plan = 'Bowl dots and field a ring. They soak up balls without releasing the pressure.';
      }
      if (!kind) continue;
      if (d.caughtMaj && kind === 'a slogger') plan += ' They are often caught — keep catchers in the deep.';
      else if (d.caughtMaj) plan += ' They are often caught — keep a catcher in the ring.';
      else if (d.timberMaj) plan += ' They are often bowled or lbw — attack the stumps.';
      const row = { x, kind, html: `<b>${esc(x.name)} is ${kind}.</b> ${stat} ${plan}` };
      if (kind === 'a slogger') sloggers.push(row);
      else if (kind === 'a rotation specialist') rotators.push(row);
      else slowStarters.push(row);
    }
    sloggers.sort((p, q) => (q.x.s - p.x.s) || (G.srX(q.x) - G.srX(p.x)));
    rotators.sort((p, q) => (dotEst(p.x) ?? 99) - (dotEst(q.x) ?? 99) || q.x.r - p.x.r);
    slowStarters.sort((p, q) => (dotEst(q.x) ?? 0) - (dotEst(p.x) ?? 0));
    const byRuns = [...mainB].sort((a, b) => b.r - a.r);
    const mainNames = new Set(byRuns.slice(0, 6).map(x => x.name));
    const batterRows = [];
    const take = (rows, limit) => {
      for (const row of rows) {
        if (batterRows.length >= limit) break;
        if (!mainNames.has(row.x.name) || batterRows.some(r => r.x.name === row.x.name)) continue;
        batterRows.push(row);
      }
    };
    take(sloggers, 5);
    take(rotators, 5);
    take(slowStarters, 5);
    if (batterRows.length < 4) {
      for (const row of [...sloggers, ...rotators, ...slowStarters]) {
        if (batterRows.length >= 4) break;
        if (!batterRows.some(r => r.x.name === row.x.name)) batterRows.push(row);
      }
    }
    for (const row of batterRows) batterTips.push({ html: row.html });
    const openers = qB.filter(x => posOf(x) != null && posOf(x) <= 2.4);
    const batRuns = R.B.reduce((s, x) => s + x.r, 0);
    if (openers.length && batRuns) {
      const share = openers.reduce((s, x) => s + x.r, 0) / batRuns;
      if (share >= 0.5) {
        const who = openers.sort((p, q) => q.r - p.r).slice(0, 2).map(x => `${esc(x.name)} (${posTxt(x) || 'opens'}, ${x.r} runs)`).join(' and ');
        push(24 + (share - 0.5) * 80, `<b>They lean on the openers.</b> ${who} make ${pct(openers.reduce((s, x) => s + x.r, 0), batRuns)} of the bat runs in these five games. Get the new ball through them.`);
      }
    }
    let clusterInns = 0, fowInns = 0, ppWkts = 0;
    for (const m of R.played) {
      const fow = (m.fow || []).slice().sort((p, q) => p.over - q.over);
      if (!fow.length) continue;
      fowInns++;
      ppWkts += fow.filter(f => f.over <= 6).length;
      for (let i = 0; i + 2 < fow.length; i++) if (fow[i + 2].over - fow[i].over <= 1) { clusterInns++; break; }
    }
    if (fowInns >= 3 && clusterInns >= 2) push(18 + clusterInns * 6, `<b>Wickets fall in a heap.</b> ${clusterInns} of ${fowInns} innings lost 3 wickets inside one over. Keep the same bowler going once one falls.`);
    if (fowInns >= 3 && ppWkts / fowInns >= 1.8) push(16 + ppWkts, `<b>The powerplay is when they wobble.</b> ${ppWkts} wickets fell by over 6 across ${fowInns} innings. Attack with the new ball.`);
    let tossTip = null;
    const scopePlayed = scope.filter(m => !m.forfeit && m.battedFirst != null);
    const setting = scopePlayed.filter(m => m.battedFirst === true);
    const chasing = scopePlayed.filter(m => m.battedFirst === false);
    const sw = wl(setting), cw = wl(chasing);
    if (sw.n >= 2 && cw.n >= 2 && Math.abs(sw.w / sw.n - cw.w / cw.n) >= 0.1) {
      const chaseBetter = cw.w / cw.n > sw.w / sw.n;
      const won = (chaseBetter ? chasing : setting).filter(m => m.outcome === 'W');
      const byName = {};
      if (chaseBetter) {
        for (const m of won) for (const b of m.batting || []) {
          const x = byName[b.name] ??= { name: b.name, r: 0, b: 0 };
          x.r += b.r || 0; x.b += b.b || 0;
        }
      } else {
        for (const m of won) for (const w of m.bowling || []) {
          const x = byName[w.name] ??= { name: w.name, r: 0, b: 0, w: 0 };
          x.w = (x.w || 0) + (w.w || 0); x.r += w.r || 0; x.b += w.balls || 0;
        }
      }
      const top = Object.values(byName).sort((p, q) => chaseBetter ? q.r - p.r : (q.w - p.w) || (p.b ? p.r / p.b : 9) - (q.b ? q.r / q.b : 9)).slice(0, 2);
      const who = top.map(x => chaseBetter
        ? `${esc(x.name)} (${x.r} runs off ${x.b}, SR ${f1(x.b ? 100 * x.r / x.b : NaN)} in those wins)`
        : `${esc(x.name)} (${x.w} wickets, econ ${f1(x.b ? 6 * x.r / x.b : NaN)} in those wins)`).join(' and ');
      const sample = `${scopePlayed.length} matches (this season and the last 5)`;
      const record = `they've won ${sw.w}/${sw.n} setting a total and ${cw.w}/${cw.n} chasing, ${sample}`;
      const html = chaseBetter
        ? `<b>Win the toss: bat first and make them set a total</b> (${record}). Lose the toss and you bowl first: be very disciplined, because their chasers ${who} win it for them.`
        : `<b>Win the toss: bowl first and make them chase</b> (${record}). Lose the toss and you bat first: be very disciplined, because their bowlers ${who} win it when they are setting a total.`;
      tossTip = { html };
    }
    const firstInns = R.bf.map(R.usInn).filter(Boolean).map(i => Number(i.runs)).filter(n => !isNaN(n));
    if (firstInns.length >= minInn) {
      const par = Math.round(firstInns.reduce((s, n) => s + n, 0) / firstInns.length);
      push(16 + firstInns.length * 2, `<b>Par when they bat first is ${par}.</b> Average ${par} from ${firstInns.length} innings (range ${Math.min(...firstInns)}–${Math.max(...firstInns)}).`);
    }
    const hard = R.ch.filter(m => { const o = (m.innings || []).find(i => i.team !== DATA.team); return o && Number(o.runs) >= 130; });
    if (hard.length >= 2) {
      const hw = wl(hard);
      push(14 + hard.length * 4 + Math.abs(0.5 - hw.w / hw.n) * 20, `<b>Chasing 130 or more they are ${hw.w}/${hw.n}.</b> ${pct(hw.w, hw.n)} wins when the target is that high in these five games.`);
    }
    const scopeBalls = G.W.reduce((s, x) => s + x.balls, 0);
    const scopeRuns = G.W.reduce((s, x) => s + x.r, 0);
    const scopeEcon = scopeBalls ? 6 * scopeRuns / scopeBalls : null;
    const attack = [];
    for (const x of G.W) {
      if (x.balls < 24) continue;
      const e = G.ecX(x);
      if (scopeEcon != null && e < scopeEcon) continue;
      const pricey = e >= 7.5 || (scopeEcon != null && e >= scopeEcon * 1.15);
      if (!pricey) continue;
      const excess = scopeEcon == null ? 0 : (e - scopeEcon) * (x.balls / 6);
      attack.push({ x, e, excess });
    }
    attack.sort((a, b) => b.excess - a.excess || b.e - a.e);
    const attackNames = new Set();
    const extraTxt = x => {
      const bits = [];
      if (x.wd) bits.push(`${x.wd} wide${x.wd === 1 ? '' : 's'}`);
      if (x.nb) bits.push(`${x.nb} no-ball${x.nb === 1 ? '' : 's'}`);
      return bits.length ? `, ${bits.join(' and ')}` : '';
    };
    for (const { x, e, excess } of attack.slice(0, 2)) {
      attackNames.add(x.name);
      const wkts = `${x.w} wicket${x.w === 1 ? '' : 's'}`;
      const detail = `${ov(x.balls)} ov, ${wkts}${extraTxt(x)}`;
      const often = x.opens >= 2 && x.opens / x.spells >= 0.5;
      const html = often
        ? `<b>${esc(x.name)} often opens the bowling (${x.opens} of ${x.spells} innings) and goes at ${f1(e)} an over.</b> Go after him in the powerplay. ${detail}.`
        : `<b>Target ${esc(x.name)}: econ ${f1(e)}${x.bounds && x.bounds === x.spells ? `, ${x.f + x.s} boundaries conceded` : ''}.</b> ${detail}.`;
      push(18 + excess * 1.15, html);
    }
    const good = [];
    for (const x of R.W) {
      if (x.balls < minOvBalls || attackNames.has(x.name)) continue;
      const e = R.ecX(x);
      if (e <= 7.2 && (teamEcon == null || e <= teamEcon - 0.3)) good.push(x);
    }
    good.sort((p, q) => R.ecX(p) - R.ecX(q) || q.w - p.w);
    for (const x of good.slice(0, 2)) {
      const per = x.spells ? f1(x.balls / 6 / x.spells) : ov(x.balls);
      push(16 + (7.2 - R.ecX(x)) * 6 + x.w * 2, `<b>See ${esc(x.name)} off and rotate the strike.</b> Econ ${f1(R.ecX(x))}, ${x.w} wickets, ${ov(x.balls)} ov (${per} ov a spell). Target the other bowlers.`);
    }
    let wd = 0, nb = 0, bowlInns = 0, oversSum = 0, oversN = 0;
    for (const m of R.played) {
      if (m.extrasBowled) { wd += m.extrasBowled.wd || 0; nb += m.extrasBowled.nb || 0; bowlInns++; }
      if (m.oversBowled != null && (m.bowling || []).length) { oversSum += m.oversBowled; oversN++; }
    }
    if (bowlInns >= 3 && (wd + nb) / bowlInns >= 8) push(15 + (wd + nb) / bowlInns, `<b>Their bowlers give away extras.</b> ${wd} wides and ${nb} no-balls across ${bowlInns} bowling innings (${f1((wd + nb) / bowlInns)} a match). Make them bowl it again.`);
    if (oversN >= 3 && oversSum / oversN >= 18.5) push(14, `<b>They usually bowl the 20 out.</b> Average ${f1(oversSum / oversN)} overs across ${oversN} innings, so keep a plan for the death.`);
    else if (oversN >= 3 && oversSum / oversN <= 16) push(14, `<b>Their bowling innings often end early.</b> Average ${f1(oversSum / oversN)} overs across ${oversN} innings. The new ball and the middle overs decide more games than a long death.`);
    const grounds = {};
    for (const m of R.played) if (m.ground) (grounds[m.ground] ??= []).push(m);
    const grow = Object.entries(grounds).map(([name, list]) => {
      const rec = wl(list);
      const bfScores = list.filter(m => m.battedFirst === true).map(R.usInn).filter(Boolean).map(i => Number(i.runs)).filter(n => !isNaN(n));
      return { name, ...rec, bfAvg: bfScores.length ? Math.round(bfScores.reduce((s, n) => s + n, 0) / bfScores.length) : null, bfN: bfScores.length };
    });
    const jinx = grow.filter(x => x.n >= 2 && x.l >= 2 && x.w / x.n <= 0.4).sort((p, q) => p.w / p.n - q.w / q.n || q.n - p.n)[0];
    const thrive = grow.filter(x => x.n >= 2 && x.w >= 2 && x.w / x.n >= 0.65 && (!jinx || x.name !== jinx.name)).sort((p, q) => q.w / q.n - p.w / p.n || q.n - p.n)[0];
    if (jinx) push(20 + jinx.n * 3 + (0.5 - jinx.w / jinx.n) * 40, `<b>At ${esc(jinx.name)} they've lost ${jinx.l}/${jinx.n}.</b> Expect them to struggle, and back your plan there.`);
    if (thrive) {
      const avgBit = thrive.bfN >= 2 ? `, averaging ${thrive.bfAvg} batting first` : '';
      push(18 + thrive.n * 3, `<b>At ${esc(thrive.name)} they thrive (${thrive.w}W–${thrive.l}L${avgBit}).</b> A bigger par is needed there.`);
    }
    let catches = 0, fieldWkts = 0;
    for (const x of Object.values(R.fld)) catches += (x.c || 0) + (x.k || 0);
    for (const w of R.W) fieldWkts += w.w;
    if (fieldWkts >= 8 && catches / fieldWkts < 0.25) push(14 + (0.25 - catches / fieldWkts) * 40, `<b>Catches are a small part of their wickets.</b> ${catches} catches from ${fieldWkts} wickets in these five games. The card does not list dropped catches; it does show the stumps doing the work.`);
    tips.sort((p, q) => q.score - p.score);
    const budget = Math.max(0, 10 - batterTips.length - (tossTip ? 1 : 0));
    const shown = [...(tossTip ? [tossTip] : []), ...batterTips, ...tips.slice(0, budget)];
    const S = agg(DATA.matches || []);
    const seasonB = S.B.filter(x => x.inn >= 3 && x.b >= 30).sort((p, q) => S.imp(q) - S.imp(p));
    const seasonW = S.W.filter(x => x.balls >= 36).sort((p, q) => q.w - p.w || S.ecX(p) - S.ecX(q));
    const absent = name => !R.seen.has(name);
    const picked = [];
    for (const x of seasonB) if (absent(x.name)) picked.push({ kind: 'bat', x, score: S.imp(x) });
    for (const x of seasonW) if (absent(x.name)) picked.push({ kind: 'bowl', x, score: x.w * 18 + Math.max(0, 9 - S.ecX(x)) * 6 });
    picked.sort((p, q) => q.score - p.score);
    const chosen = [];
    for (const row of picked) {
      if (chosen.length >= 4) break;
      if (chosen.some(c => c.x.name === row.x.name)) continue;
      chosen.push(row);
    }
    const cards = chosen.map(({ kind, x }) => {
      if (kind === 'bat') {
        const rate = S.srX(x), bound = bPct(x), dots = dotEst(x), pos = posOf(x), d = howInfo(x.how);
        const where = posTxt(x);
        let plan;
        if (pos != null && pos >= 6 && rate >= 125) plan = 'At the death take the pace off and bowl wide yorkers, with the long boundary protected.';
        else if (rate >= 130 || bound >= 55) plan = 'Bowl tight lines, set the field, and target them early with your best bowler.';
        else if (rate < 105) plan = 'Build dot pressure and field a ring.';
        else plan = 'Cut off the single with a ring field and squeeze them so the pressure moves to the other end.';
        if (d.caughtMaj) plan += ' Often caught — keep catchers in the deep.';
        else if (d.timberMaj) plan += ' Often bowled or lbw — attack the stumps.';
        const stat = `${x.r} runs · SR ${f1(rate)} · ${where || x.inn + ' inns'} · ${Math.round(bound)}% boundaries · ${x.s} sixes${d.text ? ' · ' + d.text : ''}`;
        return `<div class="pl"><span class="av" style="background:${hue(x.name)}">${esc(ini(x.name))}</span><div class="pn"><b>${esc(x.name)}</b><div class="roles"><span class="role bat">Batter</span></div><span>${stat}</span></div></div><p class="tackle">${plan}</p>`;
      }
      const econ = S.ecX(x);
      const plan = econ <= 7
        ? 'See them off, rotate the strike, and target the other bowlers.'
        : x.w >= 4
          ? 'See their overs off early and avoid risk against them.'
          : 'Take them on — the economy is there to be hit — and do not hand them a wicket for free.';
      const stat = `${x.w} wickets · econ ${f1(econ)} · ${ov(x.balls)} ov`;
      return `<div class="pl"><span class="av" style="background:${hue(x.name)}">${esc(ini(x.name))}</span><div class="pn"><b>${esc(x.name)}</b><div class="roles"><span class="role bowl">Bowler</span></div><span>${stat}</span></div></div><p class="tackle">${plan}</p>`;
    }).join('');
    if (!shown.length && !cards) return '';
    const list = shown.length ? `<ul class="notes">${shown.map(t => `<li>${t.html}</li>`).join('')}</ul><div class="note">Toss plan, batter types, and attack bowlers: this season plus the last 5 · 3+ inns and 30+ balls · 4+ overs to attack a bowler. Other tips: last 5 matches</div>` : '';
    const sub = cards ? `<h3>Surprise packages</h3><p class="subhead">Haven't played in the last 5 matches</p>${cards}<div class="note">Current and last season · 3+ inns & 30+ balls, 6+ overs</div>` : '';
    return card('🎯', 'How to beat them', list + sub, 'This season and the last 5');
  }
}
$('#go').onclick = () => addLeague($('#lg').value);
$('#lg').onkeydown = e => { if (e.key === 'Enter') addLeague($('#lg').value); };
$('#leagueSel').onchange = () => { if ($('#leagueSel').value) { $('#lg').value = $('#leagueSel').value; selectCached($('#leagueSel').value); } };
$('#team').onchange = () => { syncTeamButton(); loadTeam(); };
$('#teamBtn').onclick = () => { if ($('#teamBtn').disabled) return; $('#teamMenu').hidden = !$('#teamMenu').hidden; };
$('#period').onchange = render;
document.addEventListener('error', e => {
  const img = e.target;
  if (!img || img.tagName !== 'IMG') return;
  img.classList.add('broken');
  const badge = img.closest('.badge');
  if (badge) badge.classList.add('show-fallback');
}, true);
document.addEventListener('click', e => {
  const b = e.target.closest('[data-lg]');
  if (b) { $('#lg').value = b.dataset.lg; addLeague(b.dataset.lg); return; }
  const opt = e.target.closest('[data-team]');
  if (opt && $('#teamMenu') && $('#teamMenu').contains(opt)) {
    $('#team').value = opt.getAttribute('data-team');
    $('#teamMenu').hidden = true;
    $('#team').dispatchEvent(new Event('change'));
    return;
  }
  if (!e.target.closest('.pick') && $('#teamMenu')) $('#teamMenu').hidden = true;
});
async function init() {
  const q = new URLSearchParams(location.search);
  if (['last5', 'current', 'last', 'all'].includes(q.get('period'))) $('#period').value = q.get('period');
  try { await loadCatalog(); }
  catch (e) { msg(e.message); $('#main').innerHTML = welcomeHTML(); return; }
  const code = q.get('league') || recall('lg');
  if (code) { $('#lg').value = code; if (!selectCached(code, q.get('team') || '')) addLeague(code); }
  else $('#main').innerHTML = welcomeHTML();
}
init();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
