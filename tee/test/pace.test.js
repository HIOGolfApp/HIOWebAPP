'use strict';
const { test, assert, approx } = require('./_harness.js');
const fs = require('fs');
const path = require('path');
const Course = require('../js/course.js');
const Pace = require('../js/pace.js');

const holes = Course.normalizeCourse({ holes: Course.demoLayout() }).holes;
const cfg = Course.defaultConfig();
const H = holes.length;
const D = '2026-10-06';

// 构造 PGroup(默认 plan {fPlan: f, confident: false})
function G(id, tee, f, confident) {
  return { id, tee, f, plan: { fPlan: f, confident: !!confident }, size: 4, onCourse: false };
}
function snapshot(x) { return JSON.stringify(x); }

// 测试内的确定性随机源(与引擎无关)
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- §2.1 toPGroup / sheetGroups ----------
test('toPGroup: not-started booking uses teeMin + fieldHoldMin, no actuals, carries intervalOverride', () => {
  const b = { id: 'b1', teeMin: 480, size: 3, status: 'booked', intervalOverride: 9 };
  const plan = { f: 0.9, fPlan: 0.95, confident: true };
  const g = Pace.toPGroup(b, plan, { fieldHoldMin: 5, progress: { phase: 'notStarted' } });
  assert.equal(g.id, 'b1'); assert.equal(g.tee, 485); assert.equal(g.f, 0.95);
  assert.deepEqual(g.plan, { fPlan: 0.95, confident: true });
  assert.equal(g.size, 3); assert.equal(g.onCourse, false); assert.equal(g.actuals, undefined);
  assert.equal(g.intervalOverride, 9);
  const g2 = Pace.toPGroup({ id: 'b2', teeMin: 480, size: 4 }, null, {});
  assert.equal(g2.tee, 480); assert.equal(g2.f, 1); assert.deepEqual(g2.plan, { fPlan: 1, confident: false });
  assert.ok(!('intervalOverride' in g2));
});

test('toPGroup: started booking uses teeOffActual and progress.actuals; done is not started', () => {
  const b = { id: 'b1', teeMin: 480, size: 4, status: 'onCourse' };
  const prog = { phase: 'playing', teeOffActual: 483, actuals: { 0: { start: 483, finish: 494 }, 1: { start: 496 } } };
  const g = Pace.toPGroup(b, { fPlan: 1.1, confident: false }, { fieldHoldMin: 10, progress: prog });
  assert.equal(g.tee, 483); assert.equal(g.onCourse, true); assert.deepEqual(g.actuals, prog.actuals);
  const done = Pace.toPGroup(b, { fPlan: 1 }, { progress: { phase: 'done', teeOffActual: 483, actuals: {} } });
  assert.equal(done.onCourse, false); assert.equal(done.tee, 480);
});

test('sheetGroups: filters statuses, on-course first (opts.order), then not-started by (tee, id)', () => {
  const bookings = [
    { id: 'z', teeMin: 500, size: 4, status: 'booked' },
    { id: 'a', teeMin: 500, size: 2, status: 'checkedIn' },
    { id: 'c', teeMin: 480, size: 4, status: 'onCourse' },
    { id: 'd', teeMin: 488, size: 4, status: 'onCourse' },
    { id: 'x', teeMin: 470, size: 4, status: 'cancelled' },
    { id: 'y', teeMin: 460, size: 4, status: 'finished' },
    { id: 'n', teeMin: 465, size: 4, status: 'noShow' },
    { id: 'm', teeMin: 466, size: 4, status: 'merged' }
  ];
  const progressById = {
    c: { phase: 'playing', teeOffActual: 481, actuals: { 0: { start: 481 } } },
    d: { phase: 'between', teeOffActual: 489, actuals: { 0: { start: 489, finish: 500 } } }
  };
  const plans = { a: { fPlan: 0.9, confident: false } };
  const gs = Pace.sheetGroups(bookings, plans, { fieldHoldMin: 3, progressById, order: ['d', 'c'] });
  assert.deepEqual(gs.map(g => g.id), ['d', 'c', 'a', 'z']);
  assert.equal(gs[0].onCourse, true); assert.equal(gs[0].tee, 489);
  assert.equal(gs[2].tee, 503); assert.equal(gs[2].f, 0.9); assert.equal(gs[3].f, 1);
  // 无 order → 场上组按 (tee, id)
  const gs2 = Pace.sheetGroups(bookings, plans, { progressById });
  assert.deepEqual(gs2.map(g => g.id), ['c', 'd', 'a', 'z']);
  assert.equal(gs2[2].tee, 500);
  // order 中缺失的场上组补在后面
  const gs3 = Pace.sheetGroups(bookings, plans, { progressById, order: ['d'] });
  assert.deepEqual(gs3.map(g => g.id), ['d', 'c', 'a', 'z']);
});

// ---------- §2.2 / §2.6 投影向量 ----------
test('(a) f=1.0 at 8-min spacing: roundMin 232 (198 play + 34 transit), waitMin 0, rows well-formed', () => {
  const P = Pace.projectSheet(holes, [G('A', 480, 1), G('B', 488, 1), G('C', 496, 1), G('D', 504, 1)]);
  assert.equal(P.list.length, 4);
  for (const r of P.list) {
    approx(r.roundMin, 232); approx(r.waitMin, 0);
    assert.equal(r.rows.length, H);
    approx(r.finish, r.rows[H - 1].finish);
    assert.deepEqual(Object.keys(r.rows[0]).sort(), ['arr', 'finish', 'holeNo', 'play', 'start', 'waitGreen', 'waitTee']);
    assert.equal(r.rows[2].holeNo, 3);
    approx(r.rows[2].play, 7);
  }
  assert.equal(P.byId.C.tee, 496);
  approx(P.byId.A.rows[0].start, 480); approx(P.byId.A.rows[0].finish, 491); approx(P.byId.A.rows[1].arr, 493);
});

test('(b) f=1.0 at 6-min spacing: B waits 1.0 at hole 3 only, C 2.0, D 3.0', () => {
  const P = Pace.projectSheet(holes, [G('A', 480, 1), G('B', 486, 1), G('C', 492, 1), G('D', 498, 1)]);
  approx(P.byId.A.waitMin, 0);
  const expect = { B: 1, C: 2, D: 3 };
  for (const id in expect) {
    const r = P.byId[id];
    approx(r.waitMin, expect[id], 1e-9, id);
    approx(r.rows[2].waitTee, expect[id], 1e-9, id + ' hole 3');
    for (let i = 0; i < H; i++) if (i !== 2) { approx(r.rows[i].waitTee, 0, 1e-9, id + ' h' + (i + 1)); approx(r.rows[i].waitGreen, 0, 1e-9); }
  }
  // 之后全场间隔 7:第 4 洞起 B 比 A 晚 7 分
  for (let i = 3; i < H; i++) approx(P.byId.B.rows[i].start - P.byId.A.rows[i].start, 7, 1e-9);
});

test('(c) f=0.85 at 6-min spacing: no waits, roundMin 202.3', () => {
  const P = Pace.projectSheet(holes, [G('A', 480, 0.85), G('B', 486, 0.85), G('C', 492, 0.85), G('D', 498, 0.85)]);
  for (const r of P.list) { approx(r.waitMin, 0, 1e-9); approx(r.roundMin, 202.3, 1e-9); }
});

test('(d) A f1.0 @480, B f0.85 @488: B waitTee pattern, total 26.05, finish 716.35', () => {
  const P = Pace.projectSheet(holes, [G('A', 480, 1), G('B', 488, 0.85)]);
  const B = P.byId.B;
  const w = B.rows.map(r => r.waitTee);
  approx(w[0], 0, 1e-9); approx(w[1], 0, 1e-9);
  approx(w[2], 2.30, 1e-6); approx(w[3], 0.05, 1e-6); approx(w[4], 2.25, 1e-6); approx(w[5], 1.65, 1e-6);
  approx(w[6], 2.65, 1e-6); approx(w[7], 0.05, 1e-6); approx(w[8], 2.25, 1e-6);
  approx(B.waitMin, 26.05, 0.1); approx(B.finish, 716.35, 0.1);
  approx(P.byId.A.waitMin, 0);
  for (const r of B.rows) approx(r.waitGreen, 0, 1e-9);
});

test('(f) A {f:1.4, confident} @480, B f0.75 @488: B.waitMin ≈ 121.7; iRec(A) 10 capped (uncapped 11)', () => {
  const A = G('A', 480, 1.4, true);
  const P = Pace.projectSheet(holes, [A, G('B', 488, 0.75)]);
  approx(P.byId.B.waitMin, 121.7, 0.1);
  const r = Pace.iRec(A, cfg);
  assert.equal(r.interval, 10); assert.equal(r.capped, true); assert.equal(r.uncapped, 11); assert.equal(r.slow, true);
  assert.equal(r.override, false); assert.equal(r.floored, false); approx(r.raw, 11.2);
});

test('Markov: groups ahead are never affected by groups behind; empty sheet ok', () => {
  const A = G('A', 480, 1.0);
  const one = Pace.projectSheet(holes, [A]).byId.A;
  const two = Pace.projectSheet(holes, [A, G('B', 481, 0.75)]).byId.A;
  assert.equal(snapshot(one), snapshot(two));
  const e = Pace.projectSheet(holes, []);
  assert.deepEqual(e, { byId: {}, list: [] });
});

test('projectSheet consumes groups in array order (never sorts) and does not mutate inputs', () => {
  const B = G('B', 488, 1), A = G('A', 480, 1);
  const before = snapshot([B, A]);
  const P = Pace.projectSheet(holes, [B, A]);
  assert.deepEqual(P.list.map(r => r.id), ['B', 'A']);
  // A 被当作 B 的后组:第 1 洞必须等到 B.start + minGap
  approx(P.byId.A.rows[0].start, 494);
  assert.equal(snapshot([B, A]), before);
});

test('clear constraint uses p\'s projected hole duration (finish pushed by minFollow), not std × f', () => {
  // 自定义洞:std 30、clearFrac 0.45。X 慢(1.4) → Y 快(0.75)的 finish 被 minFollow 推后 → Z 的开球受 Y 实际占用时长约束
  const mini = Course.normalizeCourse({ holes: [{ no: 1, par: 4, std: 30, clearFrac: 0.45 }, { no: 2, par: 4 }] }).holes;
  const P = Pace.projectSheet(mini, [G('X', 0, 1.4), G('Y', 10, 0.75), G('Z', 20, 0.75)]);
  const y = P.byId.Y.rows[0], z = P.byId.Z.rows[0];
  approx(y.start, 18.9); approx(y.finish, 43);                      // X.finish 42 + minFollow 1
  assert.ok(y.waitGreen > 1, 'Y waitGreen=' + y.waitGreen);
  const boundProjected = y.start + 0.45 * (y.finish - y.start);     // 29.745
  const boundStd = y.start + 0.45 * y.play;                          // 29.025
  approx(boundProjected, 29.745); approx(boundStd, 29.025);
  approx(z.start, boundProjected);
  assert.ok(z.start > boundStd + 0.5);
  approx(z.waitTee, 9.745);
});

// ---------- §2.2 实况锚定 ----------
test('live anchoring (1)+(3): actual start overrides p-constraint; playing hole finish ≥ now', () => {
  const slowP = G('P', 480, 1.4); slowP.onCourse = true; slowP.actuals = { 0: { start: 480 } };
  const g = { id: 'G', tee: 482, f: 1, plan: { fPlan: 1, confident: false }, size: 4, onCourse: true,
    actuals: { 0: { start: 482, finish: 493 }, 1: { start: 495 } } };
  const P = Pace.projectSheet(holes, [slowP, g], { now: 530 });
  const r = P.byId.G.rows;
  approx(r[0].start, 482); approx(r[0].finish, 493); approx(r[0].waitTee, 0); approx(r[0].arr, 482);
  approx(r[1].start, 495);                       // p 的约束(480+6 → 486 … 实际上 P 第 2 洞更晚)不施加在实况开球上
  assert.ok(r[1].finish >= 530 - 1e-9, 'finish ' + r[1].finish + ' ≥ now');
  approx(r[1].finish, Math.max(530, P.byId.P.rows[1].finish + 1));
  approx(r[1].waitGreen, r[1].finish - (495 + 11));
  // 之后的洞由 finish 递推,不再被 now 钳制
  approx(r[2].arr, r[1].finish + 2);
  // 无 now:正在打的洞 finish = max(start+play, p 约束)
  const P2 = Pace.projectSheet(holes, [g]);
  approx(P2.byId.G.rows[1].finish, 506);
  // 规则 (1) 第二句:arr_i = min(arr_i, start_i) —— 实际开球早于递推到达(493 + 2 = 495 > 490)
  const early = { id: 'G', tee: 482, f: 1, plan: { fPlan: 1 }, size: 4, onCourse: true, actuals: { 0: { start: 482, finish: 493 }, 1: { start: 490 } } };
  const re = Pace.projectSheet(holes, [early]).byId.G.rows[1];
  approx(re.arr, 490); approx(re.start, 490); approx(re.waitTee, 0);
});

test('live anchoring (2): finish-only hole with actual finish EARLIER than the projected arrival → start = finish, no negative duration (pinned)', () => {
  // 第 0 洞实际 480→491,第 1 洞只有离岭 492:递推 arr_1 = 491 + 2 = 493 > finish 492
  const g = { id: 'G', tee: 480, f: 1, plan: { fPlan: 1 }, size: 4, onCourse: true, actuals: { 0: { start: 480, finish: 491 }, 1: { finish: 492 } } };
  const r = Pace.projectSheet(holes, [g]).byId.G.rows;
  approx(r[1].arr, 493); approx(r[1].finish, 492);
  approx(r[1].start, 492);                        // min(max(finish − play, arr), finish):start 不晚于 finish
  approx(r[1].waitGreen, 0); approx(r[1].waitTee, 0);
  assert.ok(r[1].finish >= r[1].start - 1e-9);
  approx(r[2].arr, 494);
});

test('live anchoring (4): a between group\'s next start ≥ now; finish-only hole derives start; a not-started group is never clamped', () => {
  const between = { id: 'B', tee: 480, f: 1, plan: { fPlan: 1, confident: false }, size: 4, onCourse: true, actuals: { 0: { start: 480, finish: 491 } } };
  const P = Pace.projectSheet(holes, [between], { now: 500 });
  approx(P.byId.B.rows[1].arr, 500); approx(P.byId.B.rows[1].start, 500); approx(P.byId.B.rows[1].waitTee, 0);
  approx(P.byId.B.rows[2].arr, 500 + 11 + 2);    // 只有第一个 i > m 的洞被钳制
  // 未开球组:tee 在过去也不钳制
  const ns = G('N', 480, 1);
  approx(Pace.projectSheet(holes, [ns], { now: 500 }).byId.N.rows[0].start, 480);
  // 场上但无任何实况(m = −1):第 1 洞 ≥ now
  const oc = G('O', 480, 1); oc.onCourse = true; oc.actuals = {};
  approx(Pace.projectSheet(holes, [oc], { now: 500 }).byId.O.rows[0].start, 500);
  // 只有离岭实况:start = clamp(finish − play, arr, finish),waitGreen 0
  const fo = { id: 'F', tee: 480, f: 1, plan: { fPlan: 1 }, size: 4, onCourse: true, actuals: { 0: { finish: 495 } } };
  const rf = Pace.projectSheet(holes, [fo], { now: 497 }).byId.F.rows;
  approx(rf[0].start, 484); approx(rf[0].finish, 495); approx(rf[0].waitGreen, 0); approx(rf[0].waitTee, 4);
  approx(rf[1].arr, 497);
  // finish 实况早于 arr:start 被钳到 arr(不超过 finish 的情形)
  const fo2 = { id: 'F2', tee: 480, f: 1, plan: { fPlan: 1 }, size: 4, onCourse: true, actuals: { 0: { finish: 486 } } };
  approx(Pace.projectSheet(holes, [fo2]).byId.F2.rows[0].start, 480);
});

// ---------- §2.3 iRec ----------
test('iRec pinned table (not confident / confident)', () => {
  const tab = [
    [0.75, 6, 6], [0.80, 6, 6], [0.85, 7, 7], [0.90, 7, 7], [0.95, 8, 8], [1.00, 8, 8],
    [1.10, 8, 9], [1.25, 8, 10], [1.40, 8, 10]
  ];
  for (const [f, nc, c] of tab) {
    assert.equal(Pace.iRec({ plan: { fPlan: f, confident: false } }, cfg).interval, nc, 'nc ' + f);
    assert.equal(Pace.iRec({ plan: { fPlan: f, confident: true } }, cfg).interval, c, 'c ' + f);
  }
  const r110 = Pace.iRec({ plan: { fPlan: 1.1, confident: false } }, cfg);
  assert.equal(r110.capped, true); assert.equal(r110.uncapped, 9); assert.equal(r110.slow, true); approx(r110.raw, 8.8);
  const r110c = Pace.iRec({ plan: { fPlan: 1.1, confident: true } }, cfg);
  assert.equal(r110c.interval, 9); assert.equal(r110c.capped, false);
  const r125 = Pace.iRec({ plan: { fPlan: 1.25, confident: true } }, cfg);
  assert.equal(r125.interval, 10); assert.equal(r125.capped, false);
  const r140 = Pace.iRec({ plan: { fPlan: 1.4, confident: true } }, cfg);
  assert.equal(r140.interval, 10); assert.equal(r140.capped, true); assert.equal(r140.uncapped, 11);
  const r075 = Pace.iRec({ plan: { fPlan: 0.75, confident: false } }, cfg);
  assert.equal(r075.floored, false); assert.equal(r075.uncapped, 6); assert.equal(r075.slow, false);
  // 低于 iMin 时 floored
  const low = Pace.iRec({ plan: { fPlan: 0.6 } }, cfg);
  assert.equal(low.interval, 6); assert.equal(low.floored, true); assert.equal(low.uncapped, 5);
  // 只有 f 的 PGroup → plan 由 f 推出,不置信
  assert.equal(Pace.iRec({ f: 1.2 }, cfg).interval, 8);
  assert.equal(Pace.iRec({}, cfg).interval, 8);
});

test('iRec intervalOverride wins', () => {
  const r = Pace.iRec({ plan: { fPlan: 1.4, confident: true }, intervalOverride: 9 }, cfg);
  assert.deepEqual(r, { interval: 9, raw: 9, capped: false, floored: false, slow: false, uncapped: 9, override: true });
  assert.equal(Pace.iRec({ plan: { fPlan: 1 }, intervalOverride: 0 }, cfg).override, false);
});

test('iRec invariant sweep: when !capped, interval ≥ B(fPlan) (and ≥ B + 0.25 when interval ≥ 7)', () => {
  let checked = 0;
  for (const confident of [false, true]) {
    for (let i = 75; i <= 140; i++) {
      const f = i / 100;
      const r = Pace.iRec({ plan: { fPlan: f, confident } }, cfg);
      const B = Course.bottleneck(holes, f);
      assert.ok(r.interval >= cfg.iMin && r.interval <= cfg.iHardMax);
      assert.equal(r.interval, Math.round(r.interval));
      if (!r.capped) {
        checked++;
        assert.ok(r.interval >= B - Course.EPS, `f=${f} conf=${confident} I=${r.interval} B=${B}`);
        if (r.interval >= 7) assert.ok(r.interval >= B + 0.25, `f=${f} conf=${confident} I=${r.interval} B=${B}`);
      }
    }
  }
  assert.ok(checked > 60);
});

// ---------- §2.4 playerPlan / groupPlan ----------
// A 的 EMA:0.80 → 0.825 → 0.81667(α = 1, 1/2, 1/3):f = 0.825 × (2/3) + 0.80 × (1/3)
const statsA = { playerId: 'A', f: 0.825 * (2 / 3) + 0.80 * (1 / 3), nEff: 3, lastRoundDate: D, roundsScored: 3 };
const statsS = { playerId: 'S', f: 1.275, nEff: 2, lastRoundDate: D, roundsScored: 2 };

test('playerPlan: unknown for null / nEff 0; A → fPlan 0.908333 (w = 0.5); S → 1.18333 (w = 2/3)', () => {
  assert.deepEqual(Pace.playerPlan(null, cfg, D), { f: 1, fPlan: 1, nEff: 0, roundsScored: 0, known: false });
  assert.deepEqual(Pace.playerPlan({ f: 0.8, nEff: 0 }, cfg, D), { f: 1, fPlan: 1, nEff: 0, roundsScored: 0, known: false });
  approx(statsA.f, 0.81667, 1e-4);
  const a = Pace.playerPlan(statsA, cfg, D);
  approx(a.f, 0.81667, 1e-4); approx(a.fPlan, 0.908333, 1e-5); approx(a.nEff, 3); assert.equal(a.roundsScored, 3); assert.equal(a.known, true);
  const s = Pace.playerPlan(statsS, cfg, D);
  approx(s.fPlan, 1.18333, 1e-5); approx(s.nEff, 2); assert.equal(s.known, true);
  // 不改输入
  assert.equal(statsA.nEff, 3);
});

test('playerPlan with todayDate = D + 1: nEff decays to ≈ 2.988; roundsScored stays integer', () => {
  const a = Pace.playerPlan(statsA, cfg, '2026-10-07');
  approx(a.nEff, 2.988, 0.02);
  assert.equal(a.roundsScored, 3);
  assert.ok(a.fPlan > 0.908333 && a.fPlan < 0.91);
});

test('groupPlan: four A-like → fPlan 0.908333, iRec 7, confident', () => {
  const players = [{ id: 'a1' }, { id: 'a2' }, { id: 'a3' }, { id: 'a4' }];
  const stats = { a1: statsA, a2: statsA, a3: statsA, a4: statsA };
  const gp = Pace.groupPlan(players, stats, cfg, D);
  approx(gp.fPlan, 0.908333, 1e-5); approx(gp.f, 0.81667, 1e-4);
  assert.equal(gp.confident, true); assert.equal(gp.unknown, 0); assert.equal(gp.size, 4);
  const r = Pace.iRec({ plan: gp }, cfg);
  assert.equal(r.interval, 7); approx(r.raw, 7.267, 1e-3);
  // D + 1:置信不变
  assert.equal(Pace.groupPlan(players, stats, cfg, '2026-10-07').confident, true);
});

test('groupPlan: three A-like + one unknown guest → fPlan 0.9725, iRec 8, not confident', () => {
  const players = [{ id: 'a1' }, { id: 'a2' }, { id: 'a3' }];
  const stats = { a1: statsA, a2: statsA, a3: statsA };
  const gp = Pace.groupPlan(players, stats, cfg, D, 4);
  approx(gp.fPlan, 0.9725, 1e-5);
  assert.equal(gp.confident, false); assert.equal(gp.unknown, 1); assert.equal(gp.size, 4);
  const r = Pace.iRec({ plan: gp }, cfg);
  assert.equal(r.interval, 8); approx(r.raw, 7.78, 1e-3);
});

test('groupPlan: slow player S → fPlan 1.18333, iRec {8, capped, slow, uncapped 9}; confident with 3 rounds → 9', () => {
  const gp = Pace.groupPlan([{ id: 's' }], { s: statsS }, cfg, D);
  approx(gp.fPlan, 1.18333, 1e-5); approx(gp.f, 1.275, 1e-9); assert.equal(gp.confident, false);
  const r = Pace.iRec({ plan: gp }, cfg);
  assert.equal(r.interval, 8); assert.equal(r.capped, true); assert.equal(r.slow, true); assert.equal(r.uncapped, 9);
  const gp3 = Pace.groupPlan([{ id: 's' }], { s: Object.assign({}, statsS, { roundsScored: 3 }) }, cfg, D);
  assert.equal(gp3.confident, true);
  assert.equal(Pace.iRec({ plan: gp3 }, cfg).interval, 9);
});

test('groupPlan cold start: sizes 1–4 all unknown → fPlan 1.0 → iRec 8; empty players → one unknown', () => {
  for (let size = 1; size <= 4; size++) {
    const gp = Pace.groupPlan([], {}, cfg, D, size);
    approx(gp.fPlan, 1); approx(gp.f, 1); assert.equal(gp.confident, false); assert.equal(gp.unknown, size); assert.equal(gp.size, size);
    assert.equal(Pace.iRec({ plan: gp }, cfg).interval, 8);
    const gp2 = Pace.groupPlan(Array.from({ length: size }, (_, i) => ({ id: 'u' + i })), {}, cfg, D);
    approx(gp2.fPlan, 1); assert.equal(Pace.iRec({ plan: gp2 }, cfg).interval, 8);
  }
  const e = Pace.groupPlan([], {}, cfg, D);
  assert.equal(e.size, 1); assert.equal(e.unknown, 1); approx(e.fPlan, 1);
});

test('groupPlan majority-unknown rule: never faster than standard; minority unknown may be faster', () => {
  // 1 快 + 1 未知:2 ≥ 2 → fPlan 钳到 1
  const half = Pace.groupPlan([{ id: 'a1' }], { a1: statsA }, cfg, D, 2);
  approx(half.fPlan, 1); assert.equal(half.unknown, 1); approx(half.f, 0.6 * 1 + 0.4 * (1 + statsA.f) / 2, 1e-9);
  // 2 快 + 2 未知:4 ≥ 4 → 1
  approx(Pace.groupPlan([{ id: 'a1' }, { id: 'a2' }], { a1: statsA, a2: statsA }, cfg, D, 4).fPlan, 1);
  // 3 快 + 1 未知:2 < 4 → 0.9725(见上)
  assert.ok(Pace.groupPlan([{ id: 'a1' }, { id: 'a2' }, { id: 'a3' }], { a1: statsA, a2: statsA, a3: statsA }, cfg, D, 4).fPlan < 1);
  // 慢组不受此规则影响:1 慢 + 1 未知 → λ·max + (1−λ)·mean > 1
  const slowHalf = Pace.groupPlan([{ id: 's' }], { s: statsS }, cfg, D, 2);
  approx(slowHalf.fPlan, 0.6 * 1.18333333 + 0.4 * (1.18333333 + 1) / 2, 1e-6);
});

test('groupPlan: sizeMult scales, fMin/fMax clamp, players without stats count as unknown', () => {
  const c2 = Course.mergeConfig(cfg, { sizeMult: { 4: 1.2 } });
  const gp = Pace.groupPlan([{ id: 's' }, { id: 's2' }, { id: 's3' }, { id: 's4' }], { s: statsS, s2: statsS, s3: statsS, s4: statsS }, c2, D);
  approx(gp.fPlan, Math.min(1.4, 1.18333333 * 1.2), 1e-6);
  approx(gp.f, 1.4);                    // 1.275 × 1.2 = 1.53 → clamp fMax
  const mixed = Pace.groupPlan([{ id: 's' }, { id: 'nobody' }], { s: statsS }, cfg, D);
  assert.equal(mixed.unknown, 1); assert.equal(mixed.size, 2);
});

// ---------- §2.5 checkInsert ----------
const sheetE = [G('A', 480, 1), G('B', 488, 0.85), G('C', 496, 1), G('D', 504, 1.2)];
const sheetE2 = [G('A', 480, 1), G('B', 488, 0.85), G('C', 504, 1), G('D', 512, 1.2)];

test('insertCand: on-course groups stay in front; cand placed by (tee, id) among not-started', () => {
  const oc = G('O', 470, 1); oc.onCourse = true;
  const sheet = [oc, G('A', 480, 1), G('C', 496, 1)];
  const cand = G('X', 480, 1);
  const m = Pace.insertCand(sheet, cand);
  assert.deepEqual(m.map(g => g.id), ['O', 'A', 'X', 'C']);     // 'A' < 'X' 同 tee → 在 A 之后
  assert.deepEqual(Pace.insertCand(sheet, G('0', 480, 1)).map(g => g.id), ['O', '0', 'A', 'C']);
  assert.deepEqual(Pace.insertCand(sheet, G('Z', 400, 1)).map(g => g.id), ['O', 'Z', 'A', 'C']);  // 场上组仍在前
  assert.deepEqual(Pace.insertCand(sheet, G('Z', 600, 1)).map(g => g.id), ['O', 'A', 'C', 'Z']);
  assert.deepEqual(Pace.insertCand([], cand).map(g => g.id), ['X']);
  assert.equal(sheet.length, 3);
});

test('(e) GAP_AHEAD at 490 and 492 (need 7 = iRec(B) with fPlan 0.85)', () => {
  const r1 = Pace.checkInsert(holes, cfg, sheetE, G('E', 490, 1));
  assert.equal(r1.ok, false); assert.equal(r1.reason, 'GAP_AHEAD'); assert.equal(r1.need, 7);
  assert.deepEqual(r1.warnings, []); assert.equal(r1.prevId, 'B'); assert.equal(r1.nextId, 'C');
  const r2 = Pace.checkInsert(holes, cfg, sheetE, G('E', 492, 1));
  assert.equal(r2.ok, false); assert.equal(r2.reason, 'GAP_AHEAD'); assert.equal(r2.need, 7);
});

test('(e) C→504, D→512: E f1 @496 ok, candWait 0, C and D unchanged', () => {
  const r = Pace.checkInsert(holes, cfg, sheetE2, G('E', 496, 1));
  assert.equal(r.ok, true); assert.equal(r.reason, undefined);
  approx(r.candWait, 0); approx(r.candRound, 232); assert.deepEqual(r.warnings, []);
  assert.equal(r.projection.id, 'E'); assert.equal(r.projection.rows.length, H);
  const base = Pace.projectSheet(holes, sheetE2).byId;
  const after = Pace.projectSheet(holes, Pace.insertCand(sheetE2, G('E', 496, 1))).byId;
  assert.equal(snapshot(base.C), snapshot(after.C)); assert.equal(snapshot(base.D), snapshot(after.D));
});

test('(e) E f1.2 (not confident) @496 → IMPACTS_BEHIND victim C, shiftMin ≈ 35.4', () => {
  const r = Pace.checkInsert(holes, cfg, sheetE2, G('E', 496, 1.2));
  assert.equal(r.ok, false); assert.equal(r.reason, 'IMPACTS_BEHIND'); assert.equal(r.victimId, 'C');
  assert.ok(r.shiftMin > 30, 'shiftMin ' + r.shiftMin); approx(r.shiftMin, 35.4, 0.1);
  assert.ok(r.projection && r.projection.id === 'E');
});

test('(e) E f1.2 confident @496 → GAP_BEHIND need 10', () => {
  const r = Pace.checkInsert(holes, cfg, sheetE2, G('E', 496, 1.2, true));
  assert.equal(r.ok, false); assert.equal(r.reason, 'GAP_BEHIND'); assert.equal(r.need, 10);
});

test('checkInsert: OUTSIDE_HOURS, empty sheet, CAND_WAITS warning, no input mutation', () => {
  assert.equal(Pace.checkInsert(holes, cfg, sheetE2, G('E', 380, 1), { openMin: 390, closeMin: 960 }).reason, 'OUTSIDE_HOURS');
  assert.equal(Pace.checkInsert(holes, cfg, sheetE2, G('E', 961, 1), { openMin: 390, closeMin: 960 }).reason, 'OUTSIDE_HOURS');
  assert.equal(Pace.checkInsert(holes, cfg, sheetE2, G('E', 390, 1), { openMin: 390, closeMin: 960 }).reason, undefined);
  const e = Pace.checkInsert(holes, cfg, [], G('E', 480, 1));
  assert.equal(e.ok, true); approx(e.candWait, 0); assert.equal(e.prevId, null); assert.equal(e.nextId, null);
  // 快组紧跟慢组:可行(不影响任何人)但自己要等很久 → CAND_WAITS
  const slow = G('S', 480, 1.4, true);
  const before = snapshot([slow]);
  const w = Pace.checkInsert(holes, cfg, [slow], G('F', 490, 0.75));
  assert.equal(w.ok, true); assert.ok(w.candWait > cfg.maxCandWaitMin); assert.deepEqual(w.warnings, ['CAND_WAITS']);
  assert.equal(snapshot([slow]), before);
});

test('checkInsert: baseline option is used as the reference; now is passed through to projections', () => {
  const base = Pace.projectSheet(holes, sheetE2).byId;
  const r = Pace.checkInsert(holes, cfg, sheetE2, G('E', 496, 1.2), { baseline: base });
  assert.equal(r.reason, 'IMPACTS_BEHIND'); approx(r.shiftMin, 35.4, 0.1);
  // baseline 缺少某组时回退到自算
  const r2 = Pace.checkInsert(holes, cfg, sheetE2, G('E', 496, 1.2), { baseline: { A: base.A } });
  approx(r2.shiftMin, r.shiftMin, 1e-9);
  // 一个"伪基线"把 C 已经推迟 → 不再算受影响(比今天的表更晚才算)
  const after = Pace.projectSheet(holes, Pace.insertCand(sheetE2, G('E', 496, 1.2))).byId;
  const r3 = Pace.checkInsert(holes, cfg, sheetE2, G('E', 496, 1.2), { baseline: after });
  assert.equal(r3.ok, true);
});

test('checkInsert with shiftTolMin > 0 and frozenPlans: budget measured against the frozen plan', () => {
  const tolCfg = Course.mergeConfig(cfg, { shiftTolMin: 5 });
  // 不带 frozenPlans:C 被推迟 35.4 > 5 → 仍被拒
  const r0 = Pace.checkInsert(holes, tolCfg, sheetE2, G('E', 496, 1.2));
  assert.equal(r0.reason, 'IMPACTS_BEHIND');
  // 小幅影响:f 1.03 的 E 在 C 前面 → C 推迟 ≈ 3.83 分
  const r1 = Pace.checkInsert(holes, cfg, sheetE2, G('E', 496, 1.03));
  assert.equal(r1.reason, 'IMPACTS_BEHIND'); assert.ok(r1.shiftMin > 0 && r1.shiftMin < 5, 'shift ' + r1.shiftMin);
  approx(r1.shiftMin, 3.83, 0.01);
  const r2 = Pace.checkInsert(holes, tolCfg, sheetE2, G('E', 496, 1.03));
  assert.equal(r2.ok, true);                                              // 容差 5 内放行
  // frozenPlans 比插入后的表早 6 分 → 预算 ≈ 6 > 5 → 拒绝,shiftMin 仍是相对今天表的影响
  const after = Pace.projectSheet(holes, Pace.insertCand(sheetE2, G('E', 496, 1.03))).byId;
  const frozenEarly = {};
  for (const id in after) frozenEarly[id] = { rows: after[id].rows.map(x => ({ start: x.start - 6, finish: x.finish - 6 })) };
  const r3 = Pace.checkInsert(holes, tolCfg, sheetE2, G('E', 496, 1.03), { frozenPlans: frozenEarly });
  assert.equal(r3.reason, 'IMPACTS_BEHIND'); assert.equal(r3.victimId, 'C'); approx(r3.shiftMin, r1.shiftMin, 1e-9);
  // 默认 shiftTolMin 0 时 frozenPlans 被忽略
  const r4 = Pace.checkInsert(holes, cfg, sheetE2, G('E', 496, 1), { frozenPlans: frozenEarly });
  assert.equal(r4.ok, true);
});

test('checkInsert with on-course predecessor: its tee is the actual tee-off; cand stays behind it', () => {
  const oc = { id: 'O', tee: 485, f: 1, plan: { fPlan: 1, confident: false }, size: 4, onCourse: true, actuals: { 0: { start: 485 } } };
  const r = Pace.checkInsert(holes, cfg, [oc], G('E', 480, 1), { now: 490 });
  assert.equal(r.reason, 'GAP_AHEAD'); assert.equal(r.need, 8); assert.equal(r.prevId, 'O');
  const ok = Pace.checkInsert(holes, cfg, [oc], G('E', 493, 1), { now: 490 });
  assert.equal(ok.ok, true); approx(ok.candWait, 0);
});

test('(g) Markov brute-force: checking only n equals checking all groups behind (50 seeded sheets × 4 cands)', () => {
  const rng = mulberry32(20261006);
  const ri = (lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));
  const rf = (lo, hi) => lo + rng() * (hi - lo);
  let reached = 0, impacted = 0, okCount = 0;
  for (let s = 0; s < 50; s++) {
    const N = ri(5, 12);
    const sheet = [];
    let tee = 480;
    for (let k = 0; k < N; k++) {
      if (k) tee += ri(6, 10) * (rng() < 0.3 ? 2 : 1);     // 6–10 分间隔,偶有空档
      sheet.push(G('g' + String(k).padStart(2, '0'), tee, Math.round(rf(0.8, 1.3) * 100) / 100));
    }
    // 每张表试 4 个候选:一半完全随机,一半瞄准某组后的推荐间隔附近(含表尾)
    for (let j = 0; j < 4; j++) {
      let cTee;
      if (rng() < 0.5) cTee = ri(474, tee + 10);
      else { const q = sheet[ri(0, N - 1)]; cTee = q.tee + Pace.iRec(q, cfg).interval + ri(0, 3); }
      const cand = G('cand', cTee, Math.round(rf(0.8, 1.3) * 100) / 100);
      const full = Pace.checkInsert(holes, cfg, sheet, cand);
      // 只看 n 的判定
      const merged = Pace.insertCand(sheet, cand);
      const ci = merged.indexOf(cand);
      const p = ci > 0 ? merged[ci - 1] : null, n = ci < merged.length - 1 ? merged[ci + 1] : null;
      let onlyN;
      if (p && cand.tee - p.tee < Pace.iRec(p, cfg).interval - Course.EPS) onlyN = { ok: false, reason: 'GAP_AHEAD' };
      else if (n && n.tee - cand.tee < Pace.iRec(cand, cfg).interval - Course.EPS) onlyN = { ok: false, reason: 'GAP_BEHIND' };
      else {
        reached++;
        let shift = 0;
        if (n) {
          const base = Pace.projectSheet(holes, sheet).byId[n.id];
          const after = Pace.projectSheet(holes, merged).byId[n.id];
          for (let i = 0; i < H; i++) shift = Math.max(shift, after.rows[i].start - base.rows[i].start, after.rows[i].finish - base.rows[i].finish);
        }
        onlyN = shift > Course.EPS ? { ok: false, reason: 'IMPACTS_BEHIND', shiftMin: shift, victimId: n.id } : { ok: true };
      }
      assert.equal(full.ok, onlyN.ok, `sheet ${s}/${j}: ok`);
      assert.equal(full.reason, onlyN.reason, `sheet ${s}/${j}: reason`);
      if (!onlyN.ok && onlyN.reason === 'IMPACTS_BEHIND') {
        impacted++;
        assert.equal(full.shiftMin, onlyN.shiftMin, `sheet ${s}/${j}: shiftMin`);   // §2.6 (g):tolerance 0
        assert.equal(full.victimId, onlyN.victimId, `sheet ${s}/${j}: victim`);
      }
      if (full.ok) okCount++;
    }
  }
  assert.ok(reached >= 20, 'reached step 4: ' + reached);
  assert.ok(impacted >= 5, 'impacted: ' + impacted);
  assert.ok(okCount >= 10, 'ok: ' + okCount);
});

// ---------- §2.5 suggestSlots / autoPack ----------
test('suggestSlots: ≤ 5 slots sorted by (cost, tee), rejected counts, scanned = grid size', () => {
  const res = Pace.suggestSlots(holes, cfg, sheetE2, { tReq: 496, windowMin: 20, plan: { fPlan: 1, confident: false }, size: 4, openMin: 390, closeMin: 960 });
  assert.equal(res.scanned, 41);
  assert.ok(res.slots.length >= 1 && res.slots.length <= 5);
  assert.equal(res.slots[0].tee, 496);
  approx(res.slots[0].candWait, 0); approx(res.slots[0].candRound, 232); assert.deepEqual(res.slots[0].warnings, []);
  assert.equal(res.slots[0].frag, 1);                 // fragA = 496 − 488 − 7 = 1 → 碎片
  approx(res.slots[0].cost, 3);
  for (let i = 1; i < res.slots.length; i++) {
    const a = res.slots[i - 1], b = res.slots[i];
    assert.ok(a.cost < b.cost || (a.cost === b.cost && a.tee < b.tee));
  }
  const rejTotal = res.rejected.OUTSIDE_HOURS + res.rejected.GAP_AHEAD + res.rejected.GAP_BEHIND + res.rejected.IMPACTS_BEHIND;
  assert.ok(res.rejected.GAP_AHEAD > 0 && res.rejected.GAP_BEHIND > 0);
  // 每个扫描点要么进入候选(可能被截到 5 个)要么被拒:slots = 前 ≤ 5 个可行点
  const feasible = res.scanned - rejTotal;
  assert.equal(res.slots.length, Math.min(5, feasible));
  // 空表:每个 T 都可行,最近的 tReq 优先
  const e = Pace.suggestSlots(holes, cfg, [], { tReq: 500, windowMin: 10, plan: { fPlan: 1 }, size: 2, openMin: 390, closeMin: 960 });
  assert.equal(e.scanned, 21); assert.equal(e.slots.length, 5); assert.equal(e.slots[0].tee, 500); approx(e.slots[0].cost, 0);
  assert.deepEqual(e.slots.map(s => s.tee), [500, 499, 501, 498, 502]);
});

test('suggestSlots: window clipped to open/close hours; default windowMin 60; slow cand → IMPACTS_BEHIND counted', () => {
  const r = Pace.suggestSlots(holes, cfg, [], { tReq: 400, windowMin: 30, plan: { fPlan: 1 }, size: 4, openMin: 390, closeMin: 960 });
  assert.equal(r.scanned, 41); assert.equal(r.rejected.OUTSIDE_HOURS, 0);
  const r2 = Pace.suggestSlots(holes, cfg, [], { tReq: 400, plan: { fPlan: 1 }, size: 4, openMin: 390, closeMin: 420 });
  assert.equal(r2.scanned, 31);
  const r3 = Pace.suggestSlots(holes, cfg, sheetE2, { tReq: 496, windowMin: 4, plan: { fPlan: 1.2, confident: false }, size: 4, openMin: 390, closeMin: 960 });
  assert.ok(r3.rejected.IMPACTS_BEHIND >= 1);
  // 大等待 → 代价 +10 与 CAND_WAITS
  const slow = G('S', 480, 1.4, true);
  const r4 = Pace.suggestSlots(holes, cfg, [slow], { tReq: 490, windowMin: 0, plan: { fPlan: 0.75 }, size: 4 });
  assert.equal(r4.scanned, 1); assert.equal(r4.slots.length, 1);
  assert.deepEqual(r4.slots[0].warnings, ['CAND_WAITS']);
  approx(r4.slots[0].cost, 0.5 * r4.slots[0].candWait + 10 + 3 * r4.slots[0].frag);
});

test('autoPack: places by tReq order at the first feasible T within flex, respects iRec(prev); unplaceable → waitlist', () => {
  const reqs = [
    { id: 'r2', tReq: 488, plan: { fPlan: 1, confident: false }, size: 4, flexMin: 0 },
    { id: 'r1', tReq: 480, plan: { fPlan: 1, confident: false }, size: 4, flexMin: 0 },
    { id: 'r3', tReq: 490, plan: { fPlan: 1, confident: false }, size: 2, flexMin: 0 },
    { id: 'r4', tReq: 492, plan: { fPlan: 1, confident: false }, size: 2, flexMin: 6 }
  ];
  const before = snapshot(reqs);
  const out = Pace.autoPack(holes, cfg, reqs, 390, 960);
  assert.deepEqual(out.placed.map(g => g.id + '@' + g.tee), ['r1@480', 'r2@488', 'r4@496']);
  assert.deepEqual(out.waitlist, [{ id: 'r3', tReq: 490, reason: 'GAP_AHEAD' }]);   // 窗口被 prev.tee + iRec(prev) 吃掉
  assert.equal(out.placed[2].f, 1); assert.equal(out.placed[2].onCourse, false); assert.equal(out.placed[2].size, 2);
  assert.equal(snapshot(reqs), before);
  // 快组后面可以 7 分钟;窗口外 → 等待名单(NO_SLOT)
  const out2 = Pace.autoPack(holes, cfg, [
    { id: 'f', tReq: 480, plan: { fPlan: 0.85, confident: true }, size: 4, flexMin: 0 },
    { id: 's', tReq: 487, plan: { fPlan: 1, confident: false }, size: 4, flexMin: 0 },
    { id: 'x', tReq: 300, plan: { fPlan: 1 }, size: 4, flexMin: 0 }
  ], 390, 960);
  assert.deepEqual(out2.placed.map(g => g.id + '@' + g.tee), ['f@480', 's@487']);
  assert.deepEqual(out2.waitlist.map(w => w.id), ['x']);
  assert.deepEqual(Pace.autoPack(holes, cfg, [], 390, 960), { placed: [], waitlist: [] });
});

// ---------- 黄金夹具 ----------
test('golden fixtures sheet-a/b/d match projectSheet within 0.01', () => {
  for (const name of ['sheet-a', 'sheet-b', 'sheet-d']) {
    const fx = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name + '.json'), 'utf8'));
    assert.equal(fx.engineVersion, cfg.engineVersion, name + ' engineVersion');
    assert.equal(fx.holes.length, 18);
    const P = Pace.projectSheet(fx.holes, fx.groups);
    const ids = Object.keys(fx.expected);
    assert.equal(ids.length, fx.groups.length);
    for (const id of ids) {
      const exp = fx.expected[id], got = P.byId[id];
      assert.ok(got, name + ' ' + id);
      assert.equal(exp.rows.length, got.rows.length);
      for (let i = 0; i < exp.rows.length; i++) {
        assert.equal(exp.rows[i].holeNo, got.rows[i].holeNo);
        approx(got.rows[i].start, exp.rows[i].start, 0.01, `${name} ${id} h${i + 1} start`);
        approx(got.rows[i].finish, exp.rows[i].finish, 0.01, `${name} ${id} h${i + 1} finish`);
      }
      approx(got.finish, exp.finish, 0.01, name + ' ' + id + ' finish');
      approx(got.waitMin, exp.waitMin, 0.01, name + ' ' + id + ' waitMin');
    }
  }
  // 夹具中的手工钉值
  const b = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'sheet-b.json'), 'utf8'));
  assert.deepEqual(['A', 'B', 'C', 'D'].map(id => b.expected[id].waitMin), [0, 1, 2, 3]);
  const d = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'sheet-d.json'), 'utf8'));
  approx(d.expected.B.waitMin, 26.05, 0.01); approx(d.expected.B.finish, 716.35, 0.01);
});

// ---------- 回归:审阅发现 ----------
test('sheetGroups: a booking whose progress is "done" but whose status is still onCourse is NOT re-projected as a fresh group', () => {
  const bookings = [
    { id: 'a', teeMin: 480, size: 4, status: 'onCourse', teeOffActual: 480 },
    { id: 'b', teeMin: 488, size: 4, status: 'onCourse', teeOffActual: 488 },
    { id: 'c', teeMin: 496, size: 4, status: 'booked' }
  ];
  const plans = { a: { fPlan: 1 }, b: { fPlan: 1 }, c: { fPlan: 1 } };
  const progressById = {
    a: { phase: 'done', holeIdx: H, teeOffActual: 480, actuals: {} },
    b: { phase: 'playing', holeIdx: 3, teeOffActual: 488, actuals: { 0: { start: 488 } } }
  };
  const gs = Pace.sheetGroups(bookings, plans, { progressById });
  assert.deepEqual(gs.map(g => [g.id, g.tee, g.onCourse]), [['b', 488, true], ['c', 496, false]]);
  // 幽灵组不再参与间隔 / 影响判定:只剩已打完的 a 时表为空,在 484 插入可行(此前会对 480 的幽灵报 GAP_AHEAD need 8)
  const onlyDone = Pace.sheetGroups([bookings[0]], plans, { progressById });
  assert.deepEqual(onlyDone, []);
  assert.equal(Pace.checkInsert(holes, cfg, onlyDone, G('n', 484, 1)).ok, true);
});

test('checkInsert: cand.id colliding with a sheet group throws (moveBooking must exclude the moved booking)', () => {
  const sheet = [G('a', 480, 1), G('b', 488, 1)];
  assert.throws(() => Pace.checkInsert(holes, cfg, sheet, G('b', 496, 1.3)), /collides/);
  // 剔除后正常
  const r = Pace.checkInsert(holes, cfg, [sheet[0]], G('b', 496, 1.3));
  assert.equal(typeof r.ok, 'boolean');
  // suggestSlots 的 '__cand' 与 autoPack 的不同 id 不受影响
  assert.equal(Pace.suggestSlots(holes, cfg, sheet, { tReq: 500, windowMin: 5, plan: { fPlan: 1 }, size: 4 }).scanned, 11);
});

test('suggestSlots: scan bounded to [0, 1440] and never proposes a tee before now', () => {
  // 异常 windowMin:扫描数被限定在一天之内
  const big = Pace.suggestSlots(holes, cfg, [], { tReq: 500, windowMin: 1e5, plan: { fPlan: 1 }, size: 2 });
  assert.equal(big.scanned, 1441);
  // 迟到改时:tReq = now = 500,最后一组 470 已开球 → 不出现 499/498
  const late = Pace.suggestSlots(holes, cfg, [G('p', 470, 1)], { tReq: 500, windowMin: 10, plan: { fPlan: 1 }, size: 2, now: 500, openMin: 390, closeMin: 960 });
  assert.equal(late.scanned, 11);
  assert.ok(late.slots.every(s => s.tee >= 500), JSON.stringify(late.slots.map(s => s.tee)));
  assert.deepEqual(late.slots.map(s => s.tee), [500, 501, 502, 503, 504]);
  // 无 now:行为不变(对称窗口)
  const noNow = Pace.suggestSlots(holes, cfg, [], { tReq: 500, windowMin: 10, plan: { fPlan: 1 }, size: 2, openMin: 390, closeMin: 960 });
  assert.equal(noNow.scanned, 21); assert.deepEqual(noNow.slots.map(s => s.tee), [500, 499, 501, 498, 502]);
});
