// Convert raw CricClubs scorecard JSON into compact match records (real values only).
const he = s => String(s || '').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n)).replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
function normMatch(listItem, raw, teamId, teamName, series) {
  const h = raw.header.data, s = raw.scorecard.data;
  const opp = h.teamOne.id === teamId ? h.teamTwo.name : h.teamOne.name;
  const res = h.result || ''; const forfeit = !!s.isAbandoned || /forfeit/i.test(res);
  const tw = (h.tossDetails || '').match(/^(.+) won the toss and elected to (bat|bowl)/);
  const inns = [s.innings1, s.innings2].filter(Boolean);
  const rec = { id: h.matchId, date: (h.matchDateTime || '').slice(0, 10), series: series.name, seriesId: series.id, opponent: opp,
    ground: (listItem.ground || {}).name || null, result: res, forfeit, outcome: s.winner === teamId ? 'W' : (s.winner ? 'L' : 'NR'),
    tossWonByUs: tw ? tw[1].trim() === teamName : null, tossDecision: tw ? tw[2] : null, battedFirst: forfeit ? null : h.battingFirst === teamId,
    innings: forfeit ? [] : inns.map(i => ({ team: i.teamName, runs: i.total, wkts: i.wickets, overs: String(i.overs) })),
    batting: [], bowling: [], dismissals: [] };
  if (!forfeit) for (const i of inns) {
    if (i.teamId === teamId) {
      for (const b of i.batting || []) {
        if (!b.ballsFaced && b.isOut !== '1' && !b.runsScored) continue; // did not bat
        rec.batting.push({ name: he(b.playerName).trim(), r: b.runsScored, b: b.ballsFaced, f: b.fours, s: b.sixers, out: b.isOut === '1' });
      }
    } else {
      for (const w of i.bowling || []) rec.bowling.push({ name: `${w.firstName || ''} ${w.lastName || ''}`.trim(), balls: w.balls, r: w.runs, w: w.wickets });
      for (const b of i.batting || []) if (b.howOut) rec.dismissals.push({ how: b.howOut, text: he(b.outStringNoLink).trim() });
    }
  }
  return rec;
}
// Fielding: parse opponent dismissal text, resolve abbreviated names ("Devender S") against the team's roster.
function fielding(matches) {
  const names = new Set(); for (const m of matches) { m.batting.forEach(b => names.add(b.name)); m.bowling.forEach(b => names.add(b.name)); }
  const resolve = a => { a = a.replace(/[†\u2020]/g, '').trim(); if (names.has(a)) return a; const p = a.split(/\s+/);
    const c = [...names].filter(n => { const t = n.split(/\s+/); return t[0] === p[0] && (p.length < 2 || t.slice(1).some(x => x.startsWith(p[p.length - 1]))); });
    return c.length === 1 ? c[0] : null; };
  let unresolved = 0;
  for (const m of matches) {
    const f = {};
    for (const d of m.dismissals || []) {
      let ev = [];
      if (d.how === 'ct' || d.how === 'ctw') { const x = d.text.match(/^c\s*&\s*b\s+(.+)$/) || d.text.match(/^c (.+?) b /); if (x) ev.push([x[1], d.how === 'ct' ? 'c' : 'k']); }
      else if (d.how === 'ro' || d.how === 'mk') { const x = d.text.match(/\((.*?)\)/); if (x) ev = x[1].split('/').filter(s => s.trim()).map(s => [s, 'r']); }
      else if (d.how === 'st') { const x = d.text.match(/^st (.+?) b /); if (x) ev.push([x[1], 's']); }
      for (const [a, k] of ev) { const n = resolve(a); if (!n) { unresolved++; continue; } const key = n + '|' + k; f[key] = (f[key] || 0) + 1; }
    }
    m.fielding = Object.entries(f).map(([k, v]) => { const [n, t] = k.split('|'); return [n, t, v]; });
  }
  return unresolved;
}
module.exports = { normMatch, fielding };
