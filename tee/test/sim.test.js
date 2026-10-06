'use strict';
const { test, assert, approx } = require('./_harness.js');
const Course = require('../js/course.js');
const Sim = require('../js/sim.js');

const COURSE = Course.normalizeCourse({ holes: Course.demoLayout() });
const HOLES = COURSE.holes;
const CFG = COURSE.config;
const H = HOLES.length;
const TYPE_RANK = { arriveTee: 0, teeOff: 1, leaveGreen: 2 };

function mkBooking(id, teeMin, extra) {
  return Object.assign({
    id, date: '2026-10-06', routingId: 'r18', teeMin, size: 4, players: [], caddieIds: [],
    status: 'booked', allowMerge: true, notes: '', createdAt: 0, version: 1
  }, extra || {});
}
function sheet(n, start, gap, extra) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(mkBooking('g' + String(i + 1).padStart(2, '0'), start + i * gap, extra));
  return out;
}
// 反复 step 直到 to,返回全部事件与最终状态(dt 可为数字或返回步长的函数)
function run(state, bookings, from, to, dt, opts) {
  let t = from, events = [];
  let n = 0;
  while (t < to - 1e-9) {
    const d = typeof dt === 'function' ? dt(n++) : (dt || (to - from));
    const next = Math.min(to, t + d);
    const r = Sim.step(state, bookings, t, next, opts);
    state = r.state; events = events.concat(r.events); t = next;
  }
  return { state, events };
}
function byGroup(events) {
  const m = {};
  events.forEach(e => { (m[e.bookingId] = m[e.bookingId] || []).push(e); });
  return m;
}
function evt(events, id, holeNo, type) {
  const e = events.find(x => x.bookingId === id && x.holeNo === holeNo && x.type === type);
  return e ? e.t : undefined;
}
function hole(idx) { return HOLES[idx]; }

// ---------------- RNG ----------------
test('mulberry32: deterministic, in [0,1), state continuation works', () => {
  const a = Sim.mulberry32(42), b = Sim.mulberry32(42);
  const seqA = [], seqB = [];
  for (let i = 0; i < 1000; i++) { seqA.push(a()); seqB.push(b()); }
  assert.deepEqual(seqA, seqB);
  assert.ok(seqA.every(x => x >= 0 && x < 1));
  assert.ok(new Set(seqA).size > 990, 'values vary');
  // 续接:从 a 的状态重建的生成器输出 a 的后续序列
  const c = Sim.mulberry32(7); c(); c();
  const d = Sim.mulberry32(c.state);
  assert.equal(c(), d()); assert.equal(c(), d()); assert.equal(c(), d());
  assert.equal(Sim.mulberry32(7).seed, 7);
  assert.notEqual(Sim.mulberry32(1)(), Sim.mulberry32(2)());
});

test('normal is ~N(0,1); lognormal(rng, 0) == 1 and lognormal is positive', () => {
  const r = Sim.mulberry32(123);
  const N = 40000; let s = 0, s2 = 0;
  for (let i = 0; i < N; i++) { const x = Sim.normal(r); s += x; s2 += x * x; }
  const mean = s / N, varr = s2 / N - mean * mean;
  approx(mean, 0, 0.03, 'mean'); approx(varr, 1, 0.05, 'var');
  assert.equal(Sim.lognormal(Sim.mulberry32(5), 0), 1);
  const r2 = Sim.mulberry32(9);
  for (let i = 0; i < 1000; i++) assert.ok(Sim.lognormal(r2, 0.2) > 0);
});

test('iRecInterval mirrors Pace.iRec pins (0.75→6, 0.85→7, 1.0→8, 1.1→8 / 9 confident, 1.25→10 confident, 1.4→10, override)', () => {
  assert.equal(Sim.iRecInterval({ fPlan: 0.75 }, CFG), 6);
  assert.equal(Sim.iRecInterval({ fPlan: 0.85 }, CFG), 7);
  assert.equal(Sim.iRecInterval({ fPlan: 1.0 }, CFG), 8);
  assert.equal(Sim.iRecInterval(null, CFG), 8);
  assert.equal(Sim.iRecInterval(undefined, CFG), 8);
  assert.equal(Sim.iRecInterval({ fPlan: 1.1, confident: false }, CFG), 8);
  assert.equal(Sim.iRecInterval({ fPlan: 1.1, confident: true }, CFG), 9);
  assert.equal(Sim.iRecInterval({ fPlan: 1.25, confident: true }, CFG), 10);
  assert.equal(Sim.iRecInterval({ fPlan: 1.4, confident: true }, CFG), 10);
  assert.equal(Sim.iRecInterval({ fPlan: 1.0 }, CFG, 9), 9);
});

// ---------------- create / shape ----------------
test('create returns state { rng, groups, holes, cfg, params } with one notStarted group per booking', () => {
  const bookings = sheet(3, 480, 8);
  const st = Sim.create({ holes: HOLES, cfg: CFG, bookings, trueFactorById: { g01: 1.2 }, seed: 1 });
  assert.equal(typeof st.rng, 'function');
  assert.equal(st.holes, HOLES); assert.equal(st.cfg, CFG);
  assert.deepEqual(Object.keys(st.groups).sort(), ['g01', 'g02', 'g03']);
  for (const id in st.groups) {
    assert.equal(st.groups[id].phase, 'notStarted'); assert.equal(st.groups[id].holeIdx, -1);
    assert.ok(st.groups[id].sendNoise >= 0);
  }
  assert.equal(st.params.slowHoleProb, 0.04); assert.deepEqual(st.params.lostBallMin, [4, 12]);
  assert.equal(st.params.trueFactorById.g01, 1.2);
  // 缺省洞/配置时用演示球场
  const st2 = Sim.create({ bookings: [], seed: 3 });
  assert.equal(st2.holes.length, 18); assert.equal(st2.cfg.iBase, 8);
});

// ---------------- determinism ----------------
test('same seed → identical event JSON; different seed → different', () => {
  const bookings = sheet(6, 480, 8);
  const mk = seed => Sim.create({ holes: HOLES, cfg: CFG, bookings, seed, trueFactorById: { g02: 1.3 } });
  const a = run(mk(11), bookings, 470, 900, 1);
  const b = run(mk(11), bookings, 470, 900, 1);
  assert.ok(a.events.length > 6 * 3 * 10, 'plenty of events');
  assert.equal(JSON.stringify(a.events), JSON.stringify(b.events));
  assert.equal(JSON.stringify(Sim.serialize(a.state)), JSON.stringify(Sim.serialize(b.state)));
  const c = run(mk(12), bookings, 470, 900, 1);
  assert.notEqual(JSON.stringify(a.events), JSON.stringify(c.events));
});

test('step never mutates its input state or bookings', () => {
  const bookings = sheet(4, 480, 8);
  const st = Sim.create({ holes: HOLES, cfg: CFG, bookings, seed: 5 });
  const snapState = JSON.stringify(Sim.serialize(st));
  const rngState = st.rng.state;
  const snapBookings = JSON.stringify(bookings);
  const r = Sim.step(st, bookings, 470, 600);
  assert.ok(r.events.length > 10);
  assert.equal(JSON.stringify(Sim.serialize(st)), snapState);
  assert.equal(st.rng.state, rngState);
  assert.equal(JSON.stringify(bookings), snapBookings);
  assert.notEqual(r.state, st);
  assert.notEqual(r.state.groups, st.groups);
  assert.notEqual(r.state.groups.g01, st.groups.g01);
  assert.notEqual(r.state.groups.g01.phase, 'notStarted');
  assert.equal(st.groups.g01.phase, 'notStarted');
});

// ---------------- event invariants ----------------
test('events: source sim, unique ids, valid holeNo, per-group monotone in t and hole/type order', () => {
  const bookings = sheet(10, 480, 8);
  const tf = { g03: 1.4, g05: 0.8, g07: 1.25 };
  const st = Sim.create({ holes: HOLES, cfg: CFG, bookings, seed: 21, trueFactorById: tf, slowHoleProb: 0.2 });
  const { events, state } = run(st, bookings, 470, 1100, 5);
  const ids = new Set();
  const holeNos = new Set(HOLES.map(h => h.no));
  events.forEach(e => {
    assert.equal(e.source, 'sim'); assert.ok(!ids.has(e.id), 'dup id ' + e.id); ids.add(e.id);
    assert.ok(holeNos.has(e.holeNo)); assert.ok(TYPE_RANK[e.type] != null);
    assert.ok(typeof e.t === 'number' && isFinite(e.t));
  });
  // 整体时间单调(事件按处理顺序输出)
  for (let i = 1; i < events.length; i++) assert.ok(events[i].t >= events[i - 1].t - 1e-9);
  const g = byGroup(events);
  bookings.forEach(b => {
    const ev = g[b.id];
    assert.ok(ev && ev.length === 3 * H - 1, b.id + ' has ' + (ev && ev.length) + ' events'); // 第一洞无 arriveTee
    assert.equal(ev[0].type, 'teeOff'); assert.equal(ev[0].holeNo, HOLES[0].no);
    for (let i = 1; i < ev.length; i++) {
      assert.ok(ev[i].t >= ev[i - 1].t - 1e-9, b.id + ' time monotone');
      const hi = HOLES.findIndex(h => h.no === ev[i].holeNo), hp = HOLES.findIndex(h => h.no === ev[i - 1].holeNo);
      const key = hi * 3 + TYPE_RANK[ev[i].type], kp = hp * 3 + TYPE_RANK[ev[i - 1].type];
      assert.ok(key > kp, b.id + ' hole/type order');
    }
    assert.equal(state.groups[b.id].phase, 'done');
    assert.equal(state.groups[b.id].holeIdx, H);
  });
});

test('occupancy: no par-3 teeOff before the group ahead has left the green; minGap and minFollow hold on every hole', () => {
  const bookings = sheet(12, 480, 8);
  const tf = { g02: 1.4, g04: 0.78, g06: 1.3, g09: 0.75 };
  const st = Sim.create({ holes: HOLES, cfg: CFG, bookings, seed: 33, trueFactorById: tf, slowHoleProb: 0.1 });
  const { events, state } = run(st, bookings, 470, 1200, 3);
  let checkedPar3 = 0;
  HOLES.forEach((h, idx) => {
    const tees = events.filter(e => e.holeNo === h.no && e.type === 'teeOff').sort((a, b) => a.t - b.t);
    assert.equal(tees.length, bookings.length);
    for (let i = 1; i < tees.length; i++) {
      const ahead = tees[i - 1], me = tees[i];
      const aheadLeave = evt(events, ahead.bookingId, h.no, 'leaveGreen');
      const myLeave = evt(events, me.bookingId, h.no, 'leaveGreen');
      assert.ok(me.t >= ahead.t + h.minGap - 1e-9, 'minGap on hole ' + h.no);
      // clearFrac 以前组的物理位置(自身洞内用时)衡量;三杆洞(clearFrac 1)还要求前组已离开果岭
      assert.ok(me.t >= ahead.t + h.clearFrac * state.groups[ahead.bookingId].durs[idx] - 1e-9, 'clearFrac on hole ' + h.no);
      // 禁止超车:第 i 洞的开球顺序 == 第 i−1 洞的离开果岭顺序(本场景无让行)
      if (idx > 0) assert.ok(evt(events, ahead.bookingId, HOLES[idx - 1].no, 'leaveGreen') < evt(events, me.bookingId, HOLES[idx - 1].no, 'leaveGreen'), 'no passing on hole ' + h.no);
      assert.ok(myLeave >= aheadLeave + h.minFollow - 1e-9, 'minFollow on hole ' + h.no);
      if (h.par === 3) { assert.ok(me.t >= aheadLeave - 1e-9, 'par-3 teeOff before ahead leaveGreen on hole ' + h.no); checkedPar3++; }
    }
  });
  assert.ok(checkedPar3 >= 4 * 11);
});

test('cold start: consecutive auto-sends are spaced ≥ 8 min; first group tees off at teeMin + noise', () => {
  const bookings = sheet(8, 480, 8);
  const st = Sim.create({ holes: HOLES, cfg: CFG, bookings, seed: 2, slowHoleProb: 0 });   // 无找球:第 1 洞 6 分即清空,不会约束
  const { events, state } = run(st, bookings, 470, 700, 2);
  const tees = bookings.map(b => evt(events, b.id, 1, 'teeOff'));
  tees.forEach(t => assert.ok(t != null));
  approx(tees[0], 480 + state.groups.g01.sendNoise, 1e-9);
  for (let i = 1; i < tees.length; i++) {
    assert.ok(tees[i] - tees[i - 1] >= 8 - 1e-9, 'spacing ' + i + ' = ' + (tees[i] - tees[i - 1]));
    assert.ok(tees[i] >= bookings[i].teeMin - 1e-9, 'never before teeMin');
    // sendAt = max(teeMin, p.teeOff + 8) + noise, and hole 1 (par 4) clears in 6 min < 8 → exactly that
    approx(tees[i], Math.max(bookings[i].teeMin, tees[i - 1] + 8) + state.groups[bookings[i].id].sendNoise, 1e-9);
  }
});

test('plansById: fast group ahead (fPlan 0.85) → next send at p.teeOff + 7 + noise; intervalOverride honoured', () => {
  const bookings = sheet(3, 480, 8);
  const plans = { g01: { fPlan: 0.85, confident: true } };
  const st = Sim.create({ holes: HOLES, cfg: CFG, bookings, seed: 8, trueFactorById: { g01: 0.85 } });
  const { events, state } = run(st, bookings, 470, 600, 1, { plansById: plans });
  const t1 = evt(events, 'g01', 1, 'teeOff'), t2 = evt(events, 'g02', 1, 'teeOff');
  approx(t2, Math.max(488, t1 + 7) + state.groups.g02.sendNoise, 1e-9);
  // override 10 on g01 → g02 waits 10
  const b2 = sheet(3, 480, 8); b2[0].intervalOverride = 10;
  const r2 = run(Sim.create({ holes: HOLES, cfg: CFG, bookings: b2, seed: 8 }), b2, 470, 600, 1, { plansById: plans });
  const u1 = evt(r2.events, 'g01', 1, 'teeOff'), u2 = evt(r2.events, 'g02', 1, 'teeOff');
  approx(u2, Math.max(488, u1 + 10) + r2.state.groups.g02.sendNoise, 1e-9);
});

test('fieldHoldMin shifts auto-send (step opts override create params)', () => {
  const bookings = sheet(2, 480, 8);
  const st = Sim.create({ holes: HOLES, cfg: CFG, bookings, seed: 4, fieldHoldMin: 5 });
  const a = Sim.step(st, bookings, 470, 520);
  approx(evt(a.events, 'g01', 1, 'teeOff'), 485 + st.groups.g01.sendNoise, 1e-9);
  const b = Sim.step(st, bookings, 470, 520, { fieldHoldMin: 20 });
  approx(evt(b.events, 'g01', 1, 'teeOff'), 500 + st.groups.g01.sendNoise, 1e-9);
  approx(evt(b.events, 'g02', 1, 'teeOff'), Math.max(508, evt(b.events, 'g01', 1, 'teeOff') + 8) + st.groups.g02.sendNoise, 1e-9);
});

test('autoSend === false is never auto-sent; groups behind it are still sent (p = last group that teed off)', () => {
  const bookings = sheet(4, 480, 8);
  bookings[1].autoSend = false;
  const st = Sim.create({ holes: HOLES, cfg: CFG, bookings, seed: 6 });
  const { events, state } = run(st, bookings, 470, 1000, 1);
  assert.equal(events.filter(e => e.bookingId === 'g02').length, 0);
  assert.equal(state.groups.g02.phase, 'notStarted');
  const t1 = evt(events, 'g01', 1, 'teeOff'), t3 = evt(events, 'g03', 1, 'teeOff'), t4 = evt(events, 'g04', 1, 'teeOff');
  assert.ok(t1 != null && t3 != null && t4 != null);
  approx(t3, Math.max(496, t1 + 8) + state.groups.g03.sendNoise, 1e-9);
  assert.ok(t4 >= t3 + 8 - 1e-9);
});

test('status noShow/cancelled/merged/finished are ignored (never sent, never advanced)', () => {
  const bookings = sheet(5, 480, 8);
  bookings[0].status = 'noShow'; bookings[1].status = 'cancelled'; bookings[2].status = 'merged'; bookings[3].status = 'finished';
  const st = Sim.create({ holes: HOLES, cfg: CFG, bookings, seed: 6 });
  const { events, state } = run(st, bookings, 470, 1000, 1);
  ['g01', 'g02', 'g03', 'g04'].forEach(id => {
    assert.equal(events.filter(e => e.bookingId === id).length, 0, id);
    assert.equal(state.groups[id].phase, 'notStarted');
  });
  assert.equal(state.groups.g05.phase, 'done');
  approx(evt(events, 'g05', 1, 'teeOff'), 512 + state.groups.g05.sendNoise, 1e-9);
  // 球组中途被取消 → 后组不再被它阻挡
  const b2 = sheet(2, 480, 8); b2[0] = mkBooking('g01', 480); b2[1] = mkBooking('g02', 486);
  const tf = { g01: 1.4 };
  let s2 = Sim.create({ holes: HOLES, cfg: CFG, bookings: b2, seed: 9, trueFactorById: tf });
  let r = Sim.step(s2, b2, 470, 560); // both on course, g02 held behind slow g01
  const cancelled = b2.map(b => b.id === 'g01' ? Object.assign({}, b, { status: 'cancelled' }) : b);
  const r2 = run(r.state, cancelled, 560, 1000, 1);
  const g1Events = r2.events.filter(e => e.bookingId === 'g01');
  assert.equal(g1Events.length, 0);
  assert.equal(r2.state.groups.g02.phase, 'done');
  // g02 after the cancel waits for nobody: on every later hole teeOff == arriveTee
  r2.events.filter(e => e.bookingId === 'g02' && e.type === 'teeOff' && e.t > 560).forEach(e => {
    const arr = evt(r2.events, 'g02', e.holeNo, 'arriveTee');
    if (arr != null && arr > 560) approx(e.t, arr, 1e-9, 'hole ' + e.holeNo);
  });
});

test('slow group (trueFactor 1.4) delays the group behind: it waits on tees and finishes later than alone', () => {
  const two = [mkBooking('A', 480), mkBooking('B', 488)];
  const alone = [mkBooking('B', 488)];
  const tf = { A: 1.4, B: 1.0 };
  const r1 = run(Sim.create({ holes: HOLES, cfg: CFG, bookings: two, seed: 77, trueFactorById: tf, slowHoleProb: 0 }), two, 470, 1000, 1);
  const r2 = run(Sim.create({ holes: HOLES, cfg: CFG, bookings: alone, seed: 77, trueFactorById: tf, slowHoleProb: 0 }), alone, 470, 1000, 1);
  // 子流按发球表顺序派发:单独运行时 B 是第一组,拿到的是 A 的种子;因此用 B 的用时判断,而非逐事件比较
  const waitB = HOLES.slice(1).reduce((s, h) => s + Math.max(0, evt(r1.events, 'B', h.no, 'teeOff') - evt(r1.events, 'B', h.no, 'arriveTee')), 0);
  assert.ok(waitB > 30, 'B waits a lot behind slow A: ' + waitB);
  const roundB = evt(r1.events, 'B', 18, 'leaveGreen') - evt(r1.events, 'B', 1, 'teeOff');
  const roundAlone = evt(r2.events, 'B', 18, 'leaveGreen') - evt(r2.events, 'B', 1, 'teeOff');
  assert.ok(roundB > roundAlone + 30, 'behind: ' + roundB + ' alone: ' + roundAlone);
  // A is never held by B
  HOLES.slice(1).forEach(h => approx(evt(r1.events, 'A', h.no, 'teeOff'), evt(r1.events, 'A', h.no, 'arriveTee'), 1e-9, 'A hole ' + h.no));
  // B's round ≈ A's pace: finishes shortly after A
  const finA = evt(r1.events, 'A', 18, 'leaveGreen'), finB = evt(r1.events, 'B', 18, 'leaveGreen');
  assert.ok(finB >= finA + 1 - 1e-9 && finB < finA + 20, 'B glued to A at the end: ' + (finB - finA));
});

test('yield (play-through): B.teeOff(6) < A.teeOff(6) and A.teeOff(6) ≥ B.teeOff(6) + minGap; without it A leads', () => {
  const tf = { A: 1.4, B: 1.0 };
  const base = [mkBooking('A', 480), mkBooking('B', 488)];
  // 无让行:A 全程领先
  const r0 = run(Sim.create({ holes: HOLES, cfg: CFG, bookings: base, seed: 5, trueFactorById: tf, slowHoleProb: 0 }), base, 470, 1000, 1);
  assert.ok(evt(r0.events, 'A', 6, 'teeOff') < evt(r0.events, 'B', 6, 'teeOff'));
  // 让行在第 5 洞被接受(A 在打第 5 洞时),fromHoleIdx = 5(第 6 洞)
  let st = Sim.create({ holes: HOLES, cfg: CFG, bookings: base, seed: 5, trueFactorById: tf, slowHoleProb: 0 });
  let events = [];
  let t = 470;
  let accepted = null;
  while (t < 1000) {
    const bookings = accepted ? base.map(b => b.id === 'A' ? Object.assign({}, b, { playThrough: accepted }) : b) : base;
    const r = Sim.step(st, bookings, t, t + 1);
    st = r.state; events = events.concat(r.events); t += 1;
    if (!accepted && st.groups.A.phase === 'playing' && st.groups.A.holeIdx === 4) {
      accepted = { suggestedAt: t - 2, decision: 'accepted', decidedAt: t, behindId: 'B', fromHoleIdx: 5 };
    }
  }
  assert.ok(accepted, 'scenario reached hole 5');
  const a6 = evt(events, 'A', 6, 'teeOff'), b6 = evt(events, 'B', 6, 'teeOff');
  assert.ok(b6 < a6, 'B tees off hole 6 first: ' + b6 + ' vs ' + a6);
  assert.ok(a6 >= b6 + hole(5).minGap - 1e-9, 'A waits minGap behind B');
  assert.ok(a6 >= b6 + hole(5).clearFrac * (evt(events, 'B', 6, 'leaveGreen') - b6) - 1e-9);
  // 之后 B 领先且 A 受 minFollow 约束;B 不再等待
  assert.ok(evt(events, 'A', 6, 'leaveGreen') >= evt(events, 'B', 6, 'leaveGreen') + hole(5).minFollow - 1e-9);
  HOLES.slice(6).forEach(h => assert.ok(evt(events, 'B', h.no, 'teeOff') < evt(events, 'A', h.no, 'teeOff'), 'B ahead on ' + h.no));
  HOLES.slice(6).forEach(h => approx(evt(events, 'B', h.no, 'teeOff'), evt(events, 'B', h.no, 'arriveTee'), 1e-9, 'B free on ' + h.no));
  // 让行前(第 1–5 洞)A 领先
  HOLES.slice(0, 5).forEach(h => assert.ok(evt(events, 'A', h.no, 'teeOff') < evt(events, 'B', h.no, 'teeOff')));
  assert.equal(st.groups.A.phase, 'done'); assert.equal(st.groups.B.phase, 'done');
  // 让行目标已不在场上(取消)→ 不等待
  const b3 = [Object.assign(mkBooking('A', 480), { playThrough: { decision: 'accepted', behindId: 'B', fromHoleIdx: 5 } }), mkBooking('B', 488, { status: 'cancelled' })];
  const r3 = run(Sim.create({ holes: HOLES, cfg: CFG, bookings: b3, seed: 5, trueFactorById: tf }), b3, 470, 1000, 1);
  assert.equal(r3.state.groups.A.phase, 'done');
  approx(evt(r3.events, 'A', 6, 'teeOff'), evt(r3.events, 'A', 6, 'arriveTee'), 1e-9);
});

test('one large step == many small steps == irregular steps (same seed): identical events and group states', () => {
  const bookings = sheet(12, 480, 8);
  bookings[5].autoSend = false;
  const tf = { g02: 1.35, g04: 0.8, g08: 1.2 };
  const mk = () => Sim.create({ holes: HOLES, cfg: CFG, bookings, seed: 99, trueFactorById: tf, slowHoleProb: 0.15 });
  const big = Sim.step(mk(), bookings, 380, 1100);
  const small = run(mk(), bookings, 380, 1100, 1);
  const sixty = run(mk(), bookings, 380, 1100, 60);
  const odd = run(mk(), bookings, 380, 1100, n => [0.3, 7.25, 1, 13.9, 0.05, 2.5][n % 6]);
  assert.ok(big.events.length > 11 * 50);
  const norm = s => JSON.stringify(Object.assign(Sim.serialize(s), { now: null }));
  assert.equal(JSON.stringify(small.events), JSON.stringify(big.events));
  assert.equal(JSON.stringify(sixty.events), JSON.stringify(big.events));
  assert.equal(JSON.stringify(odd.events), JSON.stringify(big.events));
  assert.equal(norm(small.state), norm(big.state));
  assert.equal(norm(odd.state), norm(big.state));
  assert.equal(norm(sixty.state), norm(big.state));
});

test('a 60-min step at ×60 speed timestamps events inside (fromMin, toMin], not at the boundaries', () => {
  const bookings = sheet(8, 480, 8);
  const st = Sim.create({ holes: HOLES, cfg: CFG, bookings, seed: 3 });
  const r = Sim.step(st, bookings, 470, 530);
  assert.ok(r.events.length > 20);
  r.events.forEach(e => assert.ok(e.t > 470 && e.t <= 530 + 1e-9));
  const distinct = new Set(r.events.map(e => Math.floor(e.t)));
  assert.ok(distinct.size > 10, 'spread over the hour');
  // 第二步继续,无重复事件
  const r2 = Sim.step(r.state, bookings, 530, 590);
  const ids = new Set(r.events.map(e => e.id));
  r2.events.forEach(e => { assert.ok(!ids.has(e.id)); assert.ok(e.t > 530 && e.t <= 590 + 1e-9); });
  // fromMin > toMin / 空步:无事件,状态复制
  const r3 = Sim.step(r.state, bookings, 600, 590);
  assert.equal(r3.events.length, 0);
  assert.equal(JSON.stringify(Sim.serialize(r3.state).groups), JSON.stringify(Sim.serialize(r.state).groups));
});

test('hole duration = std × trueFactor × lognormal; lost ball adds U(4,12) with prob slowHoleProb', () => {
  const one = [mkBooking('A', 480)];
  const mk = prob => Sim.create({ holes: HOLES, cfg: CFG, bookings: one, seed: 17, trueFactorById: { A: 1.2 }, slowHoleProb: prob });
  const clean = run(mk(0), one, 470, 1100, 1), lost = run(mk(1), one, 470, 1100, 1);
  let total = 0;
  HOLES.forEach((h, i) => {
    const d0 = evt(clean.events, 'A', h.no, 'leaveGreen') - evt(clean.events, 'A', h.no, 'teeOff');
    const d1 = evt(lost.events, 'A', h.no, 'leaveGreen') - evt(lost.events, 'A', h.no, 'teeOff');
    // 单独一组:无人压住,用时即 durs;σ=0.12 → 在 ±4σ 内
    assert.ok(d0 > h.std * 1.2 * Math.exp(-0.5) && d0 < h.std * 1.2 * Math.exp(0.5), 'dur hole ' + h.no + ' = ' + d0);
    approx(clean.state.groups.A.durs[i], d0, 1e-9);
    const extra = d1 - d0;
    assert.ok(extra >= 4 - 1e-9 && extra <= 12 + 1e-9, 'lost ball extra on hole ' + h.no + ' = ' + extra);
    approx(lost.state.groups.A.lostMin[i], extra, 1e-9);
    assert.equal(clean.state.groups.A.lostMin[i], undefined);
    total += d0;
  });
  approx(total / 1.2, 198, 25, 'sum of standard times ≈ 198');
  // 转场:arriveTee − leaveGreen(prev) = transit × lognormal(0.2)
  HOLES.slice(1).forEach((h, k) => {
    const tr = evt(clean.events, 'A', h.no, 'arriveTee') - evt(clean.events, 'A', HOLES[k].no, 'leaveGreen');
    assert.ok(tr > h.transit * Math.exp(-1) && tr < h.transit * Math.exp(1), 'transit hole ' + h.no + ' = ' + tr);
  });
});

test('operator-driven tee-off (status onCourse + teeOffActual) is adopted without a sim teeOff event', () => {
  const bookings = [mkBooking('A', 480, { status: 'onCourse', teeOffActual: 478, autoSend: false }), mkBooking('B', 488)];
  const st = Sim.create({ holes: HOLES, cfg: CFG, bookings, seed: 12 });
  assert.equal(st.groups.A.phase, 'playing'); assert.equal(st.groups.A.teeOffActual, 478); assert.equal(st.groups.A.starts[0], 478);
  const { events, state } = run(st, bookings, 480, 1000, 1);
  assert.equal(evt(events, 'A', 1, 'teeOff'), undefined);
  assert.ok(evt(events, 'A', 1, 'leaveGreen') > 480);
  assert.equal(state.groups.A.phase, 'done');
  // B 的 sendAt 以 A 的实际开球 478 为前组
  approx(evt(events, 'B', 1, 'teeOff'), Math.max(488, 478 + 8) + state.groups.B.sendNoise, 1e-9);
  // 也可在 step 中途接管(值班员在 sim 已知该组为未开球时按下开球)
  const b2 = [mkBooking('A', 480, { autoSend: false }), mkBooking('B', 488)];
  let s2 = Sim.create({ holes: HOLES, cfg: CFG, bookings: b2, seed: 12 });
  let r = Sim.step(s2, b2, 470, 483);
  assert.equal(r.state.groups.A.phase, 'notStarted');
  const teed = [Object.assign({}, b2[0], { status: 'onCourse', teeOffActual: 483 }), b2[1]];
  const r2 = run(r.state, teed, 483, 1000, 1);
  assert.equal(r2.state.groups.A.teeOffActual, 483);
  assert.equal(evt(r2.events, 'A', 1, 'teeOff'), undefined);
  assert.equal(r2.state.groups.A.phase, 'done');
  // 新增预订(中途加入)也会被注册并自动开球
  const added = teed.concat([mkBooking('C', 500)]);
  const r3 = run(r.state, added, 483, 1000, 1);
  assert.equal(r3.state.groups.C.phase, 'done');
  assert.ok(evt(r3.events, 'C', 1, 'teeOff') >= evt(r3.events, 'B', 1, 'teeOff') + 8 - 1e-9);
});

test('serialize/deserialize round trip continues the exact same event stream', () => {
  const bookings = sheet(6, 480, 8);
  const tf = { g03: 1.3 };
  const st = Sim.create({ holes: HOLES, cfg: CFG, bookings, seed: 31, trueFactorById: tf });
  const full = run(st, bookings, 470, 900, 5);
  const half = run(st, bookings, 470, 600, 5);
  const json = JSON.stringify(Sim.serialize(half.state));
  const restored = Sim.deserialize(JSON.parse(json), { holes: HOLES, cfg: CFG });
  assert.equal(typeof restored.rng, 'function');
  assert.equal(restored.params.trueFactorById.g03, 1.3);
  const rest = run(restored, bookings, 600, 900, 5);
  assert.equal(JSON.stringify(half.events.concat(rest.events)), JSON.stringify(full.events));
  const norm = s => JSON.stringify(Sim.serialize(s));
  assert.equal(norm(rest.state), norm(full.state));
});

test('sub-18 routing (9 holes) works and does not hard-code 18', () => {
  const nine = HOLES.slice(0, 9);
  const bookings = sheet(3, 480, 8);
  const st = Sim.create({ holes: nine, cfg: CFG, bookings, seed: 2 });
  const { events, state } = run(st, bookings, 470, 800, 1);
  bookings.forEach(b => {
    assert.equal(state.groups[b.id].phase, 'done'); assert.equal(state.groups[b.id].holeIdx, 9);
    assert.equal(events.filter(e => e.bookingId === b.id).length, 9 * 3 - 1);
    assert.ok(events.every(e => e.holeNo <= 9));
  });
});
