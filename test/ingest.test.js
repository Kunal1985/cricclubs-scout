const test = require('node:test');
const assert = require('node:assert');
const ingest = require('../lib/ingest');

const index = { matches: [
  { matchId: '10', date: '2026-07-11', teams: ['Skippers', 'Vikings'], teamIds: ['1043', '1045'] },
  { matchId: '12', date: '2026-08-01', teams: ['Titans', 'Skippers'], teamIds: ['1068', '1043'] },
  { matchId: '11', date: '2026-07-18', teams: ['Titans', 'Vikings'], teamIds: ['1068', '1045'] },
  { matchId: '13', date: '2026-08-08', teams: ['Knight Walkers (CA)', 'Skippers'], teamIds: ['9', null] },
] };

test('results index gives one team its matchIds, newest first, by team id', () => {
  assert.deepEqual(ingest.teamMatchIds(index, 'Skippers', 1043), ['13', '12', '10']);
  assert.deepEqual(ingest.teamMatchIds(index, 'Vikings', '1045'), ['11', '10']);
});
test('team name is the fallback when ids differ, ignoring case and (CA)', () => {
  assert.deepEqual(ingest.teamMatchIds(index, 'knight walkers', 'x'), ['13']);
  assert.equal(ingest.teamMatchIds(null, 'Skippers', 1), null);
});
test('current season refresh waits for the weekend rule', () => {
  const league = { ingest: { refreshedAt: '2026-11-01T20:00:00.000Z' } };
  assert.equal(ingest.refreshDue(league, new Date('2026-11-09T19:59:00.000Z')).due, false);
  assert.equal(ingest.refreshDue(league, new Date('2026-11-09T20:00:00.000Z')).due, true);
  assert.equal(ingest.refreshDue({}, new Date()).due, true);
  assert.equal(ingest.refreshDue(league).label, 'Mon Nov 9, 12:00 PM PT');
});
