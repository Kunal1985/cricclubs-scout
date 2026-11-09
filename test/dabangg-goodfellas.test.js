const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const store = require('../lib/store');

const CODE = 'DublinandDanvilleCricketLeague';
const SPRING = 'RrVi9ccTsSYpRdWpiBT7sg';
const CAPTURED_AT = '2026-11-08T08:00:00.000Z';
const SCORED = [
  'dAjklt-ME1zMxmgdDatMDg', 'qGpdCvKK6kEgwV0hu1pu4g', 'N_hSr59zpY1ObfnJYJoasQ', 'OvJs2sQT2jDfekhxUUiw9Q',
  '787MSATapUsPniQh7fvpUQ', 'GfKxMOrz2LdmXbSakH1I4w', 'l85Joa_ZoBOBkwCbgjEB-w', 'Pn_hYiCfyv1GBp4kDJ9bug',
  '17IWbs2Kw7k1ZPDNVS5oTw', '5Q9aLWlAdFMMGElYnXzX0Q', 'ieZUWzR2lh9Y5vbdJxSqcQ', 'qQ0JSJudYYGnHrOpgcem1A',
  'AD7QJFgovCdWw68XYbCQIQ', 'Bj_jkGIMzXmOPXnhUz0FIg'
];
const FORFEITS = ['AOv-ungailx3EzTBagxLqg', '3DNNmTmrLUfgDskkDTUU0Q', 'ZgD65n8XoSynW9nSQNgfLA', 'zAxZNMjZdRj3cR3DvBrYfw'];

function oversBalls(s) {
  const [a, b] = String(s).split('.');
  return Number(a) * 6 + (b ? Number(b) : 0);
}

test('Dabangg and Goodfellas Spring cards are real browser captures', () => {
  const league = store.readLeague(CODE);
  assert.equal(league.teams.length, 21);
  assert.deepEqual(new Set(league.teams).size, 21);
  const index = JSON.parse(fs.readFileSync(path.join(store.SITE, 'index.json'), 'utf8'));
  const ddcl = index.leagues.find(l => l.code === CODE);
  assert.equal(ddcl.scanned.length, 21);
  assert.deepEqual(ddcl.scanned, [...ddcl.scanned].sort((a, b) => a.localeCompare(b)));
  assert.ok(ddcl.scanned.includes('Dabangg') && ddcl.scanned.includes('Goodfellas'));

  const expect = {
    Dabangg: { matches: 10, forfeits: 1, points: 21 },
    Goodfellas: { matches: 9, forfeits: 3, points: 25 }
  };
  for (const [name, n] of Object.entries(expect)) {
    const team = store.readTeam(CODE, name);
    const report = store.teamReport(league, name);
    assert.equal(Object.keys(team.series).length, 1);
    assert.equal(team.series[SPRING].scrapedAt, CAPTURED_AT);
    assert.equal(team.series[SPRING].provenance.method, 'browser-capture');
    assert.equal(team.series[SPRING].matchIds.length, n.matches);
    assert.equal(new Set(team.series[SPRING].matchIds).size, n.matches);
    assert.equal(Object.keys(team.matches).length, n.matches);
    const forfeits = Object.values(team.matches).filter(m => m.forfeit);
    assert.equal(forfeits.length, n.forfeits);
    for (const m of forfeits) {
      assert.deepEqual(m.innings, []);
      assert.deepEqual(m.batting, []);
      assert.deepEqual(m.bowling, []);
      assert.equal(m.ground, null);
      assert.match(m.result, /^Forfeited\. Winner: /);
    }
    assert.equal(report.seasons.current.inSeason, false);
    assert.equal(report.seasons.last.inSeason, false);
    assert.equal(report.seasons.prev2.inSeason, true);
    assert.equal(report.seasons.current.scrapedAt, null);
    assert.equal(report.seasons.last.scrapedAt, null);
    assert.equal(Object.keys(report.seasons.current.points.players).length, 0);
    assert.equal(Object.keys(report.seasons.last.points.players).length, 0);
    assert.equal(Object.keys(report.seasons.prev2.points.players).length, n.points);
    assert.match(report.seasons.prev2.points.source, /series=RrVi9ccTsSYpRdWpiBT7sg/);
    assert.equal(report.matches.length, n.matches);
    assert.ok(report.matches.every(m => !Object.prototype.hasOwnProperty.call(m, 'dismissals')));
    assert.equal(report.unresolvedFielders, 0);
    const site = JSON.parse(fs.readFileSync(path.join(store.SITE, 'leagues', 'dublinanddanvillecricketleague', 'teams', store.slug(name) + '.json'), 'utf8'));
    assert.equal(site.matches.length, n.matches);
  }

  const dabangg = store.readTeam(CODE, 'Dabangg');
  const goodfellas = store.readTeam(CODE, 'Goodfellas');
  assert.equal(dabangg.matches['l85Joa_ZoBOBkwCbgjEB-w'].opponent, 'Goodfellas');
  assert.equal(goodfellas.matches['l85Joa_ZoBOBkwCbgjEB-w'].opponent, 'Dabangg');
  assert.equal(dabangg.matches['l85Joa_ZoBOBkwCbgjEB-w'].result, goodfellas.matches['l85Joa_ZoBOBkwCbgjEB-w'].result);
  assert.equal(dabangg.matches['qGpdCvKK6kEgwV0hu1pu4g'].ground, 'TBD');
  assert.equal(dabangg.matches['N_hSr59zpY1ObfnJYJoasQ'].ground, 'Arlington');
  assert.ok(dabangg.matches['qGpdCvKK6kEgwV0hu1pu4g'].batting.some(b => b.name === 'Abhishek Dudi' && b.b === 0 && b.out === false));
  assert.ok(dabangg.matches['l85Joa_ZoBOBkwCbgjEB-w'].batting.some(b => b.name === 'Chintan Tank' && b.b === 0 && b.out === false));
  assert.equal(dabangg.matches['17IWbs2Kw7k1ZPDNVS5oTw'].batting.length, 9);

  const retired = goodfellas.matches['ieZUWzR2lh9Y5vbdJxSqcQ'].batting.filter(b => b.how === 'rto');
  assert.deepEqual(retired.map(b => [b.name, b.r, b.b]), [['Sumit Lad', 0, 0], ['Mitesh Patel', 0, 0], ['Mihir Jawale', 0, 0]]);

  const results = JSON.parse(fs.readFileSync(path.join(store.STORE, 'leagues', 'dublinanddanvillecricketleague', 'results', 'ddcl-spring-2026.json'), 'utf8'));
  const listed = Object.fromEntries(results.matches.map(m => [m.matchId, m.ground]));
  assert.equal(listed['qGpdCvKK6kEgwV0hu1pu4g'], 'East Branch Park');
  assert.equal(listed['N_hSr59zpY1ObfnJYJoasQ'], 'East Branch Park');

  const chhavas = store.readTeam(CODE, 'Chhavas');
  assert.equal(chhavas.matches['GfKxMOrz2LdmXbSakH1I4w'], undefined);
  const falcons = store.readTeam(CODE, 'Bay Area Falcons');
  assert.equal(falcons.series[SPRING].matchIds.length, 9);

  for (const id of SCORED) {
    const raw = store.readScore(CODE, id);
    assert.equal(raw.provenance.method, 'browser-capture');
    assert.equal(raw.scorecard.data.isAbandoned, 0);
    for (const inn of [raw.scorecard.data.innings1, raw.scorecard.data.innings2]) {
      const bat = inn.batting.filter(b => b.outStringNoLink !== 'Did not bat');
      const runs = bat.reduce((s, b) => s + b.runsScored, 0);
      assert.equal(runs + inn.extras.b + inn.extras.lb + inn.extras.wd + inn.extras.nb + inn.extras.pn, inn.total, id + ' ' + inn.teamName);
      const outs = bat.filter(b => b.isOut === '1');
      assert.equal(outs.length, inn.wickets, id + ' wickets ' + inn.teamName);
      const credited = new Set(['b', 'ct', 'ctw', 'st', 'hdb', 'ht']);
      const bowlW = inn.bowling.reduce((s, w) => s + w.wickets, 0);
      assert.equal(bowlW, outs.filter(b => credited.has(b.howOut)).length, id + ' bowler wickets ' + inn.teamName);
      assert.equal(inn.bowling.reduce((s, w) => s + w.balls, 0), oversBalls(inn.overs), id + ' overs ' + inn.teamName);
    }
  }
  const shared = store.readScore(CODE, 'l85Joa_ZoBOBkwCbgjEB-w');
  assert.ok(shared.scorecard.data.innings2.batting.some(b => b.howOut === 'hdb' && b.playerName === 'Pranav Shah'));
  const hit = store.readScore(CODE, 'Pn_hYiCfyv1GBp4kDJ9bug');
  assert.ok(hit.scorecard.data.innings1.batting.some(b => b.howOut === 'ht' && b.outStringNoLink === 'Hit Wicket Abhishek D'));
  const twoC = store.readScore(CODE, 'qQ0JSJudYYGnHrOpgcem1A').scorecard.data.innings2.rolesShown.filter(r => r.marker === 'c' && r.name.endsWith('Phadnis'));
  assert.equal(twoC.length, 2);
  const twoWk = store.readScore(CODE, 'AD7QJFgovCdWw68XYbCQIQ').scorecard.data.innings1.rolesShown.filter(r => r.marker === 'wk' && r.name.endsWith('Phadnis'));
  assert.equal(twoWk.length, 2);
  const both = store.readScore(CODE, 'Bj_jkGIMzXmOPXnhUz0FIg');
  const asBowler = both.scorecard.data.innings1.bowling.some(w => w.firstName === 'Devanath Srinivasa');
  const asBatter = both.scorecard.data.innings2.batting.some(b => b.playerName === 'Devanath Srinivasa');
  assert.equal(asBowler && asBatter, true);

  for (const id of FORFEITS) {
    const raw = store.readScore(CODE, id);
    assert.equal(raw.scorecard.data.isAbandoned, 1);
    assert.equal(raw.scorecard.data.innings1, null);
    assert.equal(raw.scorecard.data.innings2, null);
    assert.equal(raw.header.data.location, null);
    assert.equal(raw.provenance.cardVenue, null);
  }
});
