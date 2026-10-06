'use strict';
// 跨模块集成:Sim 产生事件 → (模拟 Store 的状态更新) → Live.buildCtx/evaluate 每分钟一次 → Learn.observeRound 评分。
// 场景:6 组 06:30 起 8 分钟间隔;第 3 组 trueFactor 1.35(慢组),第 4 组 1.0 紧随其后。
const { test, assert, approx } = require('./_harness.js');
const Course = require('../js/course.js');
const Pace = require('../js/pace.js');
const Live = require('../js/live.js');
const Learn = require('../js/learn.js');
const Sim = require('../js/sim.js');

const course = Course.normalizeCourse({ holes: Course.demoLayout() });
const holes = course.holes;
const cfg = course.config;
const H = holes.length;
const D = '2026-10-06';
const SLOW_ID = 'g3', BEHIND_ID = 'g4';
const TRUE_FACTOR = { g1: 1.0, g2: 0.95, g3: 1.35, g4: 1.0, g5: 1.0, g6: 0.9 };

function mkSheet() {
  return { courseId: 'demo', date: D, routingId: 'r18', openMin: 390, closeMin: 960, peakMode: false, fieldHoldMin: 0, seq: 0 };
}
function mkBooking(id, teeMin, names) {
  return { id, date: D, routingId: 'r18', teeMin, size: names.length, caddieIds: [],
    players: names.map((n, i) => ({ id: id + 'p' + i, name: n, isMember: i === 0 })),
    status: 'booked', allowMerge: true, notes: '', createdAt: 0, version: 1 };
}
function mkBookings() {
  return [
    mkBooking('g1', 390, ['张伟', '李娜', '王强', '刘洋']),
    mkBooking('g2', 398, ['陈静', '杨帆', '赵敏', '周杰']),
    mkBooking('g3', 406, ['吴昊', '郑爽', '孙莉', '朱琳']),
    mkBooking('g4', 414, ['何伟', '林峰', '高原', '马丽']),
    mkBooking('g5', 422, ['黄磊', '徐静']),
    mkBooking('g6', 430, ['罗宇', '梁静', '谢晖'])
  ];
}

const SPEC_FIELDS = ['bookingId', 'holeIdx', 'holeNo', 'phase', 'teeDelay', 'lag', 'openAhead', 'effLag', 'level', 'since', 'cause',
  'snoozed', 'holesAhead', 'aheadId', 'behindId', 'holdCount', 'priority', 'remainingMin', 'overMin', 'etaRoundMin', 'nextTeeEta',
  'playThroughSuggested', 'behindWaiting'];

function findNaN(o, p, out) {
  if (o === null || typeof o !== 'object') { if (typeof o === 'number' && isNaN(o)) out.push(p); return; }
  if (Array.isArray(o)) { o.forEach((x, i) => findNaN(x, p + '[' + i + ']', out)); return; }
  for (const k in o) findNaN(o[k], p + '.' + k, out);
}

// 像 Store.tick 一样推进:每分钟 Sim.step(plansById 来自 buildCtx)→ 应用事件到预订状态 → evaluate → 保存 alerts、应用 patches
function runScenario(opts) {
  opts = opts || {};
  const sheet = mkSheet();
  const bookings = mkBookings();
  const toMin = opts.toMin || 960;
  let sim = Sim.create({ holes, cfg, bookings, trueFactorById: TRUE_FACTOR, seed: opts.seed == null ? 7 : opts.seed,
    slowHoleProb: opts.slowHoleProb == null ? 0.04 : opts.slowHoleProb });
  let events = [];
  let alerts = {};
  let now = 380;
  const seen = { red: {}, ahead: {}, ptSuggested: {}, ptPatch: {}, maxLag: {}, firstRedAt: {} };
  const problems = [];
  let ticks = 0, evaluations = 0;
  while (now < toMin) {
    const ctxPre = Live.buildCtx({ course, sheet, bookings, events, paceStats: {} }, now, alerts);
    const r = Sim.step(sim, bookings, now, now + 1, { fieldHoldMin: sheet.fieldHoldMin, plansById: ctxPre.plansById });
    sim = r.state;
    events = events.concat(r.events);
    r.events.forEach(e => {
      const b = bookings.find(x => x.id === e.bookingId);
      if (e.type === 'teeOff' && e.holeNo === holes[0].no && b.status !== 'onCourse' && b.status !== 'finished') {
        Object.assign(b, { status: 'onCourse', teeOffActual: e.t, autoSend: false });
      }
      if (e.type === 'leaveGreen' && e.holeNo === holes[H - 1].no && b.status === 'onCourse') {
        Object.assign(b, { status: 'finished', finishedAt: e.t });
      }
    });
    now += 1; ticks++;
    const ctx = Live.buildCtx({ course, sheet, bookings, events, paceStats: {} }, now, alerts);
    const res = Live.evaluate(ctx);          // 任何 throw 直接让用例失败
    evaluations++;
    alerts = res.alerts;
    // 输出健全性:无 NaN;场上组的 SPEC 字段均有定义;order 与 groups 一致
    findNaN({ groups: res.groups, fieldDelayMin: res.fieldDelayMin, alerts: res.alerts, patches: res.patches, projections: res.projections.list }, 'res', problems);
    res.groups.forEach(g => {
      if (g.phase !== 'playing' && g.phase !== 'between') return;
      SPEC_FIELDS.forEach(k => { if (g[k] === undefined) problems.push('t=' + now + ' ' + g.bookingId + '.' + k + ' undefined'); });
      if (res.order.indexOf(g.bookingId) < 0) problems.push('t=' + now + ' ' + g.bookingId + ' on course but not in order');
      if (g.level === 'red') { seen.red[g.bookingId] = true; if (seen.firstRedAt[g.bookingId] == null) seen.firstRedAt[g.bookingId] = now; }
      if (g.cause === 'AHEAD') seen.ahead[g.bookingId] = true;
      if (g.playThroughSuggested) seen.ptSuggested[g.bookingId] = true;
      seen.maxLag[g.bookingId] = Math.max(seen.maxLag[g.bookingId] == null ? -Infinity : seen.maxLag[g.bookingId], g.lag);
    });
    res.order.forEach((id, i) => {
      const g = res.byId[id];
      if (!g) problems.push('t=' + now + ' order id ' + id + ' missing in byId');
      else {
        if (g.aheadId !== (i > 0 ? res.order[i - 1] : null)) problems.push('t=' + now + ' ' + id + ' aheadId mismatch');
        if (g.behindId !== (i + 1 < res.order.length ? res.order[i + 1] : null)) problems.push('t=' + now + ' ' + id + ' behindId mismatch');
      }
    });
    for (const id in res.patches) {
      if (res.patches[id].playThrough) {
        if (res.patches[id].playThrough.suggestedAt === now) seen.ptPatch[id] = true;
        bookings.find(x => x.id === id).playThrough = res.patches[id].playThrough;
      }
    }
  }
  return { sim, bookings, events, alerts, seen, problems, ticks, evaluations, now };
}

test('integration: Sim → Live 06:20–16:00, 1-min ticks — every group finishes before 16:00; evaluate never throws; no NaN/undefined', () => {
  const r = runScenario({ toMin: 960 });
  assert.equal(r.ticks, 580); assert.equal(r.evaluations, 580);
  assert.deepEqual(r.problems, []);
  r.bookings.forEach(b => {
    assert.equal(b.status, 'finished', b.id + ' status ' + b.status);
    assert.ok(b.teeOffActual >= b.teeMin - 1e-9, b.id + ' teed off at/after teeMin');
    assert.ok(b.finishedAt < 960, b.id + ' finished at ' + Course.fmtHM(b.finishedAt));
    assert.equal(r.sim.groups[b.id].phase, 'done');
    assert.equal(r.events.filter(e => e.bookingId === b.id).length, 3 * H - 1);
  });
  // 慢组(1.35)最终进入红色;紧随其后的 1.0 组在某一时刻被判为 AHEAD(被前组阻挡)
  assert.equal(r.seen.red[SLOW_ID], true, 'slow group reached red');
  assert.equal(r.seen.ahead[BEHIND_ID], true, 'group behind the slow group had cause AHEAD');
  assert.ok(r.seen.maxLag[SLOW_ID] > 30, 'slow group lag grows past 30: ' + r.seen.maxLag[SLOW_ID]);
  // 终局:全部完成后 evaluate 不再有场上组
  const end = Live.evaluate(Live.buildCtx({ course, sheet: mkSheet(), bookings: r.bookings, events: r.events, paceStats: {} }, 960, r.alerts));
  assert.deepEqual(end.order, []); assert.deepEqual(end.groups, []); assert.equal(end.fieldDelayMin, 0);
});

test('integration (no lost balls): slow 1.35 group goes red before 09:00 with the group behind glued (AHEAD) and a play-through suggestion; a 0.95 group stays below red; same seed → identical run', () => {
  const r = runScenario({ toMin: 600, slowHoleProb: 0 });
  assert.deepEqual(r.problems, []);
  assert.equal(r.seen.red[SLOW_ID], true);
  assert.ok(r.seen.firstRedAt[SLOW_ID] < 540, 'red before 09:00: ' + Course.fmtHM(r.seen.firstRedAt[SLOW_ID]));
  assert.equal(r.seen.ahead[BEHIND_ID], true);
  assert.equal(r.seen.red[BEHIND_ID], undefined, 'glued group is not blamed while the slow group is directly ahead');
  assert.equal(r.seen.red.g2, undefined, '0.95 group never red without lost balls');
  // 让行建议:慢组红 + 后组贴身 → evaluate 发出 patch 并在卡片上显示
  assert.equal(r.seen.ptPatch[SLOW_ID], true);
  assert.equal(r.seen.ptSuggested[SLOW_ID], true);
  const pt = r.bookings.find(b => b.id === SLOW_ID).playThrough;
  assert.ok(pt && pt.suggestedAt > 0 && pt.behindId === BEHIND_ID, JSON.stringify(pt));
  // 场上顺序与物理顺序一致:同一时刻慢组在前、后组在后
  const last = Live.evaluate(Live.buildCtx({ course, sheet: mkSheet(), bookings: r.bookings, events: r.events, paceStats: {} }, 600, r.alerts));
  assert.ok(last.order.indexOf(SLOW_ID) < last.order.indexOf(BEHIND_ID));
  assert.ok(last.byId[SLOW_ID].holeIdx >= last.byId[BEHIND_ID].holeIdx);
  // 巡查列表:慢组(红/OWN)排在被阻挡的后组之前;客户端快照不泄露他组身份;并组建议在全员场上时为空且不抛
  const ml = Live.marshalList(last);
  assert.ok(ml.length >= 2);
  assert.equal(ml[0].bookingId, SLOW_ID);
  assert.ok(ml.some(g => g.bookingId === BEHIND_ID && g.cause === 'AHEAD'));
  const meB = r.bookings.find(b => b.id === BEHIND_ID);
  const snap = Live.clientSnapshot(last, r.bookings, holes, { bookingId: BEHIND_ID, userId: meB.players[0].id, role: 'player' }, new Set(), 600);
  assert.equal(snap.me.cause, 'AHEAD'); assert.equal(snap.me.level, 'green');
  assert.deepEqual(snap.aheadGroup, { holeNo: last.byId[SLOW_ID].holeNo, phase: last.byId[SLOW_ID].phase });
  const others = JSON.stringify(snap.holes);
  r.bookings.filter(b => b.id !== BEHIND_ID).forEach(b => {
    b.players.forEach(p => assert.ok(!others.includes(p.name) && !others.includes(p.id), 'leak ' + p.name));
    assert.ok(!others.includes('"' + b.id + '"'), 'leak ' + b.id);
  });
  assert.equal(snap.holes.reduce((n, h) => n + h.groups.length, 0), last.order.length);
  const Merge = require('../js/merge.js');
  const ctxM = Live.buildCtx({ course, sheet: mkSheet(), bookings: r.bookings, events: r.events, paceStats: {} }, 600, r.alerts);
  assert.deepEqual(Merge.suggest({ sheet: Object.assign(mkSheet(), { peakMode: true }), bookings: r.bookings, holes, cfg, plansById: ctxM.plansById,
    statsById: {}, friendsOf: () => new Set(), now: 600, waitlistLen: 0, progressById: {}, order: last.order }), []);
  // 确定性
  const r2 = runScenario({ toMin: 600, slowHoleProb: 0 });
  assert.equal(JSON.stringify(r2.events), JSON.stringify(r.events));
  assert.equal(JSON.stringify(r2.alerts), JSON.stringify(r.alerts));
  assert.equal(JSON.stringify(r2.bookings), JSON.stringify(r.bookings));
});

test('integration: Sim events feed Learn.observeRound — the slow group scores fRound ≈ 1.35; a glued group has held holes', () => {
  const r = runScenario({ toMin: 960, slowHoleProb: 0 });
  const byBooking = {};
  r.events.forEach(e => { (byBooking[e.bookingId] = byBooking[e.bookingId] || []).push(e); });
  const ctx = Live.buildCtx({ course, sheet: mkSheet(), bookings: r.bookings, events: r.events, paceStats: {} }, 960, {});
  // 前组 = 发球表上前一组(本场景无让行,物理顺序即发球顺序)
  const ids = r.bookings.map(b => b.id);
  const obs = {};
  ids.forEach((id, i) => {
    obs[id] = Learn.observeRound(holes, r.bookings[i], byBooking[id], i > 0 ? byBooking[ids[i - 1]] : [], ctx.plansById[id].f, cfg);
    assert.equal(obs[id].observations.length, H);
    obs[id].observations.forEach(o => { assert.equal(o.bookingId, id); assert.equal(o.date, D); assert.ok(o.held || (o.ratio >= 0.5 && o.ratio <= 2)); });
  });
  assert.ok(obs[SLOW_ID].cleanHoles >= cfg.minCleanHoles, 'slow group clean holes: ' + obs[SLOW_ID].cleanHoles);
  approx(obs[SLOW_ID].fRound, 1.35, 0.12, 'slow group fRound');
  assert.ok(obs.g1.fRound != null); approx(obs.g1.fRound, 1.0, 0.12, 'leader fRound');
  // 贴身组:大量被阻挡的洞(发球台等待 > 1 分或紧随前组离岭)
  const heldBehind = obs[BEHIND_ID].observations.filter(o => o.held).length;
  assert.ok(heldBehind >= 6, 'held holes behind the slow group: ' + heldBehind);
  // 评分后球员因子向真实步速移动
  const s = Learn.updatePlayer(null, obs[SLOW_ID].fRound, D, cfg);
  assert.ok(s.f > 1.2 && s.f <= cfg.fMax); assert.equal(s.nEff, 1); assert.equal(s.roundsScored, 1);
  const plan = Pace.groupPlan(r.bookings[2].players, { g3p0: Object.assign({ playerId: 'g3p0' }, s) }, cfg, D, 4);
  assert.ok(plan.fPlan > 1 && plan.fPlan < s.f, 'fPlan shrinks toward 1 (one known slow player): ' + plan.fPlan);
});
