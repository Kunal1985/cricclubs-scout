// Robust page loading for CricClubs: one shared browser, short per-page timeouts,
// fresh tab after any failure, retries with exponential backoff + jitter, and
// Cloudflare-aware pacing (back off 30/60/120s and slow down for the rest of the run).
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const jitter = ms => Math.round(ms * (0.75 + Math.random() * 0.5));
const num = (v, d) => (v === undefined || v === '' || isNaN(Number(v)) ? d : Number(v));
const GOTO_MS = num(process.env.GOTO_TIMEOUT_MS, 25000);
const STEP_MS = num(process.env.STEP_TIMEOUT_MS, 10000);
const CF_WAIT_MS = num(process.env.CF_WAIT_MS, 15000);
const RETRIES = num(process.env.PAGE_RETRIES, 3);
const GAP_MS = num(process.env.SCRAPE_GAP_MS, 400);
const CF_BACKOFF = (process.env.CF_BACKOFF_SEC || '30,60,120').split(',').map(Number);
const PROFILE = process.env.CHROME_PROFILE || path.join(__dirname, '..', 'data', '.chrome-profile');
const CF_TITLE = /just a moment|security verification|attention required/i;

function withTimeout(p, ms, what) {
  let t; const to = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`timeout ${ms}ms: ${what}`)), ms); });
  return Promise.race([p, to]).finally(() => clearTimeout(t));
}
function chromePath() {
  const c = [process.env.CHROME_PATH, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(Boolean);
  const hit = c.find(p => { try { return fs.existsSync(p); } catch { return false; } });
  if (!hit) throw new Error('Chrome not found. Set CHROME_PATH to the browser executable.');
  return hit;
}
const LAUNCH_ARGS = ['--no-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'];
// Launch (or connect to CHROME_WS from the batch runner). The profile dir keeps Cloudflare cookies between runs.
async function launchBrowser() {
  if (process.env.CHROME_WS) return { browser: await puppeteer.connect({ browserWSEndpoint: process.env.CHROME_WS }), shared: true };
  fs.mkdirSync(PROFILE, { recursive: true });
  for (const f of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) { try { fs.unlinkSync(path.join(PROFILE, f)); } catch {} }
  const browser = await puppeteer.launch({ executablePath: chromePath(), headless: 'new', userDataDir: PROFILE, args: LAUNCH_ARGS, ignoreDefaultArgs: ['--enable-automation'] });
  return { browser, shared: false };
}

const stats = { pages: 0, ok: 0, retries: 0, failures: 0, cf: 0, cached: 0, byKind: {} };
const state = { slow: false, cfHits: 0, lastNav: 0 };
let navLock = Promise.resolve();
// Serialize the *start* of navigations so parallel tabs still respect the gap.
function pace() {
  const p = navLock.then(async () => {
    const gap = state.slow ? 3000 : GAP_MS;
    const wait = state.lastNav + jitter(gap) - Date.now();
    if (wait > 0) await sleep(wait);
    state.lastNav = Date.now();
  });
  navLock = p.catch(() => {});
  return p;
}
async function cloudflarePenalty(why) {
  stats.cf++; state.slow = true;
  const sec = CF_BACKOFF[Math.min(state.cfHits, CF_BACKOFF.length - 1)]; state.cfHits++;
  console.error(`cloudflare (${why}); backing off ${sec}s and slowing down for the rest of the run`);
  await sleep(jitter(sec * 1000));
}

class Pager {
  constructor() { this.browser = null; this.shared = false; this.tabs = new Set(); }
  async start() {
    if (this.browser && this.browser.connected) return;
    const { browser, shared } = await launchBrowser(); this.browser = browser; this.shared = shared;
  }
  async newTab({ offline = false } = {}) {
    await this.start();
    const pg = await withTimeout(this.browser.newPage(), STEP_MS, 'newPage');
    this.tabs.add(pg);
    if (offline) {
      await pg.setJavaScriptEnabled(false);
      await pg.setRequestInterception(true);
      pg.on('request', r => r.abort());
      return pg;
    }
    await pg.setUserAgent((await this.browser.userAgent()).replace('HeadlessChrome', 'Chrome'));
    await pg.evaluateOnNewDocument(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });
    await pg.setRequestInterception(true);
    pg.on('request', r => (/cricclubs\.com|challenges\.cloudflare/.test(r.url()) && !['image', 'media', 'font', 'stylesheet'].includes(r.resourceType())) ? r.continue() : r.abort());
    return pg;
  }
  async closeTab(pg) { this.tabs.delete(pg); await withTimeout(pg.close(), 5000, 'close').catch(() => {}); }
  // Load url in tab `slot.pg` and return its HTML once `ready` (CSS selector) appears.
  // Any failure closes the tab and the next attempt uses a fresh one.
  async html(url, { ready = 'body', slot = null, kind = 'page' } = {}) {
    const own = !slot; slot = slot || {};
    let lastErr;
    try {
      for (let i = 0; i < RETRIES; i++) {
        if (i) { stats.retries++; await sleep(jitter(2000 * 2 ** (i - 1))); }
        try {
          if (!slot.pg) slot.pg = await this.newTab();
          const pg = slot.pg;
          await pace();
          stats.pages++; stats.byKind[kind] = (stats.byKind[kind] || 0) + 1;
          const resp = await pg.goto(url, { waitUntil: 'domcontentloaded', timeout: GOTO_MS });
          const status = resp ? resp.status() : 0;
          let title = await withTimeout(pg.title(), STEP_MS, 'title');
          const challenged = CF_TITLE.test(title);
          if (challenged) { stats.cfChallenges = (stats.cfChallenges || 0) + 1;
            const t0 = Date.now();
            while (Date.now() - t0 < CF_WAIT_MS && CF_TITLE.test(title)) { await sleep(500); title = await withTimeout(pg.title(), STEP_MS, 'title').catch(() => title); }
            if (CF_TITLE.test(title)) { await cloudflarePenalty('challenge did not clear'); throw new Error('cloudflare challenge ' + url); }
          }
          if (!challenged && (status === 403 || status === 429)) { await cloudflarePenalty('HTTP ' + status); throw new Error('HTTP ' + status + ' ' + url); }
          await pg.waitForSelector(ready, { timeout: STEP_MS }).catch(() => { throw new Error(`selector ${ready} missing ${url}`); });
          const h = await withTimeout(pg.content(), STEP_MS, 'content');
          stats.ok++;
          return h;
        } catch (e) {
          lastErr = e; stats.failures++;
          console.error(`  page attempt ${i + 1}/${RETRIES} failed: ${e.message.split('\n')[0]}`);
          if (slot.pg) { await this.closeTab(slot.pg); slot.pg = null; }
          if (this.browser && !this.browser.connected) { this.browser = null; }
        }
      }
      throw lastErr;
    } finally { if (own && slot.pg) await this.closeTab(slot.pg); }
  }
  // Run fn(dom) against saved HTML in a JS-less, network-less tab (zero requests).
  async parse(html, fn, ...args) {
    if (!this.offline) this.offline = await this.newTab({ offline: true });
    try {
      await withTimeout(this.offline.setContent(html, { waitUntil: 'domcontentloaded' }), STEP_MS, 'setContent');
      return await withTimeout(this.offline.evaluate(fn, ...args), STEP_MS, 'evaluate');
    } catch (e) { await this.closeTab(this.offline).catch(() => {}); this.offline = null; throw e; }
  }
  async close() {
    for (const pg of [...this.tabs]) await this.closeTab(pg);
    if (!this.browser) return;
    if (this.shared) await this.browser.disconnect().catch(() => {}); else await withTimeout(this.browser.close(), 10000, 'browser close').catch(() => {});
    this.browser = null;
  }
}
// Run tasks with up to `n` workers; drops to 1 worker as soon as Cloudflare is seen.
async function pool(items, n, worker) {
  const q = items.slice(); const out = [];
  const run = async id => { while (q.length) { if (id > 0 && state.slow) return; const it = q.shift(); out.push(await worker(it, id)); } };
  await Promise.all(Array.from({ length: Math.max(1, n) }, (_, i) => run(i)));
  return out;
}
const concurrency = () => Math.min(4, Math.max(1, num(process.env.CONCURRENCY, 2)));
module.exports = { Pager, pool, stats, state, sleep, withTimeout, chromePath, launchBrowser, concurrency, LAUNCH_ARGS, PROFILE, CF_TITLE };
