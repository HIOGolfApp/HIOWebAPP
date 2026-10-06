'use strict';
const { test, assert, approx } = require('./_harness.js');
const Course = require('../js/course.js');
const Learn = require('../js/learn.js');

const D = '2026-10-06';
const cfg = Course.defaultConfig();
const course = Course.normalizeCourse({ holes: Course.demoLayout() });
const holes = course.holes;
const booking = { id: 'g1', date: D, size: 4 };

// ---------- helpers: synthesize a round's events ----------
// opts.f: pace factor; opts.transit: cart transit (min); opts.teeWait: { holeNo: minutes waited on tee };
// opts.extra: { holeNo: extra minutes on hole }; opts.skipArrive: { holeNo: true } (no arriveTee event);
// opts.drop: { holeNo: ['teeOff'|'leaveGreen'|'arriveTee'] } events to omit
function makeRound(tee, opts) {
  opts = opts || {};
  const f = opts.f == null ? 1 : opts.f;
  const transit = opts.transit == null ? 2 : opts.transit;
  const events = [];
  let t = tee;
  let leaves = {};
  for (let i = 0; i < holes.length; i++) {
    const h = holes[i];
    const arr = i === 0 ? tee : t + transit;
    const wait = (opts.teeWait && opts.teeWait[h.no]) || 0;
    const teeOff = arr + wait;
    const extra = (opts.extra && opts.extra[h.no]) || 0;
    const leave = teeOff + h.std * f + extra;
    const drop = (opts.drop && opts.drop[h.no]) || [];
    const push = (type, tt) => { if (drop.indexOf(type) < 0) events.push({ id: 'e' + events.length, bookingId: 'g1', holeNo: h.no, type, t: tt, source: 'sim' }); };
    if (!(opts.skipArrive && opts.skipArrive[h.no])) push('arriveTee', arr);
    push('teeOff', teeOff);
    push('leaveGreen', leave);
    leaves[h.no] = leave;
    t = leave;
  }
  return { events, leaves };
}

// ---------- updatePlayer / decayedN ----------
test('updatePlayer EMA vector: rounds 0.80, 0.85, 0.80 same date → f 0.80, 0.825, 0.81667; nEff 3; roundsScored 3', () => {
  let s = Learn.updatePlayer(null, 0.80, D, cfg);
  approx(s.f, 0.80, 1e-4); assert.equal(s.nEff, 1); assert.equal(s.roundsScored, 1); assert.equal(s.lastRoundDate, D);
  s = Learn.updatePlayer(s, 0.85, D, cfg);
  approx(s.f, 0.825, 1e-4); assert.equal(s.nEff, 2); assert.equal(s.roundsScored, 2);
  s = Learn.updatePlayer(s, 0.80, D, cfg);
  approx(s.f, 0.81667, 1e-4); assert.equal(s.nEff, 3); assert.equal(s.roundsScored, 3);
  assert.ok(Number.isFinite(s.v) && s.v >= 0);
  approx(Learn.decayedN(s, D, cfg), 3);
  approx(Learn.decayedN(s, '2026-10-07', cfg), 2.988, 0.02);
});

test('updatePlayer consecutive-day variant: nEff ≈ 2.988 (decay between rounds), f unchanged within tolerance', () => {
  let s = Learn.updatePlayer(null, 0.80, '2026-10-04', cfg);
  s = Learn.updatePlayer(s, 0.85, '2026-10-05', cfg);
  s = Learn.updatePlayer(s, 0.80, '2026-10-06', cfg);
  approx(s.nEff, 2.988, 0.02);
  assert.equal(s.roundsScored, 3);
  assert.equal(s.lastRoundDate, '2026-10-06');
  approx(s.f, 0.81667, 2e-3);
});

test('updatePlayer keeps playerId, uses alpha floor emaAlpha for large nEff and does not mutate input', () => {
  const stats = { playerId: 'p1', f: 1.0, v: 0.04, nEff: 100, lastRoundDate: D, roundsScored: 100 };
  const frozen = JSON.stringify(stats);
  const s = Learn.updatePlayer(stats, 1.2, D, cfg);
  assert.equal(s.playerId, 'p1');
  approx(s.f, 0.7 * 1.0 + 0.3 * 1.2);              // alpha = max(0.3, 1/101) = 0.3
  approx(s.v, 0.7 * 0.04 + 0.3 * Math.pow(1.2 - s.f, 2));
  approx(s.nEff, 101);
  assert.equal(s.roundsScored, 101);
  assert.equal(JSON.stringify(stats), frozen);
});

test('updatePlayer bounds f to [fMin, fMax] = [0.75, 1.4]', () => {
  assert.equal(Learn.updatePlayer(null, 3.0, D, cfg).f, 1.4);
  assert.equal(Learn.updatePlayer(null, 0.1, D, cfg).f, 0.75);
  const s = Learn.updatePlayer({ playerId: 'x', f: 1.39, v: 0.04, nEff: 1, lastRoundDate: D, roundsScored: 1 }, 2.0, D, cfg);
  assert.equal(s.f, 1.4);
  // 从 null 起步:alpha = 1 → f = fRound(在界内)
  approx(Learn.updatePlayer(null, 1.1, D, cfg).f, 1.1);
});

test('decayedN: null stats → 0; missing dates → nEff unchanged; 180 days → half', () => {
  assert.equal(Learn.decayedN(null, D, cfg), 0);
  assert.equal(Learn.decayedN({ nEff: 4, lastRoundDate: null }, D, cfg), 4);
  approx(Learn.decayedN({ nEff: 4, lastRoundDate: '2026-04-09' }, D, cfg), 2);
});

// ---------- observeRound ----------
test('observeRound clean round: 18 observations, all clean, ratios = f, fRound = f, transit measured', () => {
  const r = makeRound(480, { f: 0.9, transit: 2.5 });
  const res = Learn.observeRound(holes, booking, r.events, [], 0.95, cfg);
  assert.equal(res.observations.length, 18);
  assert.equal(res.cleanHoles, 18);
  approx(res.fRound, 0.9, 1e-9);
  res.observations.forEach((o, i) => {
    assert.equal(o.bookingId, 'g1'); assert.equal(o.date, D); assert.equal(o.holeNo, holes[i].no);
    assert.equal(o.held, false); assert.equal(o.fGroup, 0.95);
    approx(o.obs, holes[i].std * 0.9, 1e-9);
    approx(o.ratio, 0.9, 1e-9);
    if (i === 0) assert.equal(o.transit, undefined);
    else approx(o.transit, 2.5, 1e-9);
  });
});

test('observeRound held: 4-min tee wait → held, no ratio, transit still from arriveTee; 1-min wait is fine', () => {
  const r = makeRound(480, { teeWait: { 5: 4, 7: 1 } });
  const res = Learn.observeRound(holes, booking, r.events, [], 1, cfg);
  const o5 = res.observations[4];
  assert.equal(o5.holeNo, 5);
  assert.equal(o5.held, true);
  assert.equal(o5.ratio, undefined);
  approx(o5.obs, 11, 1e-9);                        // obs 仍记录(leaveGreen − teeOff)
  approx(o5.transit, 2, 1e-9);                      // 到达发球台 − 前洞离开果岭
  const o7 = res.observations[6];
  assert.equal(o7.held, false);                     // 等待 1 分钟不算被阻挡(> 1 才算)
  assert.equal(res.cleanHoles, 17);
  approx(res.fRound, 1, 1e-9);
});

test('observeRound held: left green 1.0 min after the group ahead → held; 3.0 min after → clean; 2.5 boundary → held', () => {
  const mine = makeRound(488);
  // 前组事件:在我们离开第 3 洞果岭前 1.0 分钟离开;第 6 洞前 3.0 分钟;第 9 洞恰好 2.5 分钟
  const aheadEvents = [
    { id: 'a1', bookingId: 'g0', holeNo: 3, type: 'leaveGreen', t: mine.leaves[3] - 1.0 },
    { id: 'a2', bookingId: 'g0', holeNo: 6, type: 'leaveGreen', t: mine.leaves[6] - 3.0 },
    { id: 'a3', bookingId: 'g0', holeNo: 9, type: 'leaveGreen', t: mine.leaves[9] - 2.5 }
  ];
  const res = Learn.observeRound(holes, booking, mine.events, aheadEvents, 1, cfg);
  assert.equal(res.observations[2].held, true);
  assert.equal(res.observations[5].held, false);
  assert.equal(res.observations[8].held, true);
  assert.equal(res.cleanHoles, 16);
});

test('observeRound held: missing teeOff or leaveGreen → held with obs null; aheadEvents may be omitted', () => {
  const r = makeRound(480, { drop: { 2: ['leaveGreen'], 4: ['teeOff'] } });
  const res = Learn.observeRound(holes, booking, r.events, undefined, 1, cfg);
  const o2 = res.observations[1], o3 = res.observations[2], o4 = res.observations[3];
  assert.equal(o2.held, true); assert.equal(o2.obs, null); assert.equal(o2.ratio, undefined);
  assert.equal(o4.held, true); assert.equal(o4.obs, null);
  // 第 3 洞:前洞无 leaveGreen → transit 无法计算,但本洞本身干净
  assert.equal(o3.held, false); assert.equal(o3.transit, undefined);
  assert.equal(res.cleanHoles, 16);
});

test('observeRound semantic dedupe: earliest t per (holeNo, type) wins regardless of array order', () => {
  const r = makeRound(480);
  const events = r.events.slice().reverse();
  // 第 1 洞重复的更晚 teeOff 与更晚 leaveGreen 应被忽略
  events.push({ id: 'dup1', bookingId: 'g1', holeNo: 1, type: 'teeOff', t: 483, source: 'player' });
  events.push({ id: 'dup2', bookingId: 'g1', holeNo: 1, type: 'leaveGreen', t: 499, source: 'caddie' });
  // 不在路线中的洞号被忽略
  events.push({ id: 'x', bookingId: 'g1', holeNo: 99, type: 'teeOff', t: 400, source: 'sim' });
  const res = Learn.observeRound(holes, booking, events, [], 1, cfg);
  assert.equal(res.observations.length, 18);
  approx(res.observations[0].obs, 11, 1e-9);
  assert.equal(res.observations[0].held, false);
  approx(res.fRound, 1, 1e-9);
});

test('observeRound ratio clamp [0.5, 2.0]', () => {
  const r = makeRound(480, { extra: { 1: 60, 2: -8 } });     // 第 1 洞 71 分钟(6.45×),第 2 洞 3 分钟(0.27×)
  const res = Learn.observeRound(holes, booking, r.events, [], 1, cfg);
  assert.equal(res.observations[0].ratio, 2.0);
  assert.equal(res.observations[1].ratio, 0.5);
  const tight = Course.mergeConfig(cfg, { ratioClamp: [0.8, 1.5] });
  const res2 = Learn.observeRound(holes, booking, r.events, [], 1, tight);
  assert.equal(res2.observations[0].ratio, 1.5);
  assert.equal(res2.observations[1].ratio, 0.8);
});

test('observeRound: fRound null when fewer than minCleanHoles clean holes; exactly minCleanHoles → scored', () => {
  // 只有 5 个洞有完整事件
  const drop = {};
  holes.forEach((h) => { if (h.no > 5) drop[h.no] = ['leaveGreen']; });
  const r5 = makeRound(480, { f: 1.1, drop });
  const res5 = Learn.observeRound(holes, booking, r5.events, [], 1, cfg);
  assert.equal(res5.cleanHoles, 5);
  assert.equal(res5.fRound, null);
  assert.equal(res5.observations.length, 18);
  const drop6 = {};
  holes.forEach((h) => { if (h.no > 6) drop6[h.no] = ['leaveGreen']; });
  const r6 = makeRound(480, { f: 1.1, drop: drop6 });
  const res6 = Learn.observeRound(holes, booking, r6.events, [], 1, cfg);
  assert.equal(res6.cleanHoles, 6);
  approx(res6.fRound, 1.1, 1e-9);
  const strict = Course.mergeConfig(cfg, { minCleanHoles: 7 });
  assert.equal(Learn.observeRound(holes, booking, r6.events, [], 1, strict).fRound, null);
});

test('observeRound uses the median, not the mean: one lost-ball hole does not move fRound', () => {
  const r = makeRound(480, { f: 1.0, extra: { 8: 12 } });   // 第 8 洞找球 +12 分钟
  const res = Learn.observeRound(holes, booking, r.events, [], 1, cfg);
  approx(res.fRound, 1.0, 1e-9);
  const ratios = res.observations.map(o => o.ratio);
  assert.ok(Course.mean(ratios) > 1.03);                      // 均值会被拉高
  approx(res.observations[7].ratio, 27 / 15, 1e-9);
});

test('observeRound transit: arriveTee preferred; fallback teeOff − prev leaveGreen only when not held; none on hole 0', () => {
  const r = makeRound(480, { transit: 3, skipArrive: { 2: true, 3: true } });
  // 第 3 洞无 arriveTee,且紧跟前组离开果岭(1 分钟)→ 被阻挡
  const ahead = [{ id: 'a', bookingId: 'g0', holeNo: 3, type: 'leaveGreen', t: r.leaves[3] - 1 }];
  const res = Learn.observeRound(holes, booking, r.events, ahead, 1, cfg);
  assert.equal(res.observations[0].transit, undefined);
  approx(res.observations[1].transit, 3, 1e-9);              // 无 arriveTee、未被阻挡 → teeOff − 前洞 leaveGreen
  assert.equal(res.observations[2].held, true);
  assert.equal(res.observations[2].transit, undefined);      // 被阻挡且无 arriveTee → 未知
  approx(res.observations[3].transit, 3, 1e-9);
  // 无 arriveTee 时无法识别发球台等待(规则需要 arriveTee)→ 该洞仍算干净,转场退化为 teeOff − 前洞 leaveGreen(含等待)
  const r3 = makeRound(480, { transit: 3, skipArrive: { 5: true }, teeWait: { 5: 4 } });
  const res3 = Learn.observeRound(holes, booking, r3.events, [], 1, cfg);
  assert.equal(res3.observations[4].held, false);
  approx(res3.observations[4].transit, 7, 1e-9);
  // 到达发球台后等了 4 分钟:transit 用 arriveTee 计算,不含等待
  const r2 = makeRound(480, { transit: 3, teeWait: { 3: 4 } });
  const res2 = Learn.observeRound(holes, booking, r2.events, [], 1, cfg);
  approx(res2.observations[2].transit, 3, 1e-9);
});

test('observeRound does not mutate its inputs and respects per-hole minFollow', () => {
  const r = makeRound(480);
  const frozenEvents = JSON.stringify(r.events);
  const frozenBooking = JSON.stringify(booking);
  const ahead = [{ id: 'a', bookingId: 'g0', holeNo: 4, type: 'leaveGreen', t: r.leaves[4] - 3.0 }];
  const frozenAhead = JSON.stringify(ahead);
  const res = Learn.observeRound(holes, booking, r.events, ahead, 1, cfg);
  assert.equal(res.observations[3].held, false);             // minFollow 1 → 阈值 2.5 < 3.0
  assert.equal(JSON.stringify(r.events), frozenEvents);
  assert.equal(JSON.stringify(booking), frozenBooking);
  assert.equal(JSON.stringify(ahead), frozenAhead);
  const slowHoles = holes.map(h => h.no === 4 ? Object.assign({}, h, { minFollow: 2 }) : h);
  assert.equal(Learn.observeRound(slowHoles, booking, r.events, ahead, 1, cfg).observations[3].held, true);  // 阈值 3.5
});

// ---------- calibrate ----------
// 生成 n 组观测:每洞 obs = std × mult(+ 微小扰动,保持中位数),transit 固定
function makeObs(n, mult, opts) {
  opts = opts || {};
  const out = [];
  for (let k = 0; k < n; k++) {
    holes.forEach((h, i) => {
      const o = { bookingId: 'b' + k, date: D, holeNo: h.no, held: false, fGroup: opts.fGroup == null ? 1 : opts.fGroup };
      const jitter = ((k % 5) - 2) * 0.1;                   // −0.2 … +0.2,对称 → 中位数不变
      o.obs = h.std * (opts.parMult && opts.parMult[h.par] != null ? opts.parMult[h.par] : mult) + jitter;
      o.ratio = o.obs / h.std;
      if (i > 0) o.transit = opts.transit == null ? 2 : (typeof opts.transit === 'function' ? opts.transit(k) : opts.transit);
      out.push(o);
    });
  }
  return out;
}

test('calibrate: true par-4 time 13 min with fGroup ≈ 1.18 → suggests std 13 (RAW minutes, not /fGroup) when n ≥ minN', () => {
  const obs = makeObs(30, 1, { parMult: { 4: 13 / 11 }, fGroup: 1.18 });
  const sug = Learn.calibrate(obs, holes, cfg);
  assert.equal(sug.length, 18);
  sug.forEach((s, i) => {
    const h = holes[i];
    assert.equal(s.holeNo, h.no); assert.equal(s.n, 30); assert.equal(s.nTransit, i === 0 ? 0 : 30);
    assert.deepEqual(s.current, { std: h.std, transit: 2 });
    if (h.par === 4) {
      approx(s.observed.std, 13, 1e-9);
      assert.equal(s.suggested.std, 13);
      assert.equal(s.effectOnIBase, 8);                      // 0.45 × 13 = 5.85 < minGap 6 → B 仍为 7 → 8
    } else {
      approx(s.observed.std, h.std, 1e-9);
      assert.equal(s.suggested.std, undefined);
      assert.equal(s.effectOnIBase, 8);
    }
    assert.equal(s.suggested.transit, undefined);            // 转场 p20 = 2 = 当前
    if (i > 0) approx(s.observed.transit, 2, 1e-9); else assert.equal(s.observed.transit, null);
  });
});

test('calibrate: n < minN → observed reported but nothing suggested', () => {
  const sug = Learn.calibrate(makeObs(29, 13 / 11), holes, cfg);
  sug.forEach((s, i) => {
    assert.equal(s.n, 29);
    approx(s.observed.std, holes[i].std * 13 / 11, 1e-9);
    assert.deepEqual(s.suggested, {});
    assert.equal(s.effectOnIBase, 8);
  });
  // 空观测 → 全部 n 0,observed null
  const empty = Learn.calibrate([], holes, cfg);
  assert.equal(empty.length, 18);
  assert.equal(empty[0].n, 0); assert.equal(empty[0].observed.std, null); assert.deepEqual(empty[0].suggested, {});
});

test('calibrate: held observations are excluded from n; stdDeltaMin suppresses small deltas', () => {
  const obs = makeObs(35, 13 / 11);
  // 把每洞 6 条标记为 held → 干净 29 条 < minN
  let marked = 0;
  obs.forEach(o => { if (o.bookingId === 'b0' || o.bookingId === 'b1' || o.bookingId === 'b2' || o.bookingId === 'b3' || o.bookingId === 'b4' || o.bookingId === 'b5') { o.held = true; marked++; } });
  assert.equal(marked, 6 * 18);
  const sug = Learn.calibrate(obs, holes, cfg);
  assert.equal(sug[0].n, 29);
  assert.deepEqual(sug[0].suggested, {});
  // 观测 11.5(Δ 0.5 < stdDeltaMin 1)→ 不建议;Δ 恰好 1 → 建议
  const small = Learn.calibrate(makeObs(30, 11.5 / 11), holes, cfg);
  assert.equal(small[0].suggested.std, undefined);
  const one = Learn.calibrate(makeObs(30, 12 / 11), holes, cfg);
  assert.equal(one[0].suggested.std, 12);
  approx(one[0].observed.std, 12, 1e-9);
});

test('calibrate: par-3 observed 9 min → suggested 9 and effectOnIBase 10 (derivedIBase with the suggestion applied)', () => {
  const sug = Learn.calibrate(makeObs(40, 1, { parMult: { 3: 9 / 7 } }), holes, cfg);
  const p3 = sug.filter((s, i) => holes[i].par === 3);
  assert.equal(p3.length, 4);
  p3.forEach(s => { assert.equal(s.suggested.std, 9); assert.equal(s.effectOnIBase, 10); });
  sug.filter((s, i) => holes[i].par !== 3).forEach(s => { assert.equal(s.suggested.std, undefined); assert.equal(s.effectOnIBase, 8); });
});

test('calibrate: transit p20 (linear-interpolated percentile) rounded to 0.5; transitDeltaMin gate', () => {
  // 转场样本 k=0..29 → 2.6 + 0.05k ∈ [2.6, 4.05];p20 = 2.6 + 0.05 × 5.8 = 2.89 → 建议 3.0(Δ 0.89 ≥ 0.5)
  const sug = Learn.calibrate(makeObs(30, 1, { transit: k => 2.6 + 0.05 * k }), holes, cfg);
  assert.equal(sug[0].nTransit, 0); assert.equal(sug[0].suggested.transit, undefined);
  assert.equal(sug[1].nTransit, 30);
  approx(sug[1].observed.transit, 2.89, 1e-9);
  assert.equal(sug[1].suggested.transit, 3);
  assert.equal(sug[1].suggested.std, undefined);
  // Δ 小于 transitDeltaMin → 不建议
  const small = Learn.calibrate(makeObs(30, 1, { transit: k => 2.1 + 0.05 * k }), holes, cfg);   // p20 2.39
  approx(small[1].observed.transit, 2.39, 1e-9);
  assert.equal(small[1].suggested.transit, undefined);
  // 29 条转场样本 → 不建议
  const few = Learn.calibrate(makeObs(29, 1, { transit: 4 }), holes, cfg);
  assert.equal(few[1].nTransit, 29); approx(few[1].observed.transit, 4, 1e-9); assert.equal(few[1].suggested.transit, undefined);
  // 被阻挡洞的转场仍可用于转场统计(nTransit 不受 held 影响)
  const heldObs = makeObs(30, 1, { transit: 4 }).map(o => Object.assign({}, o, { held: true }));
  const h = Learn.calibrate(heldObs, holes, cfg);
  assert.equal(h[1].n, 0); assert.equal(h[1].nTransit, 30); assert.equal(h[1].suggested.transit, 4);
});

// ---------- applyCalibration / resetDefaults ----------
test('applyCalibration: applies std/transit picks, bumps layoutVersion, leaves the input untouched', () => {
  const frozen = JSON.stringify(course);
  const next = Learn.applyCalibration(course, [{ holeNo: 1, std: 13 }, { holeNo: 3, transit: 3.5 }, { holeNo: 5, std: 12, transit: 1.5 }, { holeNo: 99, std: 20 }], cfg);
  assert.equal(next.layoutVersion, course.layoutVersion + 1);
  assert.equal(next.holes[0].std, 13); assert.equal(next.holes[0].transit, 2);
  assert.equal(next.holes[2].std, 7); assert.equal(next.holes[2].transit, 3.5);
  assert.equal(next.holes[4].std, 12); assert.equal(next.holes[4].transit, 1.5);
  assert.equal(next.holes[1].std, 11);
  assert.equal(next.holes.length, 18);
  assert.equal(next.holes[0].clearFrac, 0.45); assert.equal(next.holes[0].par, 4); assert.equal(next.holes[0].yards, 392);
  assert.equal(JSON.stringify(course), frozen);
  assert.notEqual(next.holes, course.holes);
  assert.notEqual(next.holes[0], course.holes[0]);
  assert.equal(next.id, course.id); assert.equal(next.routings[0].id, 'r18');
  // 再次采纳 → layoutVersion 继续递增
  assert.equal(Learn.applyCalibration(next, [{ holeNo: 1, std: 11 }], cfg).layoutVersion, course.layoutVersion + 2);
});

test('applyCalibration with limitStep caps each change at ±maxStepStd / ±maxStepTransit', () => {
  const next = Learn.applyCalibration(course, [{ holeNo: 1, std: 13, transit: 3.5 }, { holeNo: 2, std: 8, transit: 1 }, { holeNo: 3, std: 7.5, transit: 2.25 }], cfg, { limitStep: true });
  assert.equal(next.holes[0].std, 12);          // 11 → 13 capped to 12
  assert.equal(next.holes[0].transit, 2.5);     // 2 → 3.5 capped to 2.5
  assert.equal(next.holes[1].std, 10);          // 11 → 8 capped to 10
  assert.equal(next.holes[1].transit, 1.5);     // 2 → 1 capped to 1.5
  assert.equal(next.holes[2].std, 7.5);         // within step → as picked
  assert.equal(next.holes[2].transit, 2.25);
  assert.equal(next.layoutVersion, course.layoutVersion + 1);
  const wide = Course.mergeConfig(cfg, { calibration: { maxStepStd: 2 } });
  assert.equal(Learn.applyCalibration(course, [{ holeNo: 1, std: 13 }], wide, { limitStep: true }).holes[0].std, 13);
  // 不限步长(默认)→ 原样采纳
  assert.equal(Learn.applyCalibration(course, [{ holeNo: 1, std: 13 }], cfg).holes[0].std, 13);
  assert.equal(Learn.applyCalibration(course, [{ holeNo: 1, std: 13 }], cfg, { limitStep: false }).holes[0].std, 13);
});

test('calibrate → applyCalibration round trip: adopting all suggestions makes the next calibrate suggest nothing', () => {
  const obs = makeObs(30, 1, { parMult: { 4: 13 / 11 }, fGroup: 1.18 });
  const sug = Learn.calibrate(obs, holes, cfg);
  const picks = sug.filter(s => s.suggested.std != null || s.suggested.transit != null)
    .map(s => ({ holeNo: s.holeNo, std: s.suggested.std, transit: s.suggested.transit }));
  assert.equal(picks.length, 10);
  const next = Learn.applyCalibration(course, picks, cfg);
  next.holes.forEach(h => assert.equal(h.std, h.par === 4 ? 13 : (h.par === 3 ? 7 : 15)));
  assert.equal(Course.derivedIBase(next.holes, cfg), 8);
  Learn.calibrate(obs, next.holes, cfg).forEach(s => assert.deepEqual(s.suggested, {}));
});

test('resetDefaults restores 7/11/15, transit 2 and clearFrac by par; other hole fields kept; input untouched', () => {
  const changed = Learn.applyCalibration(course, holes.map(h => ({ holeNo: h.no, std: h.std + 2, transit: 3.5 })), cfg);
  changed.holes[2].clearFrac = 0.7; changed.holes[2].minGap = 7;
  const frozen = JSON.stringify(changed);
  const back = Learn.resetDefaults(changed, cfg);
  back.holes.forEach((h, i) => {
    assert.equal(h.std, { 3: 7, 4: 11, 5: 15 }[h.par]);
    assert.equal(h.transit, 2);
    assert.equal(h.clearFrac, { 3: 1.0, 4: 0.45, 5: 0.40 }[h.par]);
    assert.equal(h.no, holes[i].no); assert.equal(h.par, holes[i].par); assert.equal(h.yards, holes[i].yards);
  });
  assert.equal(back.holes[2].minGap, 7);                      // 非校准字段保持
  assert.equal(back.layoutVersion, changed.layoutVersion + 1);
  assert.equal(JSON.stringify(changed), frozen);
  assert.equal(Course.derivedIBase(back.holes, cfg), 8);
  // cfg 省略时使用 course.config
  assert.equal(Learn.resetDefaults(changed).holes[0].std, 11);
});
