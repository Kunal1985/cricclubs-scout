const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const vm = require('vm');

const src = fs.readFileSync(require('path').join(__dirname, '../site/app.js'), 'utf8');
const block = src.match(/\/\* scan-window:start \*\/([\s\S]*?)\/\* scan-window:end \*\//);
assert.ok(block, 'scan window helper is marked in site/app.js');
const context = {};
vm.runInNewContext(block[1], context);
const { nextScanAfter, formatPt } = context;

function at(iso) {
  const when = nextScanAfter(iso);
  return { iso: when.toISOString(), label: formatPt(when) };
}

test('Sunday Nov 1 2026 opens Monday Nov 9 at noon PT', () => {
  const got = at('2026-11-01T20:00:00.000Z');
  assert.equal(got.iso, '2026-11-09T20:00:00.000Z');
  assert.equal(got.label, 'Mon Nov 9, 12:00 PM PT');
});

test('Wednesday Nov 4 2026 opens Monday Nov 9 at noon PT', () => {
  const got = at('2026-11-04T18:00:00.000Z');
  assert.equal(got.iso, '2026-11-09T20:00:00.000Z');
  assert.equal(got.label, 'Mon Nov 9, 12:00 PM PT');
});

test('Saturday Nov 7 2026 10:00 AM PT opens Monday Nov 16 at noon PT', () => {
  const got = at('2026-11-07T18:00:00.000Z');
  assert.equal(got.iso, '2026-11-16T20:00:00.000Z');
  assert.equal(got.label, 'Mon Nov 16, 12:00 PM PT');
});

test('league matchDays overrides the default weekend', () => {
  const onlySunday = nextScanAfter('2026-11-07T18:00:00.000Z', { matchDays: [0] });
  assert.equal(onlySunday.toISOString(), '2026-11-09T20:00:00.000Z');
});
