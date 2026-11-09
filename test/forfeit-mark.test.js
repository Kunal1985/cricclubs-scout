const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const store = require('../lib/store');

const src = fs.readFileSync(path.join(__dirname, '../site/app.js'), 'utf8');
const block = src.match(/\/\* result-mark:start \*\/([\s\S]*?)\/\* result-mark:end \*\//);
assert.ok(block, 'result mark helper is marked in site/app.js');
const context = {};
vm.runInNewContext(block[1], context);
const { resultMark, resultBadgeText, resultBoardKind } = context;

const playedWin = { outcome: 'W', forfeit: false, date: '2026-04-18', opponent: 'Loyals', innings: [{ team: 'Us', runs: 70, wkts: 4, overs: '18' }] };
const playedLoss = { outcome: 'L', forfeit: false, date: '2026-04-05', opponent: 'Vikings', innings: [{ team: 'Us', runs: 40, wkts: 10, overs: '16' }] };
const forfeitedWin = { outcome: 'W', forfeit: true, date: '2026-07-25', opponent: 'Sunrise Strikers', result: 'Forfeited. Winner: Dublin Super Kings', innings: [] };
const forfeitedLoss = { outcome: 'L', forfeit: true, date: '2026-07-25', opponent: 'Dublin Super Kings', result: 'Forfeited. Winner: Dublin Super Kings', innings: [] };
const zeroNotForfeit = { outcome: 'W', forfeit: false, date: '2026-05-01', opponent: 'Monks', innings: [{ team: 'Us', runs: 0, wkts: 0, overs: '0' }, { team: 'Monks', runs: 0, wkts: 0, overs: '0' }] };
const noResult = { outcome: 'NR', forfeit: false, date: '2026-06-01', opponent: 'PVCC', result: 'It is a Tie', innings: [{ team: 'Us', runs: 71, wkts: 9, overs: '20' }] };
const emptyNoResult = { outcome: 'NR', forfeit: false, date: '2026-06-02', opponent: 'PVCC', result: 'No result', innings: [] };

test('played results stay W and L', () => {
  assert.deepEqual(resultMark(playedWin), { code: 'W', word: 'Win' });
  assert.deepEqual(resultMark(playedLoss), { code: 'L', word: 'Loss' });
  assert.equal(resultBoardKind(playedWin), 'played');
  assert.equal(resultBoardKind(playedLoss), 'played');
});

test('the same forfeit is FW for the winner and FL for the loser', () => {
  assert.deepEqual(resultMark(forfeitedWin), { code: 'FW', word: 'Forfeited win' });
  assert.deepEqual(resultMark(forfeitedLoss), { code: 'FL', word: 'Forfeited loss' });
  assert.equal(resultBadgeText(forfeitedWin).tip, 'Forfeited win · 2026-07-25 vs Sunrise Strikers');
  assert.equal(resultBadgeText(forfeitedLoss).tip, 'Forfeited loss · 2026-07-25 vs Dublin Super Kings');
  assert.equal(resultBoardKind(forfeitedWin), 'forfeit');
  assert.equal(resultBoardKind(forfeitedLoss), 'forfeit');
});

test('a zero score without the forfeit flag stays a normal result', () => {
  assert.equal(resultMark(zeroNotForfeit).code, 'W');
  assert.equal(resultBoardKind(zeroNotForfeit), 'played');
});

test('a no-result stays NR, including when the card is empty', () => {
  assert.deepEqual(resultMark(noResult), { code: 'NR', word: 'No result' });
  assert.equal(resultBoardKind(noResult), 'played');
  assert.deepEqual(resultMark(emptyNoResult), { code: 'NR', word: 'No result' });
  assert.equal(resultBoardKind(emptyNoResult), 'no-scorecard');
});

test('a forfeit that still carries an innings array is not shown as a played score', () => {
  const odd = { outcome: 'L', forfeit: true, date: '2026-08-01', opponent: 'Elite XI', innings: [{ team: 'Us', runs: 0, wkts: 0, overs: '0' }] };
  assert.equal(resultMark(odd).code, 'FL');
  assert.equal(resultBoardKind(odd), 'forfeit');
});

test('stored Dublin Super Kings and Sunrise Strikers see opposite marks for one forfeit', () => {
  const league = 'DublinandDanvilleCricketLeague';
  const id = 'zWM7ZoSbP8NIH28QM0_58w';
  const win = store.readTeam(league, 'Dublin Super Kings').matches[id];
  const loss = store.readTeam(league, 'Sunrise Strikers').matches[id];
  assert.equal(win.forfeit, true);
  assert.equal(loss.forfeit, true);
  assert.equal(resultMark(win).code, 'FW');
  assert.equal(resultMark(loss).code, 'FL');
  const tie = Object.values(store.readTeam(league, 'Deccan Chargers').matches).find(m => m.id === 'uSzS0-_WfjXm6-UgdRR6Ng');
  assert.equal(tie.forfeit, false);
  assert.equal(resultMark(tie).code, 'NR');
});

test('form and result badges both use the accessible mark', () => {
  assert.match(src, /formBits = ms\.slice\(0, 12\)\.map\(\(m, i\) => resultBadge\(m/);
  assert.match(src, /res-h">\$\{resultBadge\(m\)\}/);
  assert.match(src, /aria-label="\$\{esc\(b\.tip\)\}"/);
  assert.doesNotMatch(src, /class="fc \$\{esc\(m\.outcome\)\}"/);
});
