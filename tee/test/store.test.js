'use strict';
// Store(SPEC §8):LocalDataSource 演示闭环(Map 存储、不启动时钟、tick 到 12:00)、命令表、租约、评分隐私、ApiDataSource 回退。
const { test, assert, approx } = require('./_harness.js');
const Course = require('../js/course.js');
const Store = require('../js/store.js');

const D = '2026-10-06';
const FIXED_MS = 1700000000000;
const SLOW = 'b0736', BEHIND = 'b0744', PERSONA = 'b0800', FAST = 'b0816', NOSHOW = 'b0904', LATE = 'b0920', MERGE_A = 'b1040', MERGE_B = 'b1048';

function mkStore(extra) {
  const opts = Object.assign({ date: D, seed: 1, storage: new Map(), startClock: false, wallClock: () => FIXED_MS }, extra || {});
  const s = Store.createLocal(opts);
  return s.load(D).then(() => s);
}
function find(st, id) { return st.bookings.find(b => b.id === id); }
function tickTo(s, min, onTick) {
  const st = s.getState();
  let guard = 0;
  while (st.now < min - 1e-9 && guard++ < 5000) { s.demo.tick(Math.min(1, min - st.now)); if (onTick) onTick(st); }
}
async function rejects(promise, code) {
  try { await promise; } catch (e) { assert.equal(e.code, code, 'expected code ' + code + ', got ' + e.code + ' (' + e.message + ')'); return e; }
  assert.fail('expected rejection with code ' + code);
}

// ---------- demoSeed ----------
test('store: demoSeed pins — 演示球场, peakMode, 26 morning bookings on the 8-min grid + an afternoon merge pair, every SPEC §8.3 pin present', () => {
  const s = Store.demoSeed(D, 1);
  const by0 = id => s.bookings.find(b => b.id === id);
  assert.equal(s.course.name, '演示球场');
  assert.equal(s.course.holes.length, 18);
  assert.equal(s.sheet.peakMode, true); assert.equal(s.sheet.openMin, 390); assert.equal(s.sheet.closeMin, 960);
  assert.ok(s.bookings.length >= 24 && s.bookings.length <= 28, 'bookings ' + s.bookings.length);
  const tees = s.bookings.map(b => b.teeMin);
  tees.forEach(t => { assert.equal(t % 8, 0); assert.ok(t >= 390 && t <= 800); });
  assert.ok(by0('b1304') && by0('b1312'), 'afternoon merge pair 13:04 / 13:12 present');
  assert.equal(new Set(tees).size, tees.length, 'no duplicate slots');
  assert.ok(tees.length < 34, 'has gaps');
  const by = {}; s.bookings.forEach(b => { by[b.id] = b; });
  // 慢 4 人组 07:36(普通,无步速数据,真实 1.35)+ 标准 4 人组 07:44
  assert.equal(by[SLOW].teeMin, 456); assert.equal(by[SLOW].size, 4);
  assert.ok(by[SLOW].players.every(p => !p.isMember)); assert.ok(by[SLOW].players.every(p => !s.paceStats[p.id]));
  assert.equal(s.trueFactorById[SLOW], 1.35);
  assert.equal(by[BEHIND].teeMin, 464); assert.equal(by[BEHIND].size, 4); assert.equal(s.trueFactorById[BEHIND], 1.0);
  // 两位快打常客 08:16
  assert.equal(by[FAST].size, 2);
  by[FAST].players.forEach(p => {
    const ps = s.paceStats[p.id];
    assert.ok(ps, 'pace stats for fast player'); assert.equal(ps.playerId, p.id);
    approx(ps.f, 0.85); assert.equal(ps.nEff, 4); assert.equal(ps.roundsScored, 4); assert.equal(ps.lastRoundDate, Store.addDays(D, -7));
    assert.equal(p.isMember, false);
  });
  assert.equal(Store.addDays(D, -7), '2026-09-29');
  // 并组候选 10:40(2 人)+ 10:48(1 人)
  assert.equal(by[MERGE_A].size, 2); assert.equal(by[MERGE_B].size, 1);
  assert.ok(by[MERGE_A].allowMerge && by[MERGE_B].allowMerge);
  assert.ok(by[MERGE_A].players.concat(by[MERGE_B].players).every(p => !p.isMember && !s.paceStats[p.id]));
  // 未到 09:04 / 迟到 09:20
  assert.equal(by[NOSHOW].autoSend, false); assert.equal(by[NOSHOW].checkInAt, null);
  assert.equal(by[LATE].autoSend, false); assert.equal(by[LATE].checkInAt, 560 + 12);
  // 其余预订 teeMin − U(5, 25) 自动签到
  s.bookings.filter(b => b.id !== NOSHOW && b.id !== LATE).forEach(b => { assert.ok(b.checkInAt >= b.teeMin - 25 && b.checkInAt <= b.teeMin - 5, b.id); });
  // 球童 7 / 12 / 17,17 分配给 08:00 组
  assert.deepEqual(s.caddies.map(c => c.no), ['7', '12', '17']);
  assert.equal(s.caddies.filter(c => c.status === 'active').length, 2);
  assert.ok(by[PERSONA].caddieIds.indexOf('c17') >= 0);
  // 好友:08:00 组第一位球员与另一组球员互为好友
  const me = by[PERSONA].players[0].id;
  assert.equal(s.friends[me].length, 1);
  const fr = s.friends[me][0];
  assert.ok(s.friends[fr].indexOf(me) >= 0);
  assert.ok(!by[PERSONA].players.some(p => p.id === fr));
  // ~30 % 会员;全部球员有 id,姓名唯一
  const all = s.bookings.reduce((a, b) => a.concat(b.players), []);
  const share = all.filter(p => p.isMember).length / all.length;
  assert.ok(share > 0.18 && share < 0.45, 'member share ' + share);
  assert.equal(new Set(all.map(p => p.name)).size, all.length);
  assert.ok(all.every(p => p.id && s.players[p.id]));
  assert.ok(['张伟', '李娜', '王强'].every(n => all.some(p => p.name === n)));
  // 同种子 → 相同数据
  assert.equal(JSON.stringify(Store.demoSeed(D, 1)), JSON.stringify(s));
  assert.notEqual(JSON.stringify(Store.demoSeed(D, 2).trueFactorById), JSON.stringify(s.trueFactorById));
});

// ---------- 演示闭环 ----------
test('store: Local demo 06:20 → 12:00 (Map storage, startClock false): finished groups, learned PaceStats, red for 07:36 before 09:00, play-through, merge proposal, 未到 / 迟到, no exception', async () => {
  const s = await mkStore();
  const st = s.getState();
  assert.equal(st.mode, 'local'); assert.equal(st.banner, '演示模式：本地模拟数据');
  assert.equal(st.now, 380); assert.equal(st.date, D);
  assert.equal(s.demo.isLeader(), true);
  assert.deepEqual(st.me, { role: 'operator', userId: 'demo-op', name: '值班员' });
  assert.ok(st.live && Array.isArray(st.live.groups));
  // 加载即有并组建议(旺季)
  const p0 = st.proposals.find(p => p.a === MERGE_A && p.b === MERGE_B);
  assert.ok(p0, 'merge proposal for 10:40/10:48 at load');
  assert.equal(p0.status, 'suggested'); assert.equal(p0.keep, 'a'); assert.equal(p0.targetTeeMin, 640); assert.equal(p0.freedTeeMin, 648);
  assert.equal(p0.expiresAt, 640 - 120);

  const firstRed = {}, ptAt = {}, ahead = {};
  let notified = 0;
  s.subscribe(() => { notified++; });
  let noShowAtGrace = null, lateAt0935 = null, wasSuggestedBefore0840 = false;
  tickTo(s, 720, (state) => {
    state.live.groups.forEach(g => {
      if (g.level === 'red' && firstRed[g.bookingId] == null) firstRed[g.bookingId] = state.now;
      if (g.playThroughSuggested && ptAt[g.bookingId] == null) ptAt[g.bookingId] = state.now;
      if (g.cause === 'AHEAD') ahead[g.bookingId] = true;
    });
    if (Math.abs(state.now - 550) < 1e-9) noShowAtGrace = Object.assign({}, find(state, NOSHOW));
    if (Math.abs(state.now - 575) < 1e-9) lateAt0935 = Object.assign({}, find(state, LATE));
    if (state.now < 520 && state.proposals.some(p => p.a === MERGE_A && p.status === 'suggested')) wasSuggestedBefore0840 = true;
  });
  assert.equal(st.now, 720);
  assert.equal(notified, 340, 'one notification per tick');
  // ≥ 1 组完成,其球员步速已学习
  const finished = st.bookings.filter(b => b.status === 'finished');
  assert.ok(finished.length >= 1, 'finished groups: ' + finished.length);
  finished.forEach(b => {
    assert.ok(b.finishedAt <= 720 && b.teeOffActual >= b.teeMin - 1e-9);
    assert.ok(b.fRound != null, b.id + ' scored');
    b.players.forEach(p => {
      const ps = st.paceStats[p.id];
      assert.ok(ps && ps.playerId === p.id && ps.nEff >= 1 && ps.roundsScored >= 1 && ps.lastRoundDate === D, 'pace stats updated for ' + p.id);
    });
  });
  assert.ok(st.observations.length >= 18 * finished.length);
  // 07:36 慢组在 09:00 前红,并得到让行建议(后组 = 07:44)
  assert.ok(firstRed[SLOW] != null && firstRed[SLOW] < 540, 'slow group red before 09:00: ' + Course.fmtHM(firstRed[SLOW]));
  assert.ok(ptAt[SLOW] != null && ptAt[SLOW] < 540, 'play-through suggested for the slow group');
  const pt = find(st, SLOW).playThrough;
  assert.ok(pt && pt.suggestedAt > 0 && pt.behindId === BEHIND, JSON.stringify(pt));
  assert.equal(ahead[BEHIND], true, 'group behind the slow group was AHEAD-blocked');
  // 并组提议:10:40/10:48 曾被建议;距开球 120 分钟后过期但保留
  assert.ok(wasSuggestedBefore0840);
  const pm = st.proposals.find(p => p.a === MERGE_A && p.b === MERGE_B);
  assert.ok(pm, 'merge proposal still present'); assert.equal(pm.status, 'expired');
  // 未到:宽限期后仍 booked、未签到(UI 显示 标记未到;从不自动)
  assert.equal(noShowAtGrace.status, 'booked'); assert.equal(noShowAtGrace.checkedInAt, undefined);
  assert.equal(find(st, NOSHOW).status, 'booked');
  // 迟到:09:32 签到,恢复自动开球
  assert.equal(lateAt0935.status === 'checkedIn' || lateAt0935.status === 'onCourse', true);
  assert.equal(lateAt0935.checkedInAt, 572); assert.equal(lateAt0935.autoSend === true || lateAt0935.status === 'onCourse', true);
  // 事件语义唯一;告警只针对场上组;快组后方推荐 7′
  const keys = new Set(st.events.map(e => e.bookingId + '|' + e.holeNo + '|' + e.type));
  assert.equal(keys.size, st.events.length);
  assert.ok(st.events.every(e => e.source === 'sim'));
  Object.keys(st.alerts).forEach(id => { const g = st.live.byId[id]; assert.ok(g && (g.phase === 'playing' || g.phase === 'between')); });
  const Pace = require('../js/pace.js');
  assert.equal(Pace.iRec({ plan: Pace.groupPlan(find(st, FAST).players, Store.demoSeed(D, 1).paceStats, st.course.config, D, 2) }, st.course.config).interval, 7);
  // seq 单调;存储中的数据与内存一致
  assert.ok(st.seq >= 340);
  const storage = s.debug.storage;
  assert.equal(JSON.parse(storage.get(Store.PREFIX + 'sheet.' + D)).seq, st.seq);
  assert.equal(JSON.parse(storage.get(Store.PREFIX + 'bookings.' + D)).length, st.bookings.length);
  assert.equal(JSON.parse(storage.get(Store.PREFIX + 'events.' + D)).length, st.events.length);
  assert.equal(JSON.parse(storage.get(Store.PREFIX + 'sim.' + D)).clock.now, 720);
  assert.ok(storage.has(Store.PREFIX + 'pace') && storage.has(Store.PREFIX + 'alerts.' + D) && storage.has(Store.PREFIX + 'observations.' + D) && storage.has(Store.PREFIX + 'proposals.' + D));
});

// ---------- createBooking / moveBooking ----------
test('store: createBooking at an infeasible time throws 42201 with data.reason; feasible time stores planSnapshot; force overrides', async () => {
  const s = await mkStore();
  const st = s.getState();
  const n0 = st.bookings.length;
  const e = await rejects(s.command('createBooking', { teeMin: 460, size: 4, players: [{ name: '测试甲' }], allowMerge: true, notes: '' }), 42201);
  assert.equal(e.data.ok, false); assert.equal(e.data.reason, 'GAP_AHEAD'); assert.equal(e.data.need, 8);
  assert.ok(/间隔不足/.test(e.message));
  assert.equal(st.bookings.length, n0);
  const e2 = await rejects(s.command('createBooking', { teeMin: 300, size: 2, players: [] }), 42201);
  assert.equal(e2.data.reason, 'OUTSIDE_HOURS');
  // 06:56(416)是空档
  const b = await s.command('createBooking', { teeMin: 416, size: 4, players: [{ name: '测试甲', isMember: true }, { name: '测试乙' }], allowMerge: true, notes: '新增' });
  assert.equal(b.status, 'booked'); assert.equal(b.teeMin, 416); assert.equal(b.size, 4); assert.equal(b.version, 1); assert.equal(b.date, D);
  assert.ok(b.players.every(p => p.id)); assert.equal(b.players[0].isMember, true);
  assert.ok(b.planSnapshot && b.planSnapshot.rows.length === 18 && b.planSnapshot.tee === 416 && b.planSnapshot.id === b.id);
  approx(b.planSnapshot.roundMin, 232, 1e-6);
  assert.equal(st.bookings.length, n0 + 1);
  assert.ok(st.players[b.players[0].id]);
  assert.equal(JSON.parse(s.getState().live.byId[b.id] ? '1' : '0'), 1, 'live evaluated after command');
  // force:同一时间再插一组
  const f = await s.command('createBooking', { teeMin: 416, size: 1, players: [{ name: '强插' }], force: true });
  assert.equal(f.forced, true); assert.ok(f.planSnapshot && f.planSnapshot.rows.length === 18);
  // moveBooking:同样的可行性规则
  const e3 = await rejects(s.command('moveBooking', { id: b.id, teeMin: 412 }), 42201);
  assert.ok(e3.data.reason === 'GAP_AHEAD' || e3.data.reason === 'GAP_BEHIND');
  const m = await s.command('moveBooking', { id: b.id, teeMin: 432 });
  assert.equal(m.teeMin, 432); assert.equal(m.version, 2); assert.equal(m.planSnapshot.tee, 432);
  await rejects(s.command('patchBooking', { id: b.id, version: 1, patch: { notes: 'x' } }), 40901);
  const pb = await s.command('patchBooking', { id: b.id, version: 2, patch: { notes: '改备注' } });
  assert.equal(pb.notes, '改备注'); assert.equal(pb.version, 3);
  await rejects(s.command('nope', {}), 40001);
  await rejects(s.command('checkIn', { id: 'missing' }), 40401);
});

// ---------- 签到 / 开球 / 未到 / 取消 ----------
test('store: checkIn / teeOff / noShow / cancel transitions; teeOff posts a marshal event and disables autoSend', async () => {
  const s = await mkStore();
  const st = s.getState();
  const b = find(st, PERSONA);
  assert.equal(b.status, 'booked');
  const c = await s.command('checkIn', { id: PERSONA });
  assert.equal(c.status, 'checkedIn'); assert.equal(c.checkedInAt, 380); assert.equal(c.version, 2);
  await rejects(s.command('checkIn', { id: PERSONA }), 40001);
  const t = await s.command('teeOff', { id: PERSONA, t: 381 });
  assert.equal(t.status, 'onCourse'); assert.equal(t.teeOffActual, 381); assert.equal(t.autoSend, false);
  const ev = st.events.filter(e => e.bookingId === PERSONA);
  assert.equal(ev.length, 1); assert.equal(ev[0].type, 'teeOff'); assert.equal(ev[0].holeNo, 1); assert.equal(ev[0].source, 'marshal'); assert.equal(ev[0].t, 381);
  assert.equal(st.live.byId[PERSONA].phase, 'playing'); assert.equal(st.live.order[0], PERSONA);
  // 重复开球事件被语义去重(保留最早)
  const again = await s.command('postEvent', { bookingId: PERSONA, holeNo: 1, type: 'teeOff', t: 390, source: 'caddie' });
  assert.equal(again.t, 381); assert.equal(st.events.filter(e => e.bookingId === PERSONA).length, 1);
  const lg = await s.command('postEvent', { bookingId: PERSONA, holeNo: 1, type: 'leaveGreen', t: 392, source: 'caddie' });
  assert.equal(lg.source, 'caddie'); assert.equal(st.live.byId[PERSONA].phase, 'between'); assert.equal(st.live.byId[PERSONA].holeNo, 2);
  // 迟到者手动签到 → autoSend 恢复;未到 → noShow;取消
  const late = await s.command('checkIn', { id: LATE });
  assert.equal(late.autoSend, true);
  const ns = await s.command('noShow', { id: NOSHOW });
  assert.equal(ns.status, 'noShow');
  await rejects(s.command('noShow', { id: NOSHOW }), 40001);
  const cx = await s.command('cancel', { id: 'b0632' });
  assert.equal(cx.status, 'cancelled');
  await rejects(s.command('cancel', { id: PERSONA }), 40001);
  // 已开球的组不能改时
  await rejects(s.command('moveBooking', { id: PERSONA, teeMin: 500 }), 40001);
  // 标记完成(事件不足 → 不评分)
  const fm = await s.command('finishManually', { id: PERSONA });
  assert.equal(fm.status, 'finished'); assert.equal(fm.finishedManually, true); assert.equal(fm.finishedAt, 380); assert.equal(fm.fRound, null);
  assert.equal(st.live.byId[PERSONA], undefined);
  // Sim 不再把被取消 / 未到的组送出
  tickTo(s, 560);
  assert.equal(find(st, NOSHOW).status, 'noShow'); assert.equal(find(st, 'b0632').status, 'cancelled');
  assert.ok(find(st, 'b0640').status === 'onCourse' || find(st, 'b0640').status === 'finished');
});

// ---------- 告警 / 让行 ----------
test('store: ackAlert snoozes (urge 10, ignore 20); playThrough accepted sets fromHoleIdx = y + 1, ignored sets decision', async () => {
  const s = await mkStore();
  const st = s.getState();
  tickTo(s, 530);
  const slow = st.live.byId[SLOW];
  assert.ok(slow && (slow.phase === 'playing' || slow.phase === 'between'));
  assert.ok(st.alerts[SLOW], 'alert state exists for an on-course group');
  const a = await s.command('ackAlert', { bookingId: SLOW, action: 'urge' });
  assert.equal(a.snoozeUntil, 530 + 10); assert.equal(a.snoozedLevel, a.level); assert.equal(st.alerts[SLOW], a);
  if (a.level !== 'green') assert.equal(st.live.byId[SLOW].snoozed, true);
  const a2 = await s.command('ackAlert', { bookingId: BEHIND, action: 'ignore' });
  assert.equal(a2.snoozeUntil, 530 + 20);
  // 告警级别在下一 tick 仍带着 snooze 字段
  s.demo.tick(1);
  assert.equal(st.alerts[SLOW].snoozeUntil, 540);
  // 让行
  const Live = require('../js/live.js');
  const prog = Live.deriveProgress(find(st, SLOW), st.events.filter(e => e.bookingId === SLOW), st.course.holes);
  const y = prog.phase === 'playing' ? prog.holeIdx : prog.holeIdx - 1;
  const acc = await s.command('playThrough', { bookingId: SLOW, behindId: BEHIND, decision: 'accepted' });
  assert.equal(acc.playThrough.decision, 'accepted'); assert.equal(acc.playThrough.behindId, BEHIND); assert.equal(acc.playThrough.fromHoleIdx, y + 1);
  assert.equal(acc.playThrough.decidedAt, 531);
  assert.equal(find(st, SLOW), acc, 'booking replaced in state');
  assert.equal(st.live.byId[SLOW].playThroughSuggested, false);
  const ign = await s.command('playThrough', { bookingId: BEHIND, decision: 'ignored' });
  assert.equal(ign.playThrough.decision, 'ignored');
  await rejects(s.command('playThrough', { bookingId: BEHIND, decision: 'maybe' }), 40001);
  // 让行后继续推进:接受让行的组不会被同一后组再次建议;模拟仍收敛
  tickTo(s, 600);
  assert.equal(find(st, SLOW).playThrough.decision, 'accepted');
  const idxSlow = st.live.order.indexOf(SLOW), idxBehind = st.live.order.indexOf(BEHIND);
  assert.ok(idxBehind < 0 || idxSlow < 0 || idxBehind < idxSlow, 'taker is physically ahead of the yielder after the play-through');
});

// ---------- 并组 ----------
test('store: proposeMerge → respondMerge (both sides) → confirmed → applyMerge merges bookings; declined / withdrawn / infeasible paths', async () => {
  const s = await mkStore();
  const st = s.getState();
  const p = st.proposals.find(x => x.a === MERGE_A);
  assert.ok(p);
  await rejects(s.command('respondMerge', { proposalId: p.id, side: 'a', decision: 'accept' }), 40001);   // suggested 不能直接接受
  const pr = await s.command('proposeMerge', { proposalId: p.id });
  assert.equal(pr.status, 'proposed'); assert.equal(pr.proposedAt, 380);
  const ra = await s.command('respondMerge', { proposalId: p.id, side: 'a', decision: 'accept' });
  assert.equal(ra.status, 'accepted_a'); assert.equal(ra.decisions.a, 'accept');
  await rejects(s.command('applyMerge', { proposalId: p.id }), 40001);
  const rb = await s.command('respondMerge', { proposalId: p.id, side: 'b', decision: 'accept' });
  assert.equal(rb.status, 'confirmed');
  // 推进几分钟:在途提议仍可行,不被撤回
  tickTo(s, 400);
  assert.equal(st.proposals.find(x => x.id === p.id).status, 'confirmed');
  const ap = await s.command('applyMerge', { proposalId: p.id });
  assert.equal(ap.status, 'applied');
  const a = find(st, MERGE_A), b = find(st, MERGE_B);
  assert.equal(a.size, 3); assert.equal(a.players.length, 3); assert.equal(a.status, 'booked'); assert.equal(a.version, 2);
  assert.equal(b.status, 'merged'); assert.equal(b.mergedInto, MERGE_A);
  assert.ok(a.planSnapshot && a.planSnapshot.rows.length === 18);
  assert.ok(st.live.byId[MERGE_B] === undefined);
  // 不会再次建议同一对
  tickTo(s, 405);
  assert.equal(st.proposals.filter(x => x.a === MERGE_A).length, 1);

  // 第二条路径:拒绝
  const t = await mkStore();
  const st2 = t.getState();
  const q = st2.proposals.find(x => x.a === MERGE_A);
  await t.command('proposeMerge', { proposalId: q.id });
  const dec = await t.command('respondMerge', { proposalId: q.id, side: 'b', decision: 'decline' });
  assert.equal(dec.status, 'declined');
  tickTo(t, 390);
  assert.equal(st2.proposals.find(x => x.id === q.id).status, 'declined');
  assert.equal(st2.proposals.filter(x => x.a === MERGE_A).length, 1, 'declined pair is not re-suggested');
  // 撤回
  const u = await mkStore();
  const st3 = u.getState();
  const r = st3.proposals.find(x => x.a === MERGE_A);
  await u.command('proposeMerge', { proposalId: r.id });
  assert.equal((await u.command('withdrawMerge', { proposalId: r.id })).status, 'withdrawn');
  // 在途提议因一方取消而自动撤回
  const v = await mkStore();
  const st4 = v.getState();
  const w = st4.proposals.find(x => x.a === MERGE_A);
  await v.command('proposeMerge', { proposalId: w.id });
  await v.command('cancel', { id: MERGE_B });
  const ww = st4.proposals.find(x => x.id === w.id);
  assert.equal(ww.status, 'withdrawn'); assert.ok(/自动撤回/.test(ww.note));
  // 关闭旺季开关:演示表利用率 ≥ 0.85,peakActive 仍为真 → 建议保留;一方取消 → 'suggested' 消失(不保留)
  const Merge = require('../js/merge.js');
  const x = await mkStore();
  const st5 = x.getState();
  await x.command('setSheet', { patch: { peakMode: false } });
  assert.equal(st5.sheet.peakMode, false);
  assert.equal(Merge.peakActive(st5.sheet, st5.bookings, st5.course.config, 0), true);
  assert.equal(st5.proposals.filter(p => p.status === 'suggested').length, 1);
  await x.command('cancel', { id: MERGE_A });
  assert.equal(st5.proposals.filter(p => p.a === MERGE_A || p.b === MERGE_A).length, 0, 'cancelled pair is dropped');
  assert.equal(st5.proposals.filter(p => p.status === 'suggested').length, 1, 'the afternoon pair takes over the single suggestion slot (maxShare cap)');
  // 利用率不足 + 非旺季 → 没有建议;开启旺季 → 建议出现
  const y = await mkStore();
  const st6 = y.getState();
  for (const b of st6.bookings.slice()) if (b.teeMin < 600 && b.id !== MERGE_A && b.id !== MERGE_B) await y.command('cancel', { id: b.id });
  await y.command('setSheet', { patch: { peakMode: false } });
  assert.equal(Merge.peakActive(st6.sheet, st6.bookings, st6.course.config, 0), false);
  assert.equal(st6.proposals.filter(p => p.status === 'suggested').length, 0);
  await y.command('setSheet', { patch: { peakMode: true } });
  assert.equal(st6.proposals.filter(p => p.status === 'suggested').length, 1);
});

// ---------- 评分隐私 ----------
test('store: rate stores a rating readable only by the rater; load() for another user does not return it; validation', async () => {
  const storage = new Map();
  const b = Store.demoSeed(D, 1).bookings.find(x => x.id === PERSONA);
  const me = { role: 'player', userId: b.players[0].id, name: b.players[0].name, bookingId: PERSONA };
  const s = await mkStore({ storage, me });
  const st = s.getState();
  assert.deepEqual(st.ratings, []);
  assert.equal(st.friendIds.size, 1, 'persona has one mutual friend');
  // 完赛后才能评分(与 live.html 的表单门槛一致)
  await rejects(s.command('rate', { bookingId: PERSONA, rateeId: 'c17', rateeRole: 'caddie', stars: 5 }), 40001);
  await s.command('teeOff', { id: PERSONA, t: 480 });
  await s.command('finishManually', { id: PERSONA });
  assert.equal(find(st, PERSONA).status, 'finished');
  const r = await s.command('rate', { bookingId: PERSONA, rateeId: 'c17', rateeRole: 'caddie', stars: 5, tags: ['专业', '友善'], comment: '很好' });
  assert.equal(r.raterId, me.userId); assert.equal(r.raterRole, 'player'); assert.equal(r.rateeId, 'c17'); assert.equal(r.stars, 5);
  assert.equal(st.ratings.length, 1);
  // 可编辑(同一 rater/ratee/booking 只有一条)
  const r2 = await s.command('rate', { bookingId: PERSONA, rateeId: 'c17', rateeRole: 'caddie', stars: 4, tags: [], comment: '' });
  assert.equal(r2.id, r.id); assert.equal(st.ratings.length, 1); assert.equal(st.ratings[0].stars, 4);
  // 校验:不在本组 / 球员评球员 / 被评者不在本组
  await rejects(s.command('rate', { bookingId: SLOW, rateeId: 'c17', rateeRole: 'caddie', stars: 3 }), 40301);
  await rejects(s.command('rate', { bookingId: PERSONA, rateeId: b.players[1].id, rateeRole: 'player', stars: 3 }), 40001);
  await rejects(s.command('rate', { bookingId: PERSONA, rateeId: 'c7', rateeRole: 'caddie', stars: 3 }), 40001);
  // 另一个用户(球童 17)加载同一存储:看不到球员的评分,只看到自己的
  const caddie = Store.createLocal({ date: D, storage, startClock: false, wallClock: () => FIXED_MS, me: { role: 'caddie', userId: 'c17', name: '小周', caddieNo: '17', bookingId: PERSONA } });
  await caddie.load(D);
  assert.deepEqual(caddie.getState().ratings, []);
  const cr = await caddie.command('rate', { bookingId: PERSONA, rateeId: b.players[0].id, rateeRole: 'player', stars: 3, tags: ['慢打'], comment: '' });
  assert.equal(cr.raterRole, 'caddie');
  assert.equal(caddie.getState().ratings.length, 1);
  // 原始存储里两份评分分开存放,键名含评分者 id
  assert.ok(storage.has(Store.PREFIX + 'ratings.' + me.userId)); assert.ok(storage.has(Store.PREFIX + 'ratings.c17'));
  // 值班员加载:ratings 为空
  const op = await mkStore({ storage });
  assert.deepEqual(op.getState().ratings, []);
  // 球员视角重新加载仍能读到自己的评分
  const again = await mkStore({ storage, me });
  assert.equal(again.getState().ratings.length, 1); assert.equal(again.getState().ratings[0].stars, 4);
});

// ---------- 客户端注册 / 快照 ----------
test('store: registerClient (player by name → existing id; caddie by no) persists ClientProfile; clientSnapshot / clientProposals / debug.otherPlayerNames', async () => {
  const storage = new Map();
  const s = await mkStore({ storage, client: true });
  const st = s.getState();
  assert.equal(st.me, null, 'client mode without a profile → null me (registration form)');
  const seed = Store.demoSeed(D, 1);
  const persona = seed.bookings.find(x => x.id === PERSONA).players[0];
  const me = await s.command('registerClient', { role: 'player', name: persona.name, bookingId: PERSONA });
  assert.equal(me.role, 'player'); assert.equal(me.userId, persona.id); assert.equal(me.bookingId, PERSONA); assert.equal(me.createdAt, 380);
  assert.deepEqual(JSON.parse(storage.get(Store.PREFIX + 'client')), me);
  assert.equal(st.friendIds.size, 1);
  // 重新打开:读取已存的 ClientProfile
  const s2 = await mkStore({ storage, client: true });
  assert.deepEqual(s2.getState().me, me);
  // 快照隐私:他组姓名 / id 不出现,好友姓名可出现
  tickTo(s, 500);
  const snap = await s.clientSnapshot();
  assert.equal(snap.me.bookingId, PERSONA);
  assert.ok(['playing', 'between', 'notStarted'].indexOf(snap.me.phase) >= 0);
  assert.equal(snap.me.players.length, 4); assert.ok(snap.me.players.some(p => p.isMe));
  assert.deepEqual(snap.me.caddies, [{ no: '17', name: '小周' }]);
  assert.equal(snap.holes.length, 18);
  const others = s.debug.otherPlayerNames();
  const friendId = seed.friends[persona.id][0];
  const friendName = seed.players[friendId].name;
  assert.ok(others.indexOf(friendName) < 0, 'friend is not an "other"');
  assert.ok(others.indexOf(persona.name) < 0);
  assert.ok(others.length >= 80);
  const text = JSON.stringify(snap.holes);
  others.forEach(n => assert.ok(text.indexOf(n) < 0, 'leak ' + n));
  st.bookings.forEach(b => { if (b.id !== PERSONA) assert.ok(text.indexOf('"' + b.id + '"') < 0); });
  // 并组邀请:只有发出的提议(非 suggested)对客户端可见
  const mb = seed.bookings.find(x => x.id === MERGE_B).players[0];
  const sB = await mkStore({ storage: new Map(), me: { role: 'player', userId: mb.id, name: mb.name, bookingId: MERGE_B } });
  assert.deepEqual(await sB.clientProposals(), []);
  const p = sB.getState().proposals.find(x => x.a === MERGE_A);
  await sB.command('proposeMerge', { proposalId: p.id });
  const views = await sB.clientProposals();
  assert.equal(views.length, 1); assert.equal(views[0].mySide, 'b'); assert.equal(views[0].myTeeMin, 648); assert.equal(views[0].newTeeMin, 640);
  assert.deepEqual(Object.keys(views[0].other).sort(), ['friends', 'size']); assert.equal(views[0].other.size, 2);
  // 球童注册:按编号找到已有球童;未知编号 → 新建 pending
  const c = await s.command('registerClient', { role: 'caddie', name: '小周', caddieNo: '17' });
  assert.equal(c.userId, 'c17'); assert.equal(c.caddieNo, '17'); assert.equal(c.bookingId, PERSONA);
  const c2 = await s.command('registerClient', { role: 'caddie', name: '新球童', caddieNo: '99' });
  assert.equal(c2.userId, 'c99'); assert.equal(st.caddies.find(x => x.no === '99').status, 'pending');
  const ap = await s.command('approveCaddie', { id: 'c99' });
  assert.equal(ap.status, 'active');
  await rejects(s.command('registerClient', { role: 'caddie', name: '无编号' }), 40001);
  await rejects(s.command('registerClient', { role: 'player', name: '' }), 40001);
  assert.deepEqual(s.demo.persona('player', PERSONA), { role: 'player', name: persona.name, bookingId: PERSONA, userId: persona.id });
});

// ---------- 球场参数 / 校准 / 全场暂停 ----------
test('store: saveConfig / saveHoles / adoptCalibration / resetCalibration / fieldHold persist and re-evaluate', async () => {
  const storage = new Map();
  const s = await mkStore({ storage });
  const st = s.getState();
  const c1 = await s.command('saveConfig', { config: { redOn: 12, merge: { windowMin: 40 } } });
  assert.equal(c1.config.redOn, 12); assert.equal(c1.config.merge.windowMin, 40); assert.equal(c1.config.merge.paceTol, 0.2);
  assert.equal(JSON.parse(storage.get(Store.PREFIX + 'config')).redOn, 12);
  const c2 = await s.command('adoptCalibration', { picks: [{ holeNo: 3, std: 8 }, { holeNo: 4, transit: 3 }] });
  assert.equal(c2.holes[2].std, 8); assert.equal(c2.holes[3].transit, 3); assert.equal(c2.layoutVersion, 2);
  const c3 = await s.command('resetCalibration', {});
  assert.equal(c3.holes[2].std, 7); assert.equal(c3.holes[3].transit, 2); assert.equal(c3.layoutVersion, 3);
  const holes = c3.holes.map(h => Object.assign({}, h));
  holes[0].std = 12;
  const c4 = await s.command('saveHoles', { holes });
  assert.equal(c4.holes[0].std, 12); assert.equal(c4.holes[0].par, 4); assert.equal(c4.layoutVersion, 4);
  const fh = await s.command('fieldHold', { min: 5 });
  assert.equal(fh.fieldHoldMin, 5);
  // 重新加载同一存储(接管租约):球场与配置保留
  const s2 = await mkStore({ storage, leader: true });
  assert.equal(s2.getState().course.holes[0].std, 12); assert.equal(s2.getState().course.config.redOn, 12); assert.equal(s2.getState().sheet.fieldHoldMin, 5);
  // 模拟继续运行且不抛
  tickTo(s2, 420);
  assert.ok(s2.getState().bookings.some(b => b.status === 'onCourse'));
});

// ---------- 租约 ----------
test('store: single-writer lease — a second instance on the same storage follows (does not step the sim) while the first holds the lease; takes over after TTL', async () => {
  const storage = new Map();
  let ms = FIXED_MS;
  const clock = () => ms;
  const a = Store.createLocal({ date: D, seed: 1, storage, startClock: false, wallClock: clock, tabId: 'A' });
  await a.load(D);
  assert.equal(a.demo.isLeader(), true);
  tickTo(a, 400);
  const b = Store.createLocal({ date: D, seed: 1, storage, startClock: false, wallClock: clock, tabId: 'B' });
  await b.load(D);
  assert.equal(b.demo.isLeader(), false);
  assert.equal(b.getState().now, 400, 'follower reads the leader clock from storage');
  assert.equal(b.getState().bookings.length, a.getState().bookings.length);
  const eventsBefore = a.getState().events.length;
  b.demo.tick(5);
  assert.equal(b.getState().now, 400, 'follower tick does not advance the clock');
  assert.equal(b.demo.isLeader(), false);
  assert.equal(JSON.parse(storage.get(Store.PREFIX + 'sim.' + D)).clock.now, 400);
  assert.equal(a.getState().events.length, eventsBefore);
  // 领导者继续推进;跟随者刷新后看到相同数据
  tickTo(a, 410);
  b.demo.tick(1);
  assert.equal(b.getState().now, 410);
  assert.equal(b.getState().events.length, a.getState().events.length);
  assert.equal(JSON.stringify(b.getState().bookings), JSON.stringify(a.getState().bookings));
  // 跟随者发出命令:写入存储;领导者下一 tick 通过 seq 发现并重载
  await b.command('checkIn', { id: PERSONA });
  assert.equal(b.getState().bookings.find(x => x.id === PERSONA).status, 'checkedIn');
  a.demo.tick(1);
  assert.equal(a.getState().bookings.find(x => x.id === PERSONA).status, 'checkedIn');
  // 租约过期(领导者 3 s 内没有 tick)→ 跟随者接管
  ms += Store.LEASE_TTL_MS + 1;
  b.demo.tick(1);
  assert.equal(b.demo.isLeader(), true);
  assert.equal(b.getState().now, 412);
  // 原领导者再 tick → 变为跟随者
  a.demo.tick(1);
  assert.equal(a.demo.isLeader(), false);
  assert.equal(a.getState().now, 412);
  // 显式 leader 选项强制夺回
  const c = Store.createLocal({ date: D, seed: 1, storage, startClock: false, wallClock: clock, tabId: 'C', leader: true });
  await c.load(D);
  assert.equal(c.demo.isLeader(), true);
  assert.equal(b.demo.isLeader(), false);
});

// ---------- demo 控制 ----------
test('store: demo.setSpeed / jumpTo / setAutoSend / reset; start() uses the 1 Hz interval only when asked', async () => {
  const s = await mkStore();
  const st = s.getState();
  assert.equal(s.demo.speed, 1);
  s.demo.setSpeed(60); assert.equal(s.demo.speed, 60);
  s.demo.setSpeed('x'); assert.equal(s.demo.speed, 60);
  assert.equal(s.demo.now(), 380);
  s.demo.setAutoSend(false);
  s.demo.jumpTo(430);
  assert.equal(st.now, 430);
  assert.equal(st.bookings.filter(b => b.status === 'onCourse').length, 0, 'auto-send off → nobody tees off');
  assert.ok(st.bookings.filter(b => b.status === 'checkedIn').length >= 3, 'auto check-in still runs');
  s.demo.setAutoSend(true);
  s.demo.jumpTo(445);
  assert.ok(st.bookings.filter(b => b.status === 'onCourse').length >= 2);
  s.demo.jumpTo(400);
  assert.equal(st.now, 445, 'jumpTo backwards is ignored');
  s.demo.reset(5);
  assert.equal(st.now, 380);
  assert.ok(st.bookings.every(b => b.status === 'booked'));
  assert.equal(st.events.length, 0);
  assert.ok(st.proposals.some(p => p.status === 'suggested'));
  // 定时器:未启动时不使用 setInterval;start() 后使用;stop() 清除
  let calls = 0;
  const G = globalThis;
  const si = G.setInterval, ci = G.clearInterval;
  G.setInterval = function (fn, ms) { calls++; assert.equal(ms, 1000); return 42; };
  G.clearInterval = function (id) { assert.equal(id, 42); };
  try { s.demo.start(); s.demo.start(); s.demo.stop(); } finally { G.setInterval = si; G.clearInterval = ci; }
  assert.equal(calls, 1);
  // poll
  const p = await s.poll(0);
  assert.equal(p.seq, st.seq); assert.ok(p.bookings.length > 0); assert.equal(p.serverNow, 380);
  const p2 = await s.poll(st.seq);
  assert.deepEqual(p2.bookings, []);
});

// ---------- ApiDataSource ----------
function fakeFetch(handler) {
  const calls = [];
  const f = function (url, init) {
    calls.push({ url, init: init || {} });
    return Promise.resolve().then(() => handler(url, init || {}, calls.length));
  };
  f.calls = calls;
  return f;
}
function resp(status, body, headers) {
  return { status, ok: status >= 200 && status < 300, headers: { get: k => (headers || {})[k] || null }, text: () => Promise.resolve(body == null ? '' : (typeof body === 'string' ? body : JSON.stringify(body))) };
}
function apiHandler(opts) {
  opts = opts || {};
  const seed = Store.demoSeed(D, 1);
  return function (url, init) {
    const path = url.replace(/^\/tee-api\/v1/, '');
    if (opts.failAll) return Promise.reject(new Error('ECONNREFUSED'));
    if (path === '/me') return resp(200, { code: 0, data: { userId: 'staff1', name: '前台', roles: [{ courseId: 'c1', role: 'OPERATOR' }], defaultCourseId: 'c1', serverTime: 500, engineVersion: '1.0.0' } });
    if (path === '/courses/c1/profile') return resp(200, { code: 0, data: { id: 'c1', name: '真实球场', holes: Course.demoLayout() } });
    if (path === '/courses/c1/sheets/' + D) return resp(200, { code: 0, data: { seq: 7, sheet: seed.sheet, bookings: seed.bookings.slice(0, 5), events: [], proposals: [], caddies: seed.caddies, serverNow: 500 } });
    if (path.indexOf('/courses/c1/sheets/' + D + '/live') === 0) {
      if (opts.live304) return resp(304, '');
      return resp(200, { code: 0, data: { seq: 8, serverNow: 501, events: [{ id: 'e1', bookingId: 'b0632', holeNo: 1, type: 'teeOff', t: 392, source: 'marshal' }], bookings: [], proposals: [], alerts: { b0632: { level: 'yellow', since: 495 } } } });
    }
    if (path === '/courses/c1/sheets/' + D + '/groups' && init.method === 'POST') {
      const body = JSON.parse(init.body);
      if (body.teeMin === 460) return resp(422, { code: 42201, message: '时间不可行', data: { ok: false, reason: 'GAP_AHEAD', need: 8 } });
      return resp(200, { code: 0, data: Object.assign({ id: 'srv1', status: 'booked', version: 1 }, body) });
    }
    if (/^\/courses\/c1\/groups\/[^/]+$/.test(path) && init.method === 'PATCH') return resp(200, { code: 0, data: { id: decodeURIComponent(path.split('/').pop()), version: 2, patched: JSON.parse(init.body) } });
    return resp(404, { code: 40401, message: 'not found' });
  };
}

test('store: ApiDataSource — Bearer / Idempotency-Key / If-Match headers, envelope unwrapping, code != 0 → throw, 304 handled, poll merges deltas and server alert levels win', async () => {
  const token = new Map([[Store.PREFIX + 'token', 'JWT123']]);
  const tokenStorage = { getItem: k => token.get(k) || null, setItem: (k, v) => token.set(k, v), removeItem: k => token.delete(k) };
  const fetchImpl = fakeFetch(apiHandler());
  const api = Store.createApi({ base: '/tee-api/v1', fetchImpl, tokenStorage, date: D, wallClock: () => FIXED_MS });
  let changes = 0;
  api.onModeChange(() => { changes++; });
  const st = await api.load(D);
  assert.equal(st.mode, 'api'); assert.equal(st.banner, '已连接后端'); assert.equal(api.mode, 'api');
  assert.equal(st.me.userId, 'staff1'); assert.equal(st.course.name, '真实球场'); assert.equal(st.bookings.length, 5); assert.equal(st.seq, 7); assert.equal(st.now, 500);
  assert.ok(st.live && st.live.groups.length === 5);
  assert.equal(fetchImpl.calls[0].url, '/tee-api/v1/me');
  fetchImpl.calls.forEach(c => assert.equal(c.init.headers.Authorization, 'Bearer JWT123'));
  // 创建:Idempotency-Key;信封 code != 0 → {code, message, data}
  const e = await rejects(api.command('createBooking', { teeMin: 460, size: 4, players: [] }), 42201);
  assert.equal(e.data.reason, 'GAP_AHEAD'); assert.equal(e.message, '时间不可行');
  const create = fetchImpl.calls[fetchImpl.calls.length - 1];
  assert.equal(create.init.method, 'POST'); assert.ok(/^[0-9a-f-]{36}$/.test(create.init.headers['Idempotency-Key']));
  const ok = await api.command('createBooking', { teeMin: 416, size: 4, players: [] });
  assert.equal(ok.id, 'srv1');
  // 修改:If-Match
  const pb = await api.command('patchBooking', { id: 'b0632', version: 1, patch: { notes: 'x' } });
  assert.equal(pb.version, 2);
  const patch = fetchImpl.calls.filter(c => c.init.method === 'PATCH')[0];
  assert.equal(patch.init.headers['If-Match'], '1'); assert.equal(patch.url, '/tee-api/v1/courses/c1/groups/b0632');
  // poll:增量合并,服务器告警级别为准
  const d = await api.poll(7);
  assert.equal(d.seq, 8); assert.equal(st.events.length, 1); assert.equal(st.serverNow, 501);
  assert.equal(st.live.byId.b0632.level, 'yellow'); assert.equal(st.live.byId.b0632.phase, 'playing');
  assert.equal(st.alerts.b0632.since, 495);
  assert.equal(changes, 0); assert.equal(api.demo, undefined);
  // 304
  const api2 = Store.createApi({ fetchImpl: fakeFetch(apiHandler({ live304: true })), tokenStorage, date: D });
  await api2.load(D);
  const nm = await api2.poll(7);
  assert.equal(nm.notModified, true); assert.deepEqual(nm.events, []); assert.equal(api2.getState().seq, 7);
  // 无 token → 无 Authorization 头
  const f3 = fakeFetch(apiHandler());
  const api3 = Store.createApi({ fetchImpl: f3, tokenStorage: { getItem: () => null, setItem() {}, removeItem() {} }, date: D });
  await api3.load(D);
  assert.equal(f3.calls[0].init.headers.Authorization, undefined);
});

test('store: ApiDataSource — after 3 consecutive transport failures it falls back to Local with the banner, fires onModeChange, and delegates commands/state', async () => {
  const fetchImpl = fakeFetch(apiHandler({ failAll: true }));
  const api = Store.createApi({ fetchImpl, tokenStorage: { getItem: () => null, setItem() {}, removeItem() {} }, date: D, retryMs: 60000,
    localOpts: { storage: new Map(), seed: 1, startClock: false, wallClock: () => FIXED_MS } });
  const modes = [];
  api.onModeChange(m => modes.push(m));
  let subscribed = 0;
  api.subscribe(() => { subscribed++; });
  const G = globalThis;
  const origST = G.setTimeout;
  let scheduled = null;
  G.setTimeout = function (fn, ms) { scheduled = ms; return origST(() => {}, 0); };
  try {
    await rejects(api.load(D), 50300);
    assert.equal(api.mode, 'api');
    await rejects(api.poll(0), 50300);
    assert.equal(api.mode, 'api');
    await rejects(api.poll(0), 50300);                       // 第 3 次 → 回退
    assert.equal(api.mode, 'local');
    await new Promise(r => origST(r, 10));                   // 等 local.load 完成
  } finally { G.setTimeout = origST; }
  assert.equal(scheduled, 60000, 'retry scheduled every 60 s');
  const st = api.getState();
  assert.equal(st.mode, 'local'); assert.equal(st.banner, '演示模式：后端不可达，当前为演示数据');
  assert.ok(/后端不可达，当前为演示数据/.test(st.banner) && /演示模式/.test(st.banner));
  assert.deepEqual(modes, ['local']);
  assert.ok(st.bookings.length >= 24); assert.ok(api.demo && typeof api.demo.tick === 'function');
  api.demo.tick(1);
  assert.ok(subscribed >= 1, 'subscribers re-attached to the local store');
  const b = await api.command('checkIn', { id: PERSONA });
  assert.equal(b.status, 'checkedIn');
  const snap = await api.clientSnapshot();
  assert.ok(snap && snap.holes.length === 18);
});

test('store: Store.auto — unreachable backend (rejecting fetch / non-OK / timeout) → Local with the fallback banner; reachable → Api', async () => {
  const bad = await Store.auto({ date: D, fetchImpl: () => Promise.reject(new Error('file://')), storage: new Map(), startClock: false, wallClock: () => FIXED_MS });
  assert.equal(bad.mode, 'local'); assert.equal(bad.getState().banner, '演示模式：后端不可达，当前为演示数据'); assert.ok(bad.getState().bookings.length >= 24);
  const bad502 = await Store.auto({ date: D, fetchImpl: () => Promise.resolve(resp(502, 'no backend')), storage: new Map(), startClock: false, wallClock: () => FIXED_MS });
  assert.equal(bad502.mode, 'local'); assert.equal(bad502.getState().banner, '演示模式：后端不可达，当前为演示数据');
  const slow = await Store.auto({ date: D, timeoutMs: 20, fetchImpl: () => new Promise(() => {}), storage: new Map(), startClock: false, wallClock: () => FIXED_MS });
  assert.equal(slow.mode, 'local');
  const good = await Store.auto({ date: D, fetchImpl: fakeFetch(apiHandler()), tokenStorage: { getItem: () => null, setItem() {}, removeItem() {} }, storage: new Map(), startClock: false });
  assert.equal(good.mode, 'api'); assert.equal(good.getState().banner, '已连接后端'); assert.equal(good.getState().course.name, '真实球场');
  assert.equal(typeof Store.wallClock(), 'number');
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(Store.todayDate()));
});

// ---------- 评审修正:客户端不该看到从未发出的并组建议;已结束的邀请只再显示 30 分钟 ----------
test('store: clientProposals hides proposals never sent by the operator (suggested → expired) and closed ones older than 30 min', async () => {
  const mb = Store.demoSeed(D, 1).bookings.find(x => x.id === MERGE_A);
  const me = { role: 'player', userId: mb.players[0].id, name: mb.players[0].name, bookingId: MERGE_A };
  // (a) 从未发出:建议阶段过期 → 客户看不到
  const s = await mkStore({ me });
  tickTo(s, 580);                                                   // 09:40
  const st = s.getState();
  const mine = st.proposals.filter(p => p.a === MERGE_A || p.b === MERGE_A);
  assert.ok(mine.length >= 1, 'a merge proposal exists for 10:40/10:48');
  assert.ok(mine.every(p => p.proposedAt == null && p.status === 'expired'), JSON.stringify(mine.map(p => [p.status, p.proposedAt])));
  assert.deepEqual(await s.clientProposals(), []);
  // (b) 发出后过期:过期后 30 分钟内可见(带状态),之后隐藏
  const s2 = await mkStore({ me });
  const st2 = s2.getState();
  const sug = st2.proposals.find(p => (p.a === MERGE_A || p.b === MERGE_A) && p.status === 'suggested');
  assert.ok(sug, 'suggested at load');
  await s2.command('proposeMerge', { proposalId: sug.id });
  assert.equal((await s2.clientProposals()).length, 1);
  tickTo(s2, sug.expiresAt + 5);
  const seen = await s2.clientProposals();
  assert.equal(seen.length, 1); assert.equal(seen[0].status, 'expired');
  tickTo(s2, sug.expiresAt + 31);
  assert.deepEqual(await s2.clientProposals(), []);
});

// ---------- 评审修正:存储写入失败(配额满)不冻结演示 ----------
test('store: persist failure (quota) switches to in-memory storage, keeps the lease and the clock, flags state.storageError', async () => {
  const m = new Map();
  let failing = false, attempts = 0;
  const storage = {
    getItem: k => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { attempts++; if (failing) { const e = new Error('QuotaExceededError'); e.name = 'QuotaExceededError'; throw e; } m.set(k, String(v)); },
    removeItem: k => { m.delete(k); },
    key: i => Array.from(m.keys())[i],
    get length() { return m.size; }
  };
  const s = await mkStore({ storage });
  const st = s.getState();
  tickTo(s, 400);
  assert.equal(st.storageError, false);
  const seqBefore = st.seq;
  failing = true;
  s.demo.setSpeed(60);
  for (let i = 0; i < 20; i++) s.demo.tick(1);
  assert.equal(st.storageError, true, 'storage error flagged');
  assert.ok(st.now >= 419.9, 'clock kept advancing: ' + st.now);
  assert.equal(s.demo.isLeader(), true, 'still the leader (lease kept in memory)');
  assert.equal(s.demo.speed, 60, 'speed not reverted from a stale stored sim blob');
  assert.ok(st.seq > seqBefore);
  // 命令继续生效(内存里)
  await s.command('setSheet', { patch: { peakMode: false } });
  assert.equal(st.sheet.peakMode, false);
  s.demo.tick(1);
  assert.equal(st.sheet.peakMode, false, 'not rewound by reloadIfChanged after a failed write');
  assert.equal(s.debug.lastPersistedSeq, st.seq);
  // 当天数据没有被半写:localStorage 里 sheet.seq 不超过最后一次成功写入
  const storedSheet = JSON.parse(m.get(Store.PREFIX + 'sheet.' + D));
  assert.ok(storedSheet.seq <= seqBefore + 1);
});

test('store: doLoad purges dated keys older than 3 days, keeps recent ones', async () => {
  const storage = new Map();
  const old = Store.addDays(D, -10), recent = Store.addDays(D, -1);
  ['bookings.', 'events.', 'sim.', 'sheet.'].forEach(k => { storage.set(Store.PREFIX + k + old, '[]'); storage.set(Store.PREFIX + k + recent, '[]'); });
  storage.set(Store.PREFIX + 'pace', '{}');
  await mkStore({ storage });
  assert.ok(!storage.has(Store.PREFIX + 'bookings.' + old), 'old bookings purged');
  assert.ok(!storage.has(Store.PREFIX + 'sim.' + old), 'old sim purged');
  assert.ok(storage.has(Store.PREFIX + 'bookings.' + recent), 'recent kept');
  assert.ok(storage.has(Store.PREFIX + 'pace'), 'undated keys kept');
});

// ---------- 评审修正:待批准的球童不能记录事件 / 评分;评分须完赛 ----------
test('store: pending caddie cannot postEvent or rate (40301) until approved', async () => {
  const storage = new Map();
  const op = await mkStore({ storage });
  await op.command('patchBooking', { id: 'b0824', patch: { caddieIds: ['c12'] } });
  await op.command('teeOff', { id: 'b0824', t: 504 });
  const caddie = Store.createLocal({ date: D, storage, startClock: false, wallClock: () => FIXED_MS, me: { role: 'caddie', userId: 'c12', name: '小李', caddieNo: '12', bookingId: 'b0824' } });
  await caddie.load(D);
  await rejects(caddie.command('postEvent', { bookingId: 'b0824', holeNo: 1, type: 'leaveGreen', source: 'caddie' }), 40301);
  await rejects(caddie.command('rate', { bookingId: 'b0824', rateeId: find(op.getState(), 'b0824').players[0].id, rateeRole: 'player', stars: 4 }), 40301);
  await op.command('approveCaddie', { id: 'c12' });
  const ev = await caddie.command('postEvent', { bookingId: 'b0824', holeNo: 1, type: 'leaveGreen', source: 'caddie' });
  assert.equal(ev.type, 'leaveGreen');
  await rejects(caddie.command('rate', { bookingId: 'b0824', rateeId: find(op.getState(), 'b0824').players[0].id, rateeRole: 'player', stars: 4 }), 40001);  // 未完赛
});

// ---------- 评审修正:演示时钟不跨日 ----------
test('store: demo clock stops at 24:00 (dayEnded), jumpTo/tick clamp, reset clears', async () => {
  const s = await mkStore();
  const st = s.getState();
  s.demo.jumpTo(2000);
  assert.equal(st.now, Store.DAY_END_MIN); assert.equal(st.dayEnded, true);
  s.demo.tick(5);
  assert.equal(st.now, Store.DAY_END_MIN, 'tick is a no-op after day end');
  assert.equal(st.live.groups.filter(g => g.phase === 'playing' || g.phase === 'between').length, 0, 'everyone finished by midnight');
  // 重新加载同一存储:不会出现 1442 这样的时间
  const s2 = Store.createLocal({ date: D, storage: s.debug.storage, startClock: false, wallClock: () => FIXED_MS });
  await s2.load(D);
  assert.ok(s2.getState().now <= Store.DAY_END_MIN); assert.equal(s2.getState().dayEnded, true);
  s.demo.reset();
  assert.equal(st.now, Store.DEMO_START_MIN); assert.equal(st.dayEnded, false);
});

// ---------- 评审修正:ApiDataSource 重连后释放回退用的 Local ----------
test('store: Local.dispose() stops the clock, drops subscribers and the storage listener', async () => {
  const s = await mkStore();
  let n = 0;
  s.subscribe(() => { n++; });
  s.demo.tick(1);
  assert.ok(n >= 1);
  s.dispose();
  const before = n;
  s.demo.tick(1);
  assert.equal(n, before, 'no notifications after dispose');
});
