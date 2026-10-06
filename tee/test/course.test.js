'use strict';
const { test, assert, approx } = require('./_harness.js');
const Course = require('../js/course.js');

test('defaultConfig has the user-specified standards 7/11/15, 8-min base, 6–8 range', () => {
  const c = Course.defaultConfig();
  assert.deepEqual(c.stdByPar, { 3: 7, 4: 11, 5: 15 });
  assert.equal(c.transitDefault, 2);
  assert.equal(c.iBase, 8); assert.equal(c.iMin, 6); assert.equal(c.iMax, 8); assert.equal(c.iHardMax, 10);
  assert.equal(c.yellowOn, 1); assert.equal(c.redOn, 10);
  assert.equal(c.shiftTolMin, 0);
  assert.deepEqual(c.sizeMult, { 1: 1, 2: 1, 3: 1, 4: 1 });
});

test('defaultConfig returns independent copies', () => {
  const a = Course.defaultConfig(); a.stdByPar[3] = 99; a.merge.windowMin = 1;
  const b = Course.defaultConfig();
  assert.equal(b.stdByPar[3], 7); assert.equal(b.merge.windowMin, 30);
});

test('mergeConfig merges nested objects one level and replaces arrays/scalars', () => {
  const m = Course.mergeConfig(Course.defaultConfig(), { yellowOn: 2, stdByPar: { 3: 8 }, ratioClamp: [0.4, 3], merge: { windowMin: 45 } });
  assert.equal(m.yellowOn, 2);
  assert.deepEqual(m.stdByPar, { 3: 8, 4: 11, 5: 15 });
  assert.deepEqual(m.ratioClamp, [0.4, 3]);
  assert.equal(m.merge.windowMin, 45); assert.equal(m.merge.paceTol, 0.2);
});

test('demoLayout is par 72 with 4 par-3s and 4 par-5s, holes numbered 1..18', () => {
  const l = Course.demoLayout();
  assert.equal(l.length, 18);
  assert.equal(l.reduce((s, h) => s + h.par, 0), 72);
  assert.equal(l.filter(h => h.par === 3).length, 4);
  assert.equal(l.filter(h => h.par === 5).length, 4);
  assert.deepEqual(l.map(h => h.no), Array.from({ length: 18 }, (_, i) => i + 1));
});

test('normalizeCourse fills std/transit/clearFrac/minGap/minFollow from config and adds r18 routing', () => {
  const c = Course.normalizeCourse({ id: 'x', name: 'X', holes: Course.demoLayout() });
  assert.equal(c.holes.length, 18);
  const h3 = c.holes[2];
  assert.equal(h3.par, 3); assert.equal(h3.std, 7); assert.equal(h3.clearFrac, 1.0); assert.equal(h3.transit, 2);
  assert.equal(h3.minGap, 6); assert.equal(h3.minFollow, 1);
  assert.equal(c.holes[3].std, 15); assert.equal(c.holes[3].clearFrac, 0.40);
  assert.equal(c.holes[0].std, 11); assert.equal(c.holes[0].clearFrac, 0.45);
  assert.equal(c.routings[0].id, 'r18');
  assert.deepEqual(c.routings[0].holeNos, c.holes.map(h => h.no));
  assert.equal(c.config.iBase, 8);
});

test('normalizeCourse keeps explicit per-hole overrides and merges raw.config', () => {
  const c = Course.normalizeCourse({ holes: [{ no: 1, par: 3, std: 9, transit: 3.5, clearFrac: 0.8 }, { no: 2, par: 5 }], config: { yellowOn: 2 } });
  assert.equal(c.holes[0].std, 9); assert.equal(c.holes[0].transit, 3.5); assert.equal(c.holes[0].clearFrac, 0.8);
  assert.equal(c.holes[1].std, 15);
  assert.equal(c.config.yellowOn, 2);
  // 总长:198 打球 + 转场
  const total = Course.normalizeCourse({ holes: Course.demoLayout() }).holes.reduce((s, h) => s + h.std, 0);
  assert.equal(total, 198);
});

test('holesForRouting returns holes in routing order; falls back to first routing', () => {
  const c = Course.normalizeCourse({ holes: Course.demoLayout(), routings: [{ id: 'back9', name: '后九', holeNos: [10, 11, 12, 13, 14, 15, 16, 17, 18] }] });
  const back = Course.holesForRouting(c, 'back9');
  assert.deepEqual(back.map(h => h.no), [10, 11, 12, 13, 14, 15, 16, 17, 18]);
  assert.equal(Course.holesForRouting(c, 'nope').length, 18);
  assert.equal(Course.holesForRouting(c, 'r18')[0].no, 1);
});

test('bottleneck B(f) and derivedIBase: default course B(1)=7 → iBase 8; B(0.85)=6 (minGap floor)', () => {
  const holes = Course.normalizeCourse({ holes: Course.demoLayout() }).holes;
  const cfg = Course.defaultConfig();
  approx(Course.bottleneck(holes, 1.0), 7);
  approx(Course.bottleneck(holes, 0.85), 6);     // 7×0.85 = 5.95 < minGap 6
  approx(Course.bottleneck(holes, 1.2), 8.4);
  assert.equal(Course.derivedIBase(holes, cfg), 8);
  // 把三杆洞标准时间改成 8 → 推导间隔 9
  const slow = holes.map(h => h.par === 3 ? Object.assign({}, h, { std: 8 }) : h);
  assert.equal(Course.derivedIBase(slow, cfg), 9);
});

test('time helpers', () => {
  assert.equal(Course.fmtHM(488), '08:08');
  assert.equal(Course.fmtHM(488.9), '08:08');
  assert.equal(Course.fmtHM(0), '00:00');
  assert.equal(Course.fmtHM(1445), '00:05');
  assert.equal(Course.fmtHM(null), '--:--');
  assert.equal(Course.parseHM('08:08'), 488);
  assert.equal(Course.parseHM('6:30'), 390);
  assert.ok(Number.isNaN(Course.parseHM('abc')));
  assert.equal(Course.fmtDur(6.4), '6 分钟');
  assert.equal(Course.fmtDur(112), '1 小时 52 分');
  assert.equal(Course.fmtDur(120), '2 小时');
});

test('math helpers: clamp, median, percentile, mean, daysBetween, compareByTee', () => {
  assert.equal(Course.clamp(5, 6, 8), 6); assert.equal(Course.clamp(9, 6, 8), 8); assert.equal(Course.clamp(7, 6, 8), 7);
  assert.equal(Course.median([3, 1, 2]), 2);
  assert.equal(Course.median([4, 1, 3, 2]), 2.5);
  assert.ok(Number.isNaN(Course.median([])));
  approx(Course.percentile([1, 2, 3, 4, 5], 20), 1.8);
  approx(Course.percentile([10], 50), 10);
  approx(Course.mean([1, 2, 3]), 2);
  assert.equal(Course.daysBetween('2026-10-01', '2026-10-06'), 5);
  assert.equal(Course.daysBetween('2026-10-06', '2026-10-01'), -5);
  const arr = [{ id: 'b', tee: 480 }, { id: 'a', tee: 480 }, { id: 'c', tee: 470 }].sort(Course.compareByTee);
  assert.deepEqual(arr.map(x => x.id), ['c', 'a', 'b']);
});

test('decayN halves nEff per half-life and ignores missing dates', () => {
  const cfg = Course.defaultConfig();
  approx(Course.decayN(4, '2026-01-01', '2026-06-30', cfg), 2);          // 180 days
  approx(Course.decayN(3, '2026-10-06', '2026-10-06', cfg), 3);
  approx(Course.decayN(3, '2026-10-05', '2026-10-06', cfg), 3 * Math.pow(0.5, 1 / 180));
  assert.equal(Course.decayN(3, null, '2026-10-06', cfg), 3);
  approx(Course.decayN(3, '2026-10-07', '2026-10-06', cfg), 3);          // future date → no decay
});
