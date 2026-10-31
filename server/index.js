// One-team scan probe for Render. Does not serve the Pages site.
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const puppeteer = require('puppeteer-core');
const store = require('../lib/store');

const PORT = Number(process.env.PORT) || 10000;
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome-stable';
const ROOT = path.join(__dirname, '..');
const SCAN_MS = 12 * 60 * 1000;
let busy = false;

const CLUBS = {
  ddcl: 'DublinandDanvilleCricketLeague',
  dublinanddanvillecricketleague: 'DublinandDanvilleCricketLeague',
  mtca: 'MountainHouseTracyCricketAssociationMTCA',
  mountainhousetracycricketassociationmtca: 'MountainHouseTracyCricketAssociationMTCA',
  srca: 'SrcaUsa',
  srcausa: 'SrcaUsa'
};

function send(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(json);
}

function resolveClub(raw) {
  const key = String(raw || '').trim();
  return CLUBS[key.toLowerCase()] || key;
}

function useLegacy(code) {
  if (code === 'DublinandDanvilleCricketLeague') return false;
  const league = store.readLeague(code);
  if (league && league.legacy) return true;
  return /mtca|srcausa|srca/i.test(code);
}

function challenge(title, status) {
  return /just a moment|security verification|attention required/i.test(title || '') || status === 403;
}

async function probe(club) {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'],
    ignoreDefaultArgs: ['--enable-automation']
  });
  try {
    const page = await browser.newPage();
    const ua = await browser.userAgent();
    await page.setUserAgent(ua.replace('HeadlessChrome', 'Chrome'));
    const resp = await page.goto('https://cricclubs.com/' + encodeURIComponent(club), { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => null);
    const title = await page.title().catch(() => '');
    const httpStatus = resp ? resp.status() : 0;
    return { httpStatus, cloudflare: challenge(title, httpStatus), title };
  } finally {
    await browser.close().catch(() => {});
  }
}

function runScan(club, team, legacy) {
  const args = legacy ? ['scripts/legacy-team.js', club, team] : ['cli.js', 'scan', club, team];
  return new Promise(resolve => {
    const child = spawn(process.execPath, args, {
      cwd: ROOT,
      env: { ...process.env, CHROME_PATH: CHROME }
    });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); err += '\nscan timed out'; }, SCAN_MS);
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', e => { clearTimeout(timer); resolve({ code: 1, out, err: err + '\n' + e.message }); });
    child.on('close', code => { clearTimeout(timer); resolve({ code: code == null ? 1 : code, out, err }); });
  });
}

function matchesFound(out, err, legacy) {
  if (legacy) {
    const m = out.match(/\{[\s\S]*\}\s*$/);
    if (m) {
      try {
        const j = JSON.parse(m[0]);
        const n = Object.values(j).reduce((s, v) => s + Number(v || 0), 0);
        if (n) return n;
      } catch (e) {}
    }
  }
  const listed = [...err.matchAll(/(\d+) matches/g)].map(x => Number(x[1]));
  if (listed.length) return listed.reduce((s, n) => s + n, 0);
  const line = out.trim().split('\n').filter(Boolean).pop();
  if (line) {
    try {
      const j = JSON.parse(line);
      if (typeof j.newMatches === 'number') return j.newMatches;
    } catch (e) {}
  }
  return 0;
}

async function testScan(club, team) {
  const started = Date.now();
  const legacy = useLegacy(club);
  let seen = { httpStatus: 0, cloudflare: false, title: '' };
  try { seen = await probe(club); }
  catch (e) { seen = { httpStatus: 0, cloudflare: /cloudflare|just a moment/i.test(e.message), title: '', probeError: e.message }; }
  const scan = await runScan(club, team, legacy);
  const log = scan.err + '\n' + scan.out;
  const cloudflare = seen.cloudflare || /cloudflare|just a moment|security verification/i.test(log);
  const success = scan.code === 0 && !/cloudflare|just a moment/i.test(scan.err);
  return {
    success,
    httpStatus: seen.httpStatus,
    cloudflare,
    matchesFound: matchesFound(scan.out, scan.err, legacy),
    durationMs: Date.now() - started,
    club,
    team,
    scanner: legacy ? 'legacy-team.js' : 'cli.js',
    exitCode: scan.code,
    error: success ? null : (scan.err.trim().split('\n').filter(Boolean).slice(-3).join(' ') || 'scan failed')
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true });
  if (req.method !== 'GET' || url.pathname !== '/test-scan') return send(res, 404, { success: false, error: 'not found' });
  const club = resolveClub(url.searchParams.get('club'));
  const team = String(url.searchParams.get('team') || '').trim();
  if (!club || !team) return send(res, 400, { success: false, error: 'club and team are required' });
  if (busy) return send(res, 429, { success: false, error: 'a scan is already running' });
  busy = true;
  try { send(res, 200, await testScan(club, team)); }
  catch (e) { send(res, 500, { success: false, httpStatus: 0, cloudflare: /cloudflare|just a moment/i.test(e.message), matchesFound: 0, durationMs: 0, club, team, error: e.message }); }
  finally { busy = false; }
});

server.requestTimeout = SCAN_MS + 60000;
server.headersTimeout = SCAN_MS + 60000;
server.listen(PORT, () => console.error('scan test listening on ' + PORT));
