const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-seasons-'));
process.env.DATA_DIR = dir;
const store = require('../lib/store');
const { commentFor } = require('../lib/issue');

test('season keys stay current, last, prev2', () => {
  assert.deepEqual(store.SEASON_KEYS, ['current', 'last', 'prev2']);
});

test('team report publishes prev2 when the league file has it', () => {
  const league = {
    code: 'ExampleLeague',
    name: 'Example',
    seasons: {
      current: { id: 'c', name: 'Fall', teams: { Skippers: '1' } },
      last: { id: 'l', name: 'Summer', teams: { Skippers: '1' } },
      prev2: { id: 'p', name: 'Spring', teams: { Skippers: '1' } }
    },
    teams: ['Skippers'],
    logos: {}
  };
  store.writeLeague(league);
  store.writeTeam(league.code, 'Skippers', {
    team: 'Skippers',
    league: league.code,
    series: {
      c: { name: 'Fall', scrapedAt: '2026-01-01T00:00:00.000Z', matchIds: ['m1'] },
      p: { name: 'Spring', scrapedAt: '2025-01-01T00:00:00.000Z', matchIds: ['m2'] }
    },
    matches: {
      m1: { id: 'm1', date: '2026-01-01', seriesId: 'c', batting: [], bowling: [] },
      m2: { id: 'm2', date: '2025-01-01', seriesId: 'p', batting: [], bowling: [] }
    }
  });
  const report = store.teamReport(league, 'Skippers');
  assert.equal(report.seasons.current.name, 'Fall');
  assert.equal(report.seasons.last.name, 'Summer');
  assert.equal(report.seasons.last.inSeason, true);
  assert.equal(report.seasons.prev2.name, 'Spring');
  assert.deepEqual(report.matches.map(m => m.id), ['m1', 'm2']);
  assert.ok(report.matches.every(m => !Object.prototype.hasOwnProperty.call(m, 'dismissals')));
});

test('scan comment names prev2 only when that season exists', () => {
  const both = commentFor({ ok: true, kind: 'team', name: 'Example', code: 'ExampleLeague', team: 'Skippers', newMatches: 0, current: 'Fall', last: 'Summer', url: 'https://example.test/', asOf: '' });
  assert.match(both, /Current season: Fall/);
  assert.match(both, /Last season: Summer/);
  assert.doesNotMatch(both, /Season before last/);
  const three = commentFor({ ok: true, kind: 'team', name: 'Example', code: 'ExampleLeague', team: 'Skippers', newMatches: 1, current: 'Fall', last: 'Summer', prev2: 'Spring', url: 'https://example.test/', asOf: 'data as of 2026-01-01' });
  assert.match(three, /Season before last: Spring/);
});
