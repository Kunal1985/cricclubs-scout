// CricClubs access via headless Chrome: loads public pages and captures the JSON the site itself fetches.
const fs = require('fs');
const puppeteer = require('puppeteer-core');
const GAP_MS = Number(process.env.SCRAPE_GAP_MS || 1500);
const sleep = ms => new Promise(r => setTimeout(r, ms));
let browserP = null, chain = Promise.resolve(), lastNav = 0;

function chromePath() {
  const cands = [
    process.env.CHROME_PATH,
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/local/bin/google-chrome',
    '/opt/google/chrome/chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser'
  ].filter(Boolean);
  const hit = cands.find(p => { try { return fs.existsSync(p); } catch { return false; } });
  if (!hit) throw new Error('Chrome not found. Set CHROME_PATH to the browser executable.');
  return hit;
}
async function browser() {
  if (!browserP) {
    const executablePath = chromePath();
    console.error('chrome', executablePath);
    browserP = puppeteer.launch({
      executablePath,
      headless: 'new',
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'],
      ignoreDefaultArgs: ['--enable-automation']
    });
  }
  const b = await browserP;
  if (!b.connected) { browserP = null; return browser(); }
  return b;
}
// Global serial queue: one page load at a time, >= GAP_MS apart (polite rate limit).
function visit(url, want, timeoutMs = 20000) {
  const job = chain.then(async () => {
    const wait = lastNav + GAP_MS - Date.now(); if (wait > 0) await sleep(wait);
    lastNav = Date.now();
    console.error('visit', url);
    const b = await browser(); const pg = await b.newPage(); const cap = {};
    try {
      await pg.evaluateOnNewDocument(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });
      await pg.setRequestInterception(true);
      pg.on('request', r => { const u = r.url(); (/cricclubs\.com|challenges\.cloudflare/.test(u) && !['image', 'media', 'font', 'stylesheet'].includes(r.resourceType())) ? r.continue() : r.abort(); });
      pg.on('response', async r => { const u = r.url(); if (/core-prod-origin/.test(u)) { try { cap[u] = { status: r.status(), body: await r.json() }; } catch (e) {} } });
      const resp = await pg.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(e => { console.error('nav', e.message); return null; });
      const t0 = Date.now();
      const ready = () => want.every(w => Object.keys(cap).some(k => w.test(k)));
      while (Date.now() - t0 < timeoutMs) { if (ready()) break; await sleep(300); }
      await sleep(800);
      if (!ready()) {
        const title = await pg.title().catch(() => '');
        console.error('page', resp ? resp.status() : 0, JSON.stringify(title), 'captured', Object.keys(cap).length);
        if (/just a moment|security verification|attention required/i.test(title)) {
          throw new Error('CricClubs Cloudflare check did not clear. Retry the scan later.');
        }
      }
      return { cap, status: resp ? resp.status() : 0 };
    } finally { await pg.close().catch(() => {}); }
  });
  chain = job.catch(() => {});
  return job;
}
const find = (cap, re) => { const k = Object.keys(cap).find(k => re.test(k)); return k ? cap[k] : null; };

function parseLeagueInput(s) {
  s = String(s || '').trim();
  const m = s.match(/cricclubs\.com\/([A-Za-z0-9_-]+)/i);
  const code = m ? m[1] : s.replace(/^\/+|\/.*$/g, '');
  return /^[A-Za-z0-9_-]{2,80}$/.test(code) ? code : null;
}
async function leagueInfo(code) {
  const { cap } = await visit(`https://cricclubs.com/${code}/results`, [/\/info(\?|$)/], 15000);
  const info = find(cap, new RegExp(`league/${code}/info`, 'i'));
  const d = info && info.status === 200 && info.body && info.body.data;
  if (!d || !d.id) return null;
  return { code: d.shortCode || code, id: d.id, name: d.name };
}
async function seriesForYear(code, lid, y) {
  const { cap } = await visit(`https://cricclubs.com/${code}/results?leagueId=${lid}&year=${y}`, [new RegExp(`series\\?year=${y}`)]);
  const r = find(cap, new RegExp(`series\\?year=${y}`)); const d = r && r.body && r.body.data;
  const list = (d && (d.seriesList || (Array.isArray(d) ? d : []))) || [];
  return list.filter(s => !s.isHiddenSeries).map(s => ({ id: s.id, name: s.name, startDate: s.startDate, year: y }));
}
async function seriesTeams(code, lid, s) {
  const { cap } = await visit(`https://cricclubs.com/${code}/results?leagueId=${lid}&year=${s.year}&series=${s.id}&seriesName=${encodeURIComponent(s.name)}`, [/\/teams\?/]);
  const r = find(cap, /\/teams\?/); const out = {};
  (function walk(o) { if (Array.isArray(o)) o.forEach(walk); else if (o && typeof o === 'object') { if (o.teamId && o.teamName) out[o.teamName.trim()] = o.teamId; Object.values(o).forEach(walk); } })(r && r.body && r.body.data);
  return out; // name -> teamId (ids differ per series)
}
async function teamMatchList(code, lid, s, teamId) {
  const re = /\/matches\?.*teamId=/;
  const { cap } = await visit(`https://cricclubs.com/${code}/results?leagueId=${lid}&year=${s.year}&series=${s.id}&team=${teamId}&seriesName=${encodeURIComponent(s.name)}`, [re]);
  const r = find(cap, re); const d = r && r.body && r.body.data;
  if (!d) throw new Error('match list not returned');
  return [...(d.completed || [])].filter(m => m.scoreSummary && m.scoreSummary.matchId);
}
async function scorecard(code, mid) {
  const { cap } = await visit(`https://cricclubs.com/${code}/results/${mid}`, [/scorecard\?leagueId/, /scorecard\/header/]);
  const sc = find(cap, /scorecard\?leagueId/), h = find(cap, /scorecard\/header/);
  if (!sc || !h) throw new Error('scorecard not returned for ' + mid);
  return { header: h.body, scorecard: sc.body };
}
async function close() {
  const pending = chain.catch(() => {});
  chain = pending;
  await pending;
  if (!browserP) return;
  const b = await browserP.catch(() => null);
  browserP = null;
  if (b) await b.close().catch(() => {});
}
module.exports = { parseLeagueInput, leagueInfo, seriesForYear, seriesTeams, teamMatchList, scorecard, close, chromePath };
