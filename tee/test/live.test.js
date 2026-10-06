'use strict';
const { test, assert, approx } = require('./_harness.js');
const Course = require('../js/course.js');
const Pace = require('../js/pace.js');
const Live = require('../js/live.js');

const course = Course.normalizeCourse({ holes: Course.demoLayout() });
const holes = course.holes;        // std: 11,11,7,15,11,11,7,15,11 | 11,7,15,11,11,7,11,15,11 ; transit 2
const cfg = Course.defaultConfig();
const H = holes.length;
const D = '2026-10-06';

function ev(bookingId, holeNo, type, t) { return { id: bookingId + ':' + holeNo + ':' + type, bookingId, holeNo, type, t, source: 'sim' }; }
function snap(x) { return JSON.stringify(x); }
// 场上组记录(供 gate / holdCount 单测)
function rec(o) {
  return Object.assign({ bookingId: 'g', holeIdx: 6, phase: 'playing', level: 'red', cause: 'OWN', lag: 12,
    plan: { fPlan: 1, confident: false }, playThrough: null, behindId: undefined, holdCount: 0 }, o);
}

// ---------- §5.1 deriveProgress ----------
test('deriveProgress: no tee-off → notStarted (holeIdx −1, holeNo null, empty actuals)', () => {
  const p = Live.deriveProgress({ id: 'A', teeMin: 480, status: 'checkedIn' }, [], holes);
  assert.equal(p.bookingId, 'A'); assert.equal(p.phase, 'notStarted'); assert.equal(p.holeIdx, -1); assert.equal(p.holeNo, null);
  assert.equal(p.teeOffActual, undefined); assert.deepEqual(p.actuals, {}); assert.equal(p.playThrough, null);
});

test('deriveProgress: playing / between / playing next hole / done, holeIdx convention', () => {
  const b = { id: 'A', teeMin: 480, status: 'onCourse' };
  let p = Live.deriveProgress(b, [ev('A', 1, 'teeOff', 480)], holes);
  assert.equal(p.phase, 'playing'); assert.equal(p.holeIdx, 0); assert.equal(p.holeNo, 1);
  assert.equal(p.teeOffActual, 480); assert.equal(p.currentHoleStart, 480); assert.equal(p.lastEventT, 480);
  assert.deepEqual(p.actuals, { 0: { start: 480 } });

  p = Live.deriveProgress(b, [ev('A', 1, 'teeOff', 480), ev('A', 1, 'leaveGreen', 492)], holes);
  assert.equal(p.phase, 'between'); assert.equal(p.holeIdx, 1); assert.equal(p.holeNo, 2);     // 下一洞的洞序
  assert.equal(p.currentHoleStart, undefined); assert.equal(p.lastLeaveGreen, 492); assert.equal(p.lastEventT, 492);
  assert.deepEqual(p.actuals, { 0: { start: 480, finish: 492 } });

  p = Live.deriveProgress(b, [ev('A', 1, 'teeOff', 480), ev('A', 1, 'leaveGreen', 492), ev('A', 2, 'arriveTee', 493), ev('A', 2, 'teeOff', 494)], holes);
  assert.equal(p.phase, 'playing'); assert.equal(p.holeIdx, 1); assert.equal(p.holeNo, 2);
  assert.equal(p.currentHoleStart, 494); assert.equal(p.lastLeaveGreen, 492); assert.equal(p.lastEventT, 494);
  assert.equal(p.actuals[2], undefined);        // arriveTee 不进 actuals

  const all = [];
  holes.forEach((h, i) => { all.push(ev('A', h.no, 'teeOff', 480 + i * 13)); all.push(ev('A', h.no, 'leaveGreen', 480 + i * 13 + 11)); });
  p = Live.deriveProgress(b, all, holes);
  assert.equal(p.phase, 'done'); assert.equal(p.holeIdx, H); assert.equal(p.holeNo, null);
  // status finished → done regardless of events
  p = Live.deriveProgress({ id: 'A', teeMin: 480, status: 'finished' }, [ev('A', 1, 'teeOff', 480)], holes);
  assert.equal(p.phase, 'done'); assert.equal(p.holeIdx, H);
});

test('deriveProgress: semantic dedupe (earliest per hole/type), unknown holes and other bookings ignored', () => {
  const b = { id: 'A', teeMin: 480, status: 'onCourse' };
  const p = Live.deriveProgress(b, [
    ev('A', 1, 'teeOff', 482), ev('A', 1, 'teeOff', 480), ev('A', 1, 'teeOff', 481),
    ev('A', 99, 'teeOff', 300), ev('A', 99, 'leaveGreen', 310),
    ev('B', 1, 'leaveGreen', 490), ev('B', 5, 'teeOff', 470)
  ], holes);
  assert.equal(p.teeOffActual, 480); assert.equal(p.currentHoleStart, 480); assert.equal(p.phase, 'playing'); assert.equal(p.holeIdx, 0);
  assert.deepEqual(p.actuals, { 0: { start: 480 } });
  assert.equal(p.lastEventT, 480);
});

test('deriveProgress: teeOffActual precedence — first-hole teeOff event beats booking.teeOffActual; booking field alone starts hole 0', () => {
  let p = Live.deriveProgress({ id: 'A', teeMin: 480, status: 'onCourse', teeOffActual: 485 }, [ev('A', 1, 'teeOff', 480)], holes);
  assert.equal(p.teeOffActual, 480);
  p = Live.deriveProgress({ id: 'A', teeMin: 480, status: 'onCourse', teeOffActual: 485 }, [], holes);
  assert.equal(p.teeOffActual, 485); assert.equal(p.phase, 'playing'); assert.equal(p.holeIdx, 0);
  assert.equal(p.currentHoleStart, 485); assert.deepEqual(p.actuals, { 0: { start: 485 } });
  // booking.teeOffActual + later events on hole 2 → playing hole 2, hole 0 start anchored
  p = Live.deriveProgress({ id: 'A', teeMin: 480, status: 'onCourse', teeOffActual: 485 }, [ev('A', 1, 'leaveGreen', 497), ev('A', 2, 'teeOff', 499)], holes);
  assert.equal(p.phase, 'playing'); assert.equal(p.holeIdx, 1); assert.deepEqual(p.actuals, { 0: { start: 485, finish: 497 }, 1: { start: 499 } });
});

test('deriveProgress: carries booking.playThrough, respects routing (back nine), does not mutate inputs', () => {
  const pt = { suggestedAt: 500, behindId: 'B' };
  const b = { id: 'A', teeMin: 480, status: 'onCourse', playThrough: pt };
  const events = [ev('A', 10, 'teeOff', 480), ev('A', 1, 'teeOff', 470)];
  const before = snap(b), beforeE = snap(events);
  const back9 = Course.normalizeCourse({ holes: Course.demoLayout(), routings: [{ id: 'b9', holeNos: [10, 11, 12, 13, 14, 15, 16, 17, 18] }] });
  const p = Live.deriveProgress(b, events, Course.holesForRouting(back9, 'b9'));
  assert.deepEqual(p.playThrough, pt);
  assert.equal(p.teeOffActual, 480); assert.equal(p.holeNo, 10); assert.equal(p.holeIdx, 0);   // 洞 1 不在路线上,忽略
  assert.equal(snap(b), before); assert.equal(snap(events), beforeE);
});

// ---------- §5.2 liveOrder ----------
test('liveOrder: §5.2 vector — A teeOff(h)=540 playing, B leaveGreen(h−1)=538 between → [A, B]', () => {
  const h = 4;
  const A = { bookingId: 'A', phase: 'playing', holeIdx: h, currentHoleStart: 540, teeOffActual: 480 };
  const B = { bookingId: 'B', phase: 'between', holeIdx: h, lastLeaveGreen: 538, teeOffActual: 488 };
  assert.deepEqual(Live.liveOrder([B, A]), ['A', 'B']);
  assert.deepEqual(Live.liveOrder([A, B]), ['A', 'B']);
});

test('liveOrder: holeIdx desc, time key asc, teeOffActual, id; not-started/done excluded', () => {
  const list = [
    { bookingId: 'n', phase: 'notStarted', holeIdx: -1 },
    { bookingId: 'd', phase: 'done', holeIdx: H },
    { bookingId: 'p2', phase: 'playing', holeIdx: 3, currentHoleStart: 530, teeOffActual: 488 },
    { bookingId: 'p1', phase: 'playing', holeIdx: 3, currentHoleStart: 525, teeOffActual: 480 },
    { bookingId: 'b2', phase: 'between', holeIdx: 3, lastLeaveGreen: 531, teeOffActual: 500 },
    { bookingId: 'b1', phase: 'between', holeIdx: 3, lastLeaveGreen: 529, teeOffActual: 496 },
    { bookingId: 'lead', phase: 'between', holeIdx: 5, lastLeaveGreen: 560, teeOffActual: 470 },
    { bookingId: 't2', phase: 'playing', holeIdx: 1, currentHoleStart: 540, teeOffActual: 530 },
    { bookingId: 't1', phase: 'playing', holeIdx: 1, currentHoleStart: 540, teeOffActual: 520 },
    { bookingId: 'z', phase: 'playing', holeIdx: 0, currentHoleStart: 545, teeOffActual: 545 },
    { bookingId: 'y', phase: 'playing', holeIdx: 0, currentHoleStart: 545, teeOffActual: 545 }
  ];
  assert.deepEqual(Live.liveOrder(list), ['lead', 'p1', 'p2', 'b1', 'b2', 't1', 't2', 'y', 'z']);
  assert.deepEqual(Live.liveOrder([]), []);
});

test('liveOrder: yield rule — accepted play-through puts the taker first while both are between on the same tee', () => {
  const A = { bookingId: 'A', phase: 'between', holeIdx: 5, lastLeaveGreen: 600, teeOffActual: 480, playThrough: { suggestedAt: 590, decision: 'accepted', decidedAt: 598, behindId: 'B', fromHoleIdx: 5 } };
  const B = { bookingId: 'B', phase: 'between', holeIdx: 5, lastLeaveGreen: 602, teeOffActual: 488 };
  assert.deepEqual(Live.liveOrder([A, B]), ['B', 'A']);
  assert.deepEqual(Live.liveOrder([B, A]), ['B', 'A']);
  // 不同洞序 / 其中一组在打 → 让行规则不生效
  assert.deepEqual(Live.liveOrder([Object.assign({}, A, { phase: 'playing', currentHoleStart: 600 }), B]), ['A', 'B']);
  assert.deepEqual(Live.liveOrder([A, Object.assign({}, B, { holeIdx: 4 })]), ['A', 'B']);
  // 只有 behindId 匹配的那一组受益
  assert.deepEqual(Live.liveOrder([A, Object.assign({}, B, { bookingId: 'C' })]), ['A', 'C']);
  // 未接受(仅建议)不生效
  assert.deepEqual(Live.liveOrder([Object.assign({}, A, { playThrough: { suggestedAt: 590, behindId: 'B' } }), B]), ['A', 'B']);
});

// ---------- §5.3 reference / lag ----------
test('reference standard: anchored at actual tee-off, cumulative std + transit (transit of hole 0 ignored); fieldHoldMin shifts', () => {
  const prog = { phase: 'playing', holeIdx: 0, teeOffActual: 480, currentHoleStart: 480 };
  const ref = Live.reference(prog, holes, cfg, 0, null);
  assert.equal(ref.length, H);
  assert.deepEqual(ref[0], { start: 480, finish: 491 });
  assert.deepEqual(ref[1], { start: 493, finish: 504 });
  assert.deepEqual(ref[2], { start: 506, finish: 513 });
  assert.deepEqual(ref[3], { start: 515, finish: 530 });
  approx(ref[H - 1].finish, 480 + 198 + 34);
  const held = Live.reference(prog, holes, cfg, 5, null);
  assert.deepEqual(held[1], { start: 498, finish: 509 });
});

test('reference plan: planSnapshot rows shifted by (teeOffActual − snapshot.tee) + fieldHoldMin; falls back to standard', () => {
  const planCfg = Course.mergeConfig(cfg, { lagReference: 'plan' });
  const snapRows = Pace.projectSheet(holes, [{ id: 'A', tee: 480, f: 1.1, plan: { fPlan: 1.1 }, size: 4, onCourse: false }]).byId.A;
  const prog = { phase: 'playing', holeIdx: 0, teeOffActual: 483, currentHoleStart: 483 };
  const ref = Live.reference(prog, holes, planCfg, 2, snapRows);
  approx(ref[0].start, 485); approx(ref[0].finish, 485 + 12.1);
  approx(ref[1].start, snapRows.rows[1].start + 5); approx(ref[1].finish, snapRows.rows[1].finish + 5);
  // 无快照 → standard
  const fb = Live.reference(prog, holes, planCfg, 0, null);
  assert.deepEqual(fb[1], { start: 496, finish: 507 });
  // 快照洞数不符 → standard
  const bad = Live.reference(prog, holes, planCfg, 0, { tee: 480, rows: snapRows.rows.slice(0, 9) });
  assert.deepEqual(bad[1], { start: 496, finish: 507 });
});

test('lag: playing = max(currentHoleStart − refStart, now − refFinish); between = max(lastLeaveGreen − refFinish_{h−1}, now − refStart_h); else 0', () => {
  const pA = { phase: 'playing', holeIdx: 1, teeOffActual: 480, currentHoleStart: 497 };
  const refA = Live.reference(pA, holes, cfg, 0, null);
  approx(Live.lag(pA, refA, 520), 16);
  approx(Live.lag(pA, refA, 500), 4);
  approx(Live.lag({ phase: 'playing', holeIdx: 1, teeOffActual: 480, currentHoleStart: 490 }, refA, 500), -3);  // 提前 → 负滞后
  const pB = { phase: 'between', holeIdx: 1, teeOffActual: 488, lastLeaveGreen: 500 };
  const refB = Live.reference(pB, holes, cfg, 0, null);
  approx(Live.lag(pB, refB, 520), 19);
  approx(Live.lag(pB, refB, 501), 1);
  // 全场暂停 5 分:参考表整体后移,滞后减少 5
  approx(Live.lag(pA, Live.reference(pA, holes, cfg, 5, null), 520), 11);
  // plan 参考
  const planCfg = Course.mergeConfig(cfg, { lagReference: 'plan' });
  const snapRows = Pace.projectSheet(holes, [{ id: 'A', tee: 480, f: 1.2, plan: { fPlan: 1.2 }, size: 4, onCourse: false }]).byId.A;
  const refP = Live.reference(pA, holes, planCfg, 0, snapRows);
  approx(Live.lag(pA, refP, 520), Math.max(497 - (480 + 13.2 + 2), 520 - (480 + 13.2 + 2 + 13.2)));
  assert.equal(Live.lag({ phase: 'notStarted', holeIdx: -1 }, refA, 520), 0);
  assert.equal(Live.lag({ phase: 'done', holeIdx: H }, refA, 520), 0);
});

test('openAhead: leader → ∞, ≥2 holes ahead → ∞, same hole → 0, one hole ahead with finish → now − finish − I_pg, missing data → 0', () => {
  const g = { bookingId: 'g', phase: 'playing', holeIdx: 3, teeOffActual: 488, actuals: {} };
  assert.equal(Live.openAhead(g, null, 612, cfg), Infinity);
  assert.equal(Live.openAhead(g, { holeIdx: 5, teeOffActual: 480, actuals: { 3: { finish: 600 } } }, 612, cfg), Infinity);
  assert.equal(Live.openAhead(g, { holeIdx: 3, teeOffActual: 480, actuals: { 3: { finish: 600 } } }, 612, cfg), 0);
  const p = { holeIdx: 4, teeOffActual: 480, actuals: { 3: { start: 590, finish: 600 } } };
  approx(Live.openAhead(g, p, 612, cfg), 4);                                  // I_pg = max(6, 8) = 8
  approx(Live.openAhead(g, p, 605, cfg), 0);                                  // 负值截到 0
  approx(Live.openAhead(Object.assign({}, g, { teeOffActual: 482 }), p, 612, cfg), 6);   // I_pg floor = iMin 6
  assert.equal(Live.openAhead(g, { holeIdx: 4, teeOffActual: 480, actuals: { 3: { start: 590 } } }, 612, cfg), 0);   // 缺 finish
  assert.equal(Live.openAhead(g, { holeIdx: 4, teeOffActual: 480 }, 612, cfg), 0);                                   // 缺 actuals
  // between 组:holeIdx 为下一洞;前组正在打那一洞 → 同洞 → 0
  assert.equal(Live.openAhead({ phase: 'between', holeIdx: 4, teeOffActual: 488 }, p, 612, cfg), 0);
});

test('effLag = min(lag, openAhead) when positionAware, else lag', () => {
  approx(Live.effLag(16, Infinity, cfg), 16);
  approx(Live.effLag(16, 0, cfg), 0);
  approx(Live.effLag(16, 4, cfg), 4);
  approx(Live.effLag(16, 0, Course.mergeConfig(cfg, { positionAware: false })), 16);
});

// ---------- §5.4 FSM ----------
test('nextAlertState: initial level from thresholds (yellowOn 1, redOn 10), since = now', () => {
  assert.deepEqual(Live.nextAlertState(null, 0.5, 100, cfg), { level: 'green', since: 100 });
  assert.deepEqual(Live.nextAlertState(null, 1, 100, cfg), { level: 'yellow', since: 100 });
  assert.deepEqual(Live.nextAlertState(null, 9.99, 100, cfg), { level: 'yellow', since: 100 });
  assert.deepEqual(Live.nextAlertState(null, 10, 100, cfg), { level: 'red', since: 100 });
  assert.deepEqual(Live.nextAlertState(null, -3, 100, cfg), { level: 'green', since: 100 });
});

test('nextAlertState: 9.5 ↔ 10.5 stays red until ≤ redOff 8 (hysteresis)', () => {
  let s = Live.nextAlertState(null, 10.5, 100, cfg);
  assert.equal(s.level, 'red');
  s = Live.nextAlertState(s, 9.5, 102, cfg); assert.equal(s.level, 'red'); assert.equal(s.since, 100);
  s = Live.nextAlertState(s, 10.5, 104, cfg); assert.equal(s.level, 'red'); assert.equal(s.since, 100);
  s = Live.nextAlertState(s, 8.5, 106, cfg); assert.equal(s.level, 'red');
  s = Live.nextAlertState(s, 8, 108, cfg); assert.equal(s.level, 'yellow'); assert.equal(s.since, 108);
});

test('nextAlertState: escalation is immediate — 0.5 → 12 jumps straight to red; yellow → red inside dwell', () => {
  let s = Live.nextAlertState(null, 0.5, 100, cfg);
  s = Live.nextAlertState(s, 12, 100.1, cfg);
  assert.deepEqual(s, { level: 'red', since: 100.1 });
  let y = Live.nextAlertState(null, 3, 200, cfg);
  y = Live.nextAlertState(y, 12, 200.2, cfg);
  assert.deepEqual(y, { level: 'red', since: 200.2 });
});

test('nextAlertState: 12 → 0 needs two dwell periods (red → yellow → green), one level per dwell', () => {
  let s = Live.nextAlertState(null, 12, 100, cfg);
  s = Live.nextAlertState(s, 0, 100.5, cfg); assert.equal(s.level, 'red');          // 驻留未满
  s = Live.nextAlertState(s, 0, 101, cfg); assert.deepEqual(s, { level: 'yellow', since: 101 });
  s = Live.nextAlertState(s, 0, 101.5, cfg); assert.equal(s.level, 'yellow');
  s = Live.nextAlertState(s, 0, 102, cfg); assert.deepEqual(s, { level: 'green', since: 102 });
  // yellowOff 0.5:0.7 不足以回绿
  let y = Live.nextAlertState(null, 2, 300, cfg);
  y = Live.nextAlertState(y, 0.7, 302, cfg); assert.equal(y.level, 'yellow');
  y = Live.nextAlertState(y, 0.5, 302, cfg); assert.equal(y.level, 'green');
});

test('nextAlertState: snooze fields carried through unchanged; prev never mutated', () => {
  const prev = { level: 'red', since: 100, snoozeUntil: 115, snoozedLevel: 'red' };
  const before = snap(prev);
  const s1 = Live.nextAlertState(prev, 11, 102, cfg);
  assert.equal(s1.level, 'red'); assert.equal(s1.snoozeUntil, 115); assert.equal(s1.snoozedLevel, 'red');
  const s2 = Live.nextAlertState(prev, 7, 102, cfg);
  assert.deepEqual(s2, { level: 'yellow', since: 102, snoozeUntil: 115, snoozedLevel: 'red' });
  assert.equal(snap(prev), before);
});

test('cause table and snoozed', () => {
  assert.equal(Live.cause(0.5, 'green', cfg), 'NONE');
  assert.equal(Live.cause(0.5, 'red', cfg), 'NONE');
  assert.equal(Live.cause(5, 'yellow', cfg), 'OWN');
  assert.equal(Live.cause(12, 'red', cfg), 'OWN');
  assert.equal(Live.cause(5, 'green', cfg), 'AHEAD');      // 超时但未告警 = 被前组阻挡
  assert.equal(Live.cause(1, 'green', cfg), 'AHEAD');
  assert.equal(Live.snoozed({ level: 'yellow', since: 100, snoozeUntil: 110, snoozedLevel: 'yellow' }, 105), true);
  assert.equal(Live.snoozed({ level: 'yellow', since: 100, snoozeUntil: 110, snoozedLevel: 'yellow' }, 110), false);
  assert.equal(Live.snoozed({ level: 'red', since: 100, snoozeUntil: 110, snoozedLevel: 'yellow' }, 105), false);   // 升级后重新提醒
  assert.equal(Live.snoozed({ level: 'green', since: 100, snoozeUntil: 110, snoozedLevel: 'red' }, 105), true);
  assert.equal(Live.snoozed({ level: 'red', since: 100 }, 105), false);
  assert.equal(Live.snoozed(null, 105), false);
});

// ---------- §5.5 holdCount / priority / marshalList ----------
test('holdCount: maximal chain of AHEAD followers each within one hole of the previous link', () => {
  const ordered = [
    rec({ bookingId: 'g', holeIdx: 5, cause: 'OWN' }),
    rec({ bookingId: 'q1', holeIdx: 5, cause: 'AHEAD', level: 'green' }),
    rec({ bookingId: 'q2', holeIdx: 4, cause: 'AHEAD', level: 'green' }),
    rec({ bookingId: 'q3', holeIdx: 2, cause: 'AHEAD', level: 'green' }),     // 4 − 1 = 3 > 2 → 链断
    rec({ bookingId: 'q4', holeIdx: 2, cause: 'AHEAD', level: 'green' })
  ];
  assert.equal(Live.holdCount(ordered, 0), 2);
  assert.equal(Live.holdCount(ordered, 1), 1);
  assert.equal(Live.holdCount(ordered, 2), 0);
  assert.equal(Live.holdCount(ordered, 3), 1);
  assert.equal(Live.holdCount(ordered, 4), 0);
  const broken = [rec({ bookingId: 'g', holeIdx: 5 }), rec({ bookingId: 'x', holeIdx: 5, cause: 'OWN', level: 'yellow' }), rec({ bookingId: 'y', holeIdx: 5, cause: 'AHEAD', level: 'green' })];
  assert.equal(Live.holdCount(broken, 0), 0);        // 自身慢的后组不算被阻挡链
  assert.equal(Live.holdCount([], 0), 0);
});

test('priority = rank×1000 + OWN 300 − AHEAD 500 + 10×lag + 20×holdCount', () => {
  approx(Live.priority({ level: 'red', cause: 'OWN', lag: 12, holdCount: 2 }), 2460);
  approx(Live.priority({ level: 'yellow', cause: 'OWN', lag: 3, holdCount: 0 }), 1330);
  approx(Live.priority({ level: 'green', cause: 'AHEAD', lag: 19, holdCount: 0 }), -310);
  approx(Live.priority({ level: 'green', cause: 'NONE', lag: 0, holdCount: 1 }), 20);
});

test('marshalList: members (level != green || holdCount > 0 || AHEAD) sorted by priority desc, snoozed last', () => {
  const groups = [
    rec({ bookingId: 'ok', holeIdx: 9, level: 'green', cause: 'NONE', lag: 0, priority: 0 }),
    rec({ bookingId: 'ahead', holeIdx: 8, level: 'green', cause: 'AHEAD', lag: 5, priority: -450 }),
    rec({ bookingId: 'yel', holeIdx: 7, level: 'yellow', cause: 'OWN', lag: 3, priority: 1330 }),
    rec({ bookingId: 'red', holeIdx: 6, level: 'red', cause: 'OWN', lag: 12, priority: 2420 }),
    rec({ bookingId: 'redSn', holeIdx: 5, level: 'red', cause: 'OWN', lag: 15, priority: 2450, snoozed: true }),
    rec({ bookingId: 'hold', holeIdx: 4, level: 'green', cause: 'NONE', lag: 0.2, holdCount: 1, priority: 22 }),
    rec({ bookingId: 'ns', phase: 'notStarted', holeIdx: -1, level: 'green', cause: 'NONE', lag: 0, priority: 0 })
  ];
  const list = Live.marshalList({ groups });
  assert.deepEqual(list.map(g => g.bookingId), ['red', 'yel', 'hold', 'ahead', 'redSn']);
});

// ---------- §5.6 play-through ----------
test('playThroughGate: positive cases (glued on same hole; one hole back and blocked)', () => {
  const g = rec({ bookingId: 'A', holeIdx: 6, phase: 'playing', behindId: 'B' });
  const glued = rec({ bookingId: 'B', holeIdx: 6, phase: 'between', level: 'green', cause: 'AHEAD', lag: 8 });
  assert.equal(Live.playThroughGate(g, glued, cfg, 600, H), true);
  const back1 = rec({ bookingId: 'B', holeIdx: 5, phase: 'playing', level: 'green', cause: 'AHEAD', lag: 6 });
  assert.equal(Live.playThroughGate(g, back1, cfg, 600, H), true);
  // 后组略慢但在 maxPaceDiff 内
  assert.equal(Live.playThroughGate(g, Object.assign({}, glued, { plan: { fPlan: 1.05 } }), cfg, 600, H), true);
  // 前组 between(下一洞 7):y = 6,剩余 18 − 6 − 1 = 11
  assert.equal(Live.playThroughGate(rec({ bookingId: 'A', holeIdx: 7, phase: 'between', behindId: 'B' }), rec({ bookingId: 'B', holeIdx: 7, phase: 'between', level: 'green', cause: 'AHEAD' }), cfg, 600, H), true);
});

test('playThroughGate: each negative condition', () => {
  const g = rec({ bookingId: 'A', holeIdx: 6, phase: 'playing', behindId: 'B' });
  const glued = rec({ bookingId: 'B', holeIdx: 6, phase: 'between', level: 'green', cause: 'AHEAD', lag: 8 });
  assert.equal(Live.playThroughGate(Object.assign({}, g, { level: 'yellow' }), glued, cfg, 600, H), false);          // 未红
  assert.equal(Live.playThroughGate(Object.assign({}, g, { cause: 'AHEAD', level: 'red' }), glued, cfg, 600, H), false); // 原因是被前组阻挡
  assert.equal(Live.playThroughGate(g, null, cfg, 600, H), false);                                                     // 无后组
  assert.equal(Live.playThroughGate(Object.assign({}, g, { behindId: 'C' }), glued, cfg, 600, H), false);           // 后组不是紧随者
  assert.equal(Live.playThroughGate(Object.assign({}, g, { behindId: null }), glued, cfg, 600, H), false);
  assert.equal(Live.playThroughGate(g, Object.assign({}, glued, { plan: { fPlan: 1.1 } }), cfg, 600, H), false);     // 后组更慢
  assert.equal(Live.playThroughGate(Object.assign({}, g, { holeIdx: 15 }), Object.assign({}, glued, { holeIdx: 15 }), cfg, 600, H), false); // 剩 2 洞 < 3
  assert.equal(Live.playThroughGate(Object.assign({}, g, { holeIdx: 14 }), Object.assign({}, glued, { holeIdx: 14 }), cfg, 600, H), true);  // 剩 3 洞
  assert.equal(Live.playThroughGate(rec({ bookingId: 'A', holeIdx: 16, phase: 'between', behindId: 'B' }), rec({ bookingId: 'B', holeIdx: 16, phase: 'between', level: 'green', cause: 'AHEAD' }), cfg, 600, H), false);
  // 冷却:上次建议(已清除)距今 10 分 < 20
  assert.equal(Live.playThroughGate(Object.assign({}, g, { playThrough: { suggestedAt: 590, behindId: 'C', clearedAt: 595 } }), glued, cfg, 600, H), false);
  assert.equal(Live.playThroughGate(Object.assign({}, g, { playThrough: { suggestedAt: 590, behindId: 'C', clearedAt: 595 } }), glued, cfg, 610, H), true);
  // 对同一后组仍有效的建议 → 继续为真
  assert.equal(Live.playThroughGate(Object.assign({}, g, { playThrough: { suggestedAt: 590, behindId: 'B' } }), glued, cfg, 600, H), true);
  // 已忽略 → 冷却期内不再提示
  assert.equal(Live.playThroughGate(Object.assign({}, g, { playThrough: { suggestedAt: 590, behindId: 'B', decision: 'ignored', decidedAt: 592 } }), glued, cfg, 600, H), false);
  assert.equal(Live.playThroughGate(Object.assign({}, g, { playThrough: { suggestedAt: 590, behindId: 'B', decision: 'ignored', decidedAt: 592 } }), glued, cfg, 611, H), true);
  // 已接受 → 永不再提示
  assert.equal(Live.playThroughGate(Object.assign({}, g, { playThrough: { suggestedAt: 590, behindId: 'B', decision: 'accepted', decidedAt: 592, fromHoleIdx: 7 } }), glued, cfg, 700, H), false);
  // 后组落后两洞(between)→ 否
  assert.equal(Live.playThroughGate(g, rec({ bookingId: 'B', holeIdx: 4, phase: 'between', level: 'green', cause: 'AHEAD' }), cfg, 600, H), false);
  // 后组落后一洞但不是被阻挡(自身慢)→ 否
  assert.equal(Live.playThroughGate(g, rec({ bookingId: 'B', holeIdx: 5, phase: 'playing', level: 'yellow', cause: 'OWN' }), cfg, 600, H), false);
});

test('acceptPlayThrough / ignorePlayThrough: fromHoleIdx = y + 1 (playing vs between), new objects, history kept', () => {
  const b = { id: 'A', teeMin: 480, status: 'onCourse', version: 1, playThrough: { suggestedAt: 590, behindId: 'B' } };
  const before = snap(b);
  const a1 = Live.acceptPlayThrough(b, 'B', 600, { phase: 'playing', holeIdx: 6 });
  assert.deepEqual(a1.playThrough, { suggestedAt: 590, behindId: 'B', decision: 'accepted', decidedAt: 600, fromHoleIdx: 7 });
  assert.equal(a1.id, 'A'); assert.equal(a1.version, 1);
  const a2 = Live.acceptPlayThrough(b, 'B', 600, { phase: 'between', holeIdx: 7 });
  assert.equal(a2.playThrough.fromHoleIdx, 7);
  const a3 = Live.acceptPlayThrough({ id: 'X', teeMin: 480 }, 'Q', 601, { phase: 'playing', holeIdx: 0 });
  assert.deepEqual(a3.playThrough, { decision: 'accepted', decidedAt: 601, behindId: 'Q', fromHoleIdx: 1 });
  const ig = Live.ignorePlayThrough(b, 603);
  assert.deepEqual(ig.playThrough, { suggestedAt: 590, behindId: 'B', decision: 'ignored', decidedAt: 603 });
  assert.equal(snap(b), before);
  assert.notEqual(a1, b); assert.notEqual(ig.playThrough, b.playThrough);
});

// ---------- §5.7 ETA ----------
test('eta: playing — remainingMin from projection, overMin vs std×fPlan, nextTeeEta = next hole start', () => {
  const pg = { id: 'A', tee: 480, f: 1, plan: { fPlan: 1, confident: false }, size: 4, onCourse: true, actuals: { 0: { start: 480, finish: 495 }, 1: { start: 497 } } };
  const prog = { bookingId: 'A', phase: 'playing', holeIdx: 1, holeNo: 2, teeOffActual: 480, currentHoleStart: 497 };
  let proj = Pace.projectSheet(holes, [pg], { now: 520 }).byId.A;
  let e = Live.eta(prog, proj, holes, 1, 520);
  approx(e.remainingMin, 0); approx(e.overMin, 12); approx(e.nextTeeEta, 522); approx(e.etaRoundMin, proj.finish - 520);
  proj = Pace.projectSheet(holes, [pg], { now: 500 }).byId.A;
  e = Live.eta(prog, proj, holes, 1, 500);
  approx(e.remainingMin, 8); approx(e.overMin, 0); approx(e.nextTeeEta, 510);
  // 快组 fPlan 0.9:超时阈值 = 497 + 9.9
  e = Live.eta(prog, Pace.projectSheet(holes, [Object.assign({}, pg, { f: 0.9 })], { now: 510 }).byId.A, holes, 0.9, 510);
  approx(e.overMin, 510 - 497 - 9.9);
  // 最后一洞 → nextTeeEta null
  const last = { id: 'L', tee: 480, f: 1, plan: { fPlan: 1 }, size: 4, onCourse: true, actuals: { 17: { start: 700 } } };
  e = Live.eta({ phase: 'playing', holeIdx: 17, currentHoleStart: 700 }, Pace.projectSheet(holes, [last], { now: 705 }).byId.L, holes, 1, 705);
  approx(e.remainingMin, 6); assert.equal(e.nextTeeEta, null);
});

test('eta: between — remainingMin to projected start of the next hole, overMin 0; notStarted/done', () => {
  const pg = { id: 'B', tee: 488, f: 1, plan: { fPlan: 1, confident: false }, size: 2, onCourse: true, actuals: { 0: { start: 488, finish: 500 } } };
  const prog = { bookingId: 'B', phase: 'between', holeIdx: 1, holeNo: 2, teeOffActual: 488, lastLeaveGreen: 500 };
  let proj = Pace.projectSheet(holes, [pg], { now: 501 }).byId.B;
  let e = Live.eta(prog, proj, holes, 1, 501);
  // remainingMin = rows[h].start − now(h = 正前往的洞);SPEC §5.7 字面:nextTeeEta = rows[h+1].start(对所有阶段同一公式)
  approx(e.remainingMin, 1); approx(e.overMin, 0); approx(proj.rows[1].start, 502); approx(e.nextTeeEta, 515); approx(e.nextTeeEta, proj.rows[2].start);
  proj = Pace.projectSheet(holes, [pg], { now: 505 }).byId.B;
  e = Live.eta(prog, proj, holes, 1, 505);
  approx(e.remainingMin, 0); approx(proj.rows[1].start, 505); approx(e.nextTeeEta, 518); approx(e.nextTeeEta, proj.rows[2].start);
  // between 于最后一洞发球台(holeIdx H−1)→ 没有下一洞
  const lastB = { id: 'LB', tee: 480, f: 1, plan: { fPlan: 1 }, size: 4, onCourse: true, actuals: { 16: { start: 690, finish: 705 } } };
  e = Live.eta({ phase: 'between', holeIdx: 17, lastLeaveGreen: 705 }, Pace.projectSheet(holes, [lastB], { now: 706 }).byId.LB, holes, 1, 706);
  approx(e.remainingMin, 1); assert.equal(e.nextTeeEta, null);
  const ns = Pace.projectSheet(holes, [{ id: 'C', tee: 496, f: 1, plan: { fPlan: 1 }, size: 3, onCourse: false }], { now: 490 }).byId.C;
  e = Live.eta({ phase: 'notStarted', holeIdx: -1 }, ns, holes, 1, 490);
  assert.equal(e.remainingMin, null); approx(e.nextTeeEta, 496); approx(e.etaRoundMin, 496 + 232 - 490);
  e = Live.eta({ phase: 'done', holeIdx: H }, null, holes, 1, 800);
  assert.equal(e.remainingMin, 0); assert.equal(e.nextTeeEta, null);
});

// ---------- §5.8 buildCtx / evaluate ----------
function scenario() {
  const bookings = [
    { id: 'A', date: D, routingId: 'r18', teeMin: 480, size: 4, status: 'onCourse', teeOffActual: 480, caddieIds: ['c17'],
      players: [{ id: 'pa1', name: '张伟', isMember: true }, { id: 'pa2', name: '李娜', isMember: false }], version: 1 },
    { id: 'B', date: D, routingId: 'r18', teeMin: 488, size: 2, status: 'onCourse', teeOffActual: 488, caddieIds: [],
      players: [{ id: 'pb1', name: '王强', isMember: false }, { id: 'pb2', name: '刘洋', isMember: false }], version: 1 },
    { id: 'C', date: D, routingId: 'r18', teeMin: 496, size: 3, status: 'checkedIn', caddieIds: [],
      players: [{ id: 'pc1', name: '陈静', isMember: true }], version: 1 },
    { id: 'D', date: D, routingId: 'r18', teeMin: 470, size: 1, status: 'finished', teeOffActual: 470, caddieIds: [],
      players: [{ id: 'pd1', name: '赵敏', isMember: false }], version: 1 }
  ];
  const events = [
    ev('A', 1, 'teeOff', 480), ev('A', 1, 'leaveGreen', 495), ev('A', 2, 'arriveTee', 497), ev('A', 2, 'teeOff', 497),
    ev('B', 1, 'teeOff', 488), ev('B', 1, 'leaveGreen', 500), ev('B', 2, 'arriveTee', 502),
    ev('D', 1, 'teeOff', 470)
  ];
  const sheet = { courseId: 'demo', date: D, routingId: 'r18', openMin: 390, closeMin: 960, peakMode: false, fieldHoldMin: 0, seq: 0 };
  return { course, sheet, bookings, events, paceStats: {} };
}

test('buildCtx: holes/cfg/eventsByBooking/plansById/planSnapshots/fieldHoldMin', () => {
  const loaded = scenario();
  loaded.bookings[0].planSnapshot = { tee: 480, rows: [] };
  loaded.paceStats = { pb1: { playerId: 'pb1', f: 0.85, v: 0.01, nEff: 4, lastRoundDate: D, roundsScored: 4 }, pb2: { playerId: 'pb2', f: 0.85, v: 0.01, nEff: 4, lastRoundDate: D, roundsScored: 4 } };
  loaded.sheet.fieldHoldMin = 3;
  const ctx = Live.buildCtx(loaded, 520, { A: { level: 'yellow', since: 500 } });
  assert.equal(ctx.holes.length, H); assert.equal(ctx.holes[0].no, 1);
  assert.equal(ctx.cfg, course.config); assert.equal(ctx.now, 520); assert.equal(ctx.fieldHoldMin, 3);
  assert.equal(ctx.bookings, loaded.bookings);
  assert.equal(ctx.eventsByBooking.A.length, 4); assert.equal(ctx.eventsByBooking.B.length, 3); assert.equal(ctx.eventsByBooking.C, undefined);
  approx(ctx.plansById.A.fPlan, 1); assert.equal(ctx.plansById.A.confident, false);
  approx(ctx.plansById.B.fPlan, 1 + (4 / 7) * (0.85 - 1)); assert.equal(ctx.plansById.B.confident, true);
  approx(ctx.plansById.C.fPlan, 1);                       // size 3 with 1 known-less player → unknown majority
  assert.deepEqual(ctx.planSnapshots.A, { tee: 480, rows: [] }); assert.equal(ctx.planSnapshots.B, undefined);
  assert.deepEqual(ctx.prevAlerts, { A: { level: 'yellow', since: 500 } });
  assert.deepEqual(Live.buildCtx(scenario(), 1, undefined).prevAlerts, {});
});

test('evaluate end-to-end: 3-group scenario — order, lag/openAhead/effLag, levels, cause, holdCount, priority, ETA, gate, patches, fieldDelayMin', () => {
  const loaded = scenario();
  const before = snap(loaded);
  const res = Live.evaluate(Live.buildCtx(loaded, 520, {}));
  assert.equal(snap(loaded), before);                                   // 不修改入参

  assert.deepEqual(res.order, ['A', 'B']);
  assert.deepEqual(res.groups.map(g => g.bookingId), ['A', 'B', 'C']);   // D(finished)排除;未开球组在后
  const A = res.byId.A, B = res.byId.B, C = res.byId.C;

  assert.equal(A.phase, 'playing'); assert.equal(A.holeIdx, 1); assert.equal(A.holeNo, 2); approx(A.teeDelay, 0);
  approx(A.lag, 16); assert.equal(A.openAhead, Infinity); approx(A.effLag, 16);
  assert.equal(A.level, 'red'); assert.equal(A.since, 520); assert.equal(A.cause, 'OWN'); assert.equal(A.snoozed, false);
  assert.equal(A.holesAhead, null); assert.equal(A.aheadId, null); assert.equal(A.behindId, 'B');
  assert.equal(A.holdCount, 1); approx(A.priority, 2480);
  approx(A.remainingMin, 0); approx(A.overMin, 12); approx(A.nextTeeEta, 522); approx(A.etaRoundMin, res.projections.byId.A.finish - 520);
  assert.equal(A.playThroughSuggested, true); assert.equal(A.behindWaiting, true);

  assert.equal(B.phase, 'between'); assert.equal(B.holeIdx, 1); assert.equal(B.holeNo, 2); approx(B.teeDelay, 0);
  approx(B.lag, 19); approx(B.openAhead, 0); approx(B.effLag, 0);
  assert.equal(B.level, 'green'); assert.equal(B.cause, 'AHEAD');
  assert.equal(B.holesAhead, 0); assert.equal(B.aheadId, 'A'); assert.equal(B.behindId, null);
  assert.equal(B.holdCount, 0); approx(B.priority, -310);
  approx(B.remainingMin, 0); approx(B.overMin, 0);
  approx(res.projections.byId.B.rows[1].start, 520); approx(B.nextTeeEta, 533); approx(B.nextTeeEta, res.projections.byId.B.rows[2].start);   // §5.7 字面 rows[h+1]
  assert.equal(B.playThroughSuggested, false); assert.equal(B.behindWaiting, false);

  assert.equal(C.phase, 'notStarted'); assert.equal(C.holeIdx, -1); assert.equal(C.holeNo, null);
  assert.equal(C.level, 'green'); assert.equal(C.cause, 'NONE'); assert.equal(C.lag, 0);
  approx(C.nextTeeEta, 496); assert.equal(C.remainingMin, null); assert.equal(C.teeDelay, null);

  assert.deepEqual(Object.keys(res.alerts).sort(), ['A', 'B']);
  assert.deepEqual(res.alerts.A, { level: 'red', since: 520 });
  assert.deepEqual(res.alerts.B, { level: 'green', since: 520 });
  assert.deepEqual(res.patches, { A: { playThrough: { suggestedAt: 520, behindId: 'B' } } });
  approx(res.fieldDelayMin, 17.5);
  // 投影按 liveOrder + 未开球组
  assert.deepEqual(res.projections.list.map(r => r.id), ['A', 'B', 'C']);
  assert.equal(res.projections.byId.D, undefined);
});

test('evaluate: alerts persist across ticks (since kept), active suggestion yields no new patch; accept → gate off; yield rule reorders', () => {
  const loaded = scenario();
  const r1 = Live.evaluate(Live.buildCtx(loaded, 520, {}));
  // 应用 patch 后下一 tick
  loaded.bookings[0] = Object.assign({}, loaded.bookings[0], r1.patches.A);
  const r2 = Live.evaluate(Live.buildCtx(loaded, 521, r1.alerts));
  assert.deepEqual(r2.alerts.A, { level: 'red', since: 520 });
  assert.deepEqual(r2.patches, {});
  assert.equal(r2.byId.A.playThroughSuggested, true);
  // 接受让行:从下一洞(洞序 2)起让 B 先打
  loaded.bookings[0] = Live.acceptPlayThrough(loaded.bookings[0], 'B', 522, r2.byId.A);
  assert.equal(loaded.bookings[0].playThrough.fromHoleIdx, 2);
  const r3 = Live.evaluate(Live.buildCtx(loaded, 523, r2.alerts));
  assert.equal(r3.byId.A.playThroughSuggested, false);
  assert.deepEqual(r3.patches, {});
  // 双方都到了第 3 洞发球台(between, holeIdx 2):接受让行者 A 排在 B 之后
  loaded.events.push(ev('A', 2, 'leaveGreen', 525), ev('B', 2, 'teeOff', 521), ev('B', 2, 'leaveGreen', 530));
  const r4 = Live.evaluate(Live.buildCtx(loaded, 531, r3.alerts));
  assert.equal(r4.byId.A.phase, 'between'); assert.equal(r4.byId.B.phase, 'between');
  assert.deepEqual(r4.order, ['B', 'A']);
  assert.equal(r4.byId.B.aheadId, null); assert.equal(r4.byId.A.aheadId, 'B');
  // 一旦 B 开出第 3 洞,B 在物理上领先
  loaded.events.push(ev('B', 3, 'teeOff', 532));
  const r5 = Live.evaluate(Live.buildCtx(loaded, 533, r4.alerts));
  assert.deepEqual(r5.order, ['B', 'A']);
  assert.equal(r5.byId.B.phase, 'playing'); assert.equal(r5.byId.B.holeIdx, 2);
});

test('evaluate: suggestion cleared (clearedAt) when behind changes or level stays below red for clearAfterMin; ignore → cooldown', () => {
  const loaded = scenario();
  loaded.bookings[0] = Object.assign({}, loaded.bookings[0], { playThrough: { suggestedAt: 515, behindId: 'Z' } });   // Z 已不在后面
  const r = Live.evaluate(Live.buildCtx(loaded, 520, {}));
  // 门仍为真(Z 的建议不活跃、冷却 5 分 < 20?) → 冷却生效,因此不建议;活跃建议针对 Z 被清除
  assert.equal(r.byId.A.playThroughSuggested, false);
  assert.deepEqual(r.patches.A.playThrough, { suggestedAt: 515, behindId: 'Z', clearedAt: 520 });
  // 冷却结束后对 B 重新建议
  const r2 = Live.evaluate(Live.buildCtx(loaded, 536, {}));
  assert.deepEqual(r2.patches.A.playThrough, { suggestedAt: 536, behindId: 'B' });
  // 忽略 → 不再显示,冷却期内也不新建
  loaded.bookings[0] = Live.ignorePlayThrough(Object.assign({}, loaded.bookings[0], r2.patches.A), 537);
  const r3 = Live.evaluate(Live.buildCtx(loaded, 540, r2.alerts));
  assert.equal(r3.byId.A.playThroughSuggested, false); assert.deepEqual(r3.patches, {});
  // 红转黄的滞回:A 级别降到 yellow(prevAlerts 人为注入)但 clearAfterMin 未满 → 仍显示,不清除;满了 → 清除
  const l2 = scenario();
  l2.bookings[0] = Object.assign({}, l2.bookings[0], { playThrough: { suggestedAt: 515, behindId: 'B' } });
  const ctxY = Live.buildCtx(l2, 520, { A: { level: 'red', since: 519 } });
  ctxY.cfg = Course.mergeConfig(ctxY.cfg, { redOn: 50, redOff: 40, dwellMin: 0 });   // 让 A 掉到 yellow
  const ry = Live.evaluate(ctxY);
  assert.equal(ry.byId.A.level, 'yellow'); assert.equal(ry.byId.A.since, 520);
  assert.equal(ry.byId.A.playThroughSuggested, true); assert.deepEqual(ry.patches, {});
  const ctxY2 = Live.buildCtx(l2, 523, ry.alerts);
  ctxY2.cfg = ctxY.cfg;
  const ry2 = Live.evaluate(ctxY2);
  assert.equal(ry2.byId.A.playThroughSuggested, false);
  assert.deepEqual(ry2.patches.A.playThrough, { suggestedAt: 515, behindId: 'B', clearedAt: 523 });
});

test('evaluate: fieldHoldMin shifts references (nobody flagged for a field hold) and planned tees; positionAware off uses raw lag', () => {
  const loaded = scenario();
  loaded.sheet.fieldHoldMin = 20;
  const r = Live.evaluate(Live.buildCtx(loaded, 520, {}));
  approx(r.byId.A.lag, -4); assert.equal(r.byId.A.level, 'green'); assert.equal(r.byId.A.cause, 'NONE');
  approx(r.byId.B.lag, -1);
  approx(r.byId.C.nextTeeEta, 516);                                       // 496 + 20
  assert.deepEqual(r.patches, {});
  approx(r.fieldDelayMin, -2.5);
  const l2 = scenario();
  const ctx = Live.buildCtx(l2, 520, {});
  ctx.cfg = Course.mergeConfig(ctx.cfg, { positionAware: false });
  const r2 = Live.evaluate(ctx);
  approx(r2.byId.B.effLag, 19); assert.equal(r2.byId.B.level, 'red'); assert.equal(r2.byId.B.cause, 'OWN');
});

test('evaluate: empty sheet and all-finished sheet', () => {
  const r = Live.evaluate(Live.buildCtx({ course, sheet: { date: D, routingId: 'r18', fieldHoldMin: 0 }, bookings: [], events: [], paceStats: {} }, 500, {}));
  assert.deepEqual(r.groups, []); assert.deepEqual(r.order, []); assert.equal(r.fieldDelayMin, 0);
  assert.deepEqual(r.alerts, {}); assert.deepEqual(r.patches, {}); assert.deepEqual(r.projections.list, []);
  // §5.8:finished / noShow / cancelled / merged 全部排除(deriveProgress 亦视为 done)
  for (const st of ['finished', 'noShow', 'cancelled', 'merged']) {
    const loaded = scenario();
    loaded.bookings = loaded.bookings.map(b => Object.assign({}, b, { status: st }));
    const r2 = Live.evaluate(Live.buildCtx(loaded, 800, {}));
    assert.deepEqual(r2.groups, [], st); assert.deepEqual(r2.order, [], st); assert.deepEqual(r2.projections.list, [], st);
    assert.deepEqual(r2.alerts, {}, st); assert.deepEqual(r2.patches, {}, st); assert.equal(r2.fieldDelayMin, 0, st);
    const p = Live.deriveProgress(loaded.bookings[0], [ev('A', 1, 'teeOff', 480)], holes);
    assert.equal(p.phase, 'done', st); assert.equal(p.holeIdx, H, st);
  }
});

test('deriveProgress / evaluate / acceptPlayThrough never crash on an empty routing (H = 0); progress omitted → fromHoleIdx 0', () => {
  const b = { id: 'a', status: 'onCourse', teeOffActual: 480, teeMin: 480, players: [], size: 2 };
  const p = Live.deriveProgress(b, [], []);
  assert.equal(p.phase, 'notStarted'); assert.equal(p.holeIdx, -1); assert.equal(p.holeNo, null); assert.equal(p.teeOffActual, 480);
  assert.deepEqual(p.actuals, {});
  const r = Live.evaluate({ holes: [], cfg, now: 500, bookings: [b], eventsByBooking: {}, plansById: {} });
  assert.equal(r.groups.length, 1); assert.equal(r.groups[0].phase, 'notStarted'); assert.equal(r.groups[0].nextTeeEta, null);
  assert.deepEqual(r.order, []); assert.deepEqual(r.alerts, {}); assert.deepEqual(r.patches, {});
  // 路线为空的 course(routing 无洞)→ buildCtx 得到 holes [] → 同样不崩
  const emptyCourse = Object.assign({}, course, { routings: [{ id: 'r0', name: 'empty', holeNos: [] }] });
  const r2 = Live.evaluate(Live.buildCtx({ course: emptyCourse, sheet: { date: D, routingId: 'r0', fieldHoldMin: 0 }, bookings: [b], events: [], paceStats: {} }, 500, {}));
  assert.equal(r2.groups.length, 1); assert.equal(r2.groups[0].phase, 'notStarted');
  // progress 省略:视为未开球 → y = −1 → fromHoleIdx 0(可被 Sim.isTaker 匹配);未开球预订同理
  assert.equal(Live.acceptPlayThrough(b, 'b', 600).playThrough.fromHoleIdx, 0);
  assert.equal(Live.acceptPlayThrough({ id: 'a', status: 'booked', teeMin: 480 }, 'b', 600).playThrough.fromHoleIdx, 0);
  assert.equal(Live.acceptPlayThrough({ id: 'a', status: 'booked', teeMin: 480 }, 'b', 600, { phase: 'notStarted', holeIdx: -1 }).playThrough.fromHoleIdx, 0);
});

test('effLag: cfg without positionAware key (falsy) → raw lag, per §5.3 literal', () => {
  approx(Live.effLag(16, 0, {}), 16);
  approx(Live.effLag(16, 0, { positionAware: true }), 0);
  approx(Live.effLag(16, 0, null), 16);
});

// ---------- §5.9 client views ----------
const FORBIDDEN_KEYS = ['bookingId', 'isMember', 'teeMin', 'lag', 'level', 'cause', 'caddieIds', 'caddie', 'effLag', 'priority', 'id'];
function assertNoForbidden(obj, label) {
  const s = snap(obj);
  FORBIDDEN_KEYS.forEach(k => assert.ok(!s.includes('"' + k + '"'), (label || 'view') + ' leaks key ' + k + ': ' + s));
}

test('clientSnapshot: own group full names, friends by name only, between under NEXT hole, done/notStarted omitted, behind/ahead summaries', () => {
  const loaded = scenario();
  const res = Live.evaluate(Live.buildCtx(loaded, 520, {}));
  const me = { bookingId: 'B', userId: 'pb1', role: 'player' };
  const s = Live.clientSnapshot(res, loaded.bookings, holes, me, new Set(['pa2']), 520);
  assert.equal(s.now, 520);
  assert.equal(s.me.bookingId, 'B'); assert.equal(s.me.holeNo, 2); assert.equal(s.me.phase, 'between');
  approx(s.me.remainingMin, 0); approx(s.me.overMin, 0); assert.equal(s.me.level, 'green'); assert.equal(s.me.cause, 'AHEAD'); approx(s.me.lag, 19);
  assert.equal(s.me.playThroughSuggested, false); assert.equal(s.me.behindWaiting, false);
  assert.deepEqual(s.me.players, [{ name: '王强', isMember: false, isMe: true }, { name: '刘洋', isMember: false, isMe: false }]);
  assert.deepEqual(s.me.caddies, []);
  assert.equal(s.holes.length, H);
  assert.deepEqual(s.holes[0], { no: 1, par: 4, groups: [] });
  assert.deepEqual(s.holes[1].groups, [
    { size: 4, isMine: false, phase: 'playing', friends: [{ name: '李娜' }] },
    { size: 2, isMine: true, phase: 'between', friends: [] }
  ]);
  for (let i = 2; i < H; i++) assert.equal(s.holes[i].groups.length, 0);
  assert.equal(s.behindGroup, undefined);
  assert.deepEqual(s.aheadGroup, { holeNo: 2, phase: 'playing' });

  // A 的球员视角:后组 {size},球童来自目录,让行建议可见
  const sa = Live.clientSnapshot(res, loaded.bookings, holes, { bookingId: 'A', userId: 'pa1', role: 'player' }, new Set(), 520,
    { caddies: [{ id: 'c17', name: '小王', no: '17', status: 'active' }] });
  assert.deepEqual(sa.behindGroup, { size: 2 });
  assert.equal(sa.aheadGroup, undefined);
  assert.deepEqual(sa.me.caddies, [{ no: '17', name: '小王' }]);
  assert.equal(sa.me.playThroughSuggested, true); assert.equal(sa.me.behindWaiting, true); assert.equal(sa.me.level, 'red');
  assert.deepEqual(sa.me.players, [{ name: '张伟', isMember: true, isMe: true }, { name: '李娜', isMember: false, isMe: false }]);
  assert.deepEqual(sa.holes[1].groups[0], { size: 4, isMine: true, phase: 'playing', friends: [] });
  assert.deepEqual(sa.holes[1].groups[1], { size: 2, isMine: false, phase: 'between', friends: [] });
  // 球童视角(非球员 userId)→ isMe 全 false
  const sc = Live.clientSnapshot(res, loaded.bookings, holes, { bookingId: 'A', userId: 'c17', role: 'caddie' }, new Set(), 520);
  assert.deepEqual(sc.me.players.map(p => p.isMe), [false, false]);
});

test('clientSnapshot privacy: no bookingId/name/isMember/teeMin/lag/level/caddie for other groups; friend names only when in friendIds', () => {
  const loaded = scenario();
  const res = Live.evaluate(Live.buildCtx(loaded, 520, {}));
  const me = { bookingId: 'B', userId: 'pb1', role: 'player' };
  const noFriends = Live.clientSnapshot(res, loaded.bookings, holes, me, new Set(), 520);
  const hs = snap(noFriends.holes) + snap(noFriends.behindGroup || null) + snap(noFriends.aheadGroup || null);
  ['张伟', '李娜', '陈静', '赵敏', 'pa1', 'pa2', 'c17', '"A"', '"C"', '"D"', '480', '496'].forEach(x => assert.ok(!hs.includes(x), 'leak: ' + x));
  assertNoForbidden(noFriends.holes, 'holes');
  assert.deepEqual(noFriends.holes[1].groups[0].friends, []);
  // 好友:只有 friendIds 中的名字出现;非好友同组成员仍隐藏
  const withFriend = Live.clientSnapshot(res, loaded.bookings, holes, me, new Set(['pa2']), 520);
  const fs = snap(withFriend.holes);
  assert.ok(fs.includes('李娜')); assert.ok(!fs.includes('张伟'));
  assertNoForbidden(withFriend.holes, 'holes');
  // friendIds 也接受数组
  assert.ok(snap(Live.clientSnapshot(res, loaded.bookings, holes, me, ['pa2'], 520).holes).includes('李娜'));
  // shareOnCourse === false 的好友不显示
  const l2 = scenario();
  l2.bookings[0].players[1] = Object.assign({}, l2.bookings[0].players[1], { shareOnCourse: false });
  assert.ok(!snap(Live.clientSnapshot(Live.evaluate(Live.buildCtx(l2, 520, {})), l2.bookings, holes, me, new Set(['pa2']), 520).holes).includes('李娜'));
  // avatarUrl 随好友透出,其余字段不透出
  const l3 = scenario();
  l3.bookings[0].players[1] = Object.assign({}, l3.bookings[0].players[1], { avatarUrl: 'https://x/a.png', hioId: 'HIO-1' });
  const s3 = Live.clientSnapshot(Live.evaluate(Live.buildCtx(l3, 520, {})), l3.bookings, holes, me, new Set(['pa2']), 520);
  assert.deepEqual(s3.holes[1].groups[0].friends, [{ name: '李娜', avatarUrl: 'https://x/a.png' }]);
  assert.ok(!snap(s3.holes).includes('HIO-1'));
  // 我的组不在场上(未开球)→ me 退化字段,不抛
  const sC = Live.clientSnapshot(res, loaded.bookings, holes, { bookingId: 'C', userId: 'pc1', role: 'player' }, new Set(), 520);
  assert.equal(sC.me.phase, 'notStarted'); approx(sC.me.nextTeeEta, 496); assert.equal(sC.me.holeNo, null);
  assert.deepEqual(sC.me.players, [{ name: '陈静', isMember: true, isMe: true }]);
  const sD = Live.clientSnapshot(res, loaded.bookings, holes, { bookingId: 'D', userId: 'pd1', role: 'player' }, new Set(), 520);
  assert.equal(sD.me.phase, 'done');
});

test('clientProposalView: sides, tee times, other party as size + friend names only; non-party → null', () => {
  const loaded = scenario();
  const p = { id: 'm1', date: D, a: 'B', b: 'C', keep: 'a', targetTeeMin: 488, freedTeeMin: 496, score: 70, status: 'proposed', decisions: {}, createdAt: 400, proposedAt: 410, expiresAt: 368 };
  const vB = Live.clientProposalView(p, loaded.bookings, { bookingId: 'B', userId: 'pb1', role: 'player' }, new Set());
  assert.deepEqual(vB, { id: 'm1', status: 'proposed', myTeeMin: 488, newTeeMin: 488, mySide: 'a', other: { size: 3, friends: [] }, expiresAt: 368 });
  const vC = Live.clientProposalView(p, loaded.bookings, { bookingId: 'C', userId: 'pc1', role: 'player' }, new Set(['pb2']));
  assert.equal(vC.mySide, 'b'); assert.equal(vC.myTeeMin, 496); assert.equal(vC.newTeeMin, 488);
  assert.deepEqual(vC.other, { size: 2, friends: [{ name: '刘洋' }] });
  const os = snap(vC.other);
  ['王强', 'pb1', 'pb2', '"B"', 'isMember', 'teeMin', 'bookingId'].forEach(x => assert.ok(!os.includes(x), 'leak: ' + x));
  assertNoForbidden(vC.other, 'other');
  assert.equal(Live.clientProposalView(p, loaded.bookings, { bookingId: 'A', userId: 'pa1', role: 'player' }, new Set()), null);
  assert.equal(Live.clientProposalView(null, loaded.bookings, { bookingId: 'A' }, new Set()), null);
});
