// Batch runner: scan many teams with one shared Chrome (persistent profile keeps Cloudflare
// cookies), a hard per-team time limit that kills the team's process tree, and a log line per team.
// Usage: CHROME_PATH=... node scripts/scan-batch.js <league>:"<Team>" [...]   |   --all <league>
//   Time limit: TEAM_TIME_LIMIT_SEC env, else timeLimitSec in scripts/legacy-config.json, else 300.
//   Pages are cached as they load, so a killed team keeps its progress and resumes next run.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');
const store = require('../lib/store');
const { chromePath, LAUNCH_ARGS, PROFILE } = require('../lib/pager');
const REG = require('./legacy-config.json');
const ROOT = path.join(__dirname, '..');

function jobs(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--all') { const code = argv[++i]; const l = store.readLeague(code); for (const t of store.listScannedTeams(code)) out.push({ code: l ? l.code : code, team: t.team }); continue; }
    const k = argv[i].indexOf(':'); out.push({ code: argv[i].slice(0, k), team: argv[i].slice(k + 1) });
  }
  return out;
}
function reg(code) { return REG[String(code).toLowerCase()] || {}; }
function readerOf(code) { const r = reg(code).reader; if (r) return r; const l = store.readLeague(code); return l && l.legacy ? 'legacy' : 'ddcl'; }
function limitOf(code) { return Number(process.env.TEAM_TIME_LIMIT_SEC || reg(code).timeLimitSec || 300); }

function runTeam(job, ws, runId) {
  const legacy = readerOf(job.code) === 'legacy';
  const args = legacy ? ['scripts/legacy-team.js', job.code, job.team] : ['cli.js', 'scan', job.code, job.team];
  const limit = limitOf(job.code);
  return new Promise(resolve => {
    const t0 = Date.now(); let err = ''; let killed = false;
    const ch = spawn(process.execPath, args, { cwd: ROOT, detached: true, env: { ...process.env, CHROME_WS: ws, SCAN_RUN_ID: runId }, stdio: ['ignore', 'pipe', 'pipe'] });
    ch.stdout.on('data', () => {});
    ch.stderr.on('data', d => { err += d; if (process.env.VERBOSE) process.stderr.write(d); });
    const timer = setTimeout(() => { killed = true; try { process.kill(-ch.pid, 'SIGKILL'); } catch {} }, limit * 1000);
    ch.on('exit', code => {
      clearTimeout(timer);
      const statLine = err.split('\n').reverse().find(l => l.startsWith('stats ')); let st = {};
      try { st = JSON.parse(statLine.slice(6)); } catch {}
      const secs = ((Date.now() - t0) / 1000).toFixed(1);
      const status = killed ? 'SKIPPED' : code === 0 ? 'DONE' : 'FAILED';
      const tail = status === 'FAILED' ? ' | ' + err.trim().split('\n').slice(-2).join(' / ').slice(0, 200) : killed ? ` | time limit ${limit}s hit; cached pages kept` : '';
      console.log(`${status.padEnd(7)} ${job.code} / ${job.team}  ${secs}s  pages=${st.pages ?? '?'} ${JSON.stringify(st.byKind || {})} retries=${st.retries ?? '?'} cf=${st.cf ?? '?'}${tail}`);
      resolve({ ...job, status, secs: Number(secs), pages: st.pages ?? null, byKind: st.byKind || {}, retries: st.retries, cf: st.cf });
    });
  });
}

(async () => {
  const list = jobs(process.argv.slice(2));
  if (!list.length) { console.error('Usage: node scripts/scan-batch.js <league>:"<Team>" ... | --all <league>'); process.exit(1); }
  fs.mkdirSync(PROFILE, { recursive: true });
  for (const f of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) { try { fs.unlinkSync(path.join(PROFILE, f)); } catch {} }
  const b = await puppeteer.launch({ executablePath: chromePath(), headless: 'new', userDataDir: PROFILE, args: LAUNCH_ARGS, ignoreDefaultArgs: ['--enable-automation'] });
  const runId = String(process.pid) + '-' + Date.now();
  const t0 = Date.now(); const results = [];
  try {
    for (const job of list) {
      results.push(await runTeam(job, b.wsEndpoint(), runId));
      for (const pg of await b.pages().catch(() => [])) if (pg.url() !== 'about:blank') await pg.close().catch(() => {}); // tabs left by a killed team
    }
  } finally { await b.close().catch(() => {}); try { fs.unlinkSync(path.join(require('os').tmpdir(), `cricscout-run-${runId}.json`)); } catch {} }
  const sum = s => results.filter(r => r.status === s).length;
  console.log(`batch: ${results.length} teams, done=${sum('DONE')} skipped=${sum('SKIPPED')} failed=${sum('FAILED')}, ${((Date.now() - t0) / 1000).toFixed(1)}s total, ${results.reduce((a, r) => a + (r.pages || 0), 0)} pages`);
  fs.writeFileSync(path.join(ROOT, 'scan-batch-result.json'), JSON.stringify(results, null, 2) + '\n');
  process.exitCode = sum('FAILED') ? 1 : 0;
})().catch(e => { console.error(e); process.exit(1); });
