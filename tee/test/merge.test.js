'use strict';
const { test, assert, approx } = require('./_harness.js');
const Course = require('../js/course.js');
const Pace = require('../js/pace.js');
const Merge = require('../js/merge.js');

const DATE = '2026-10-06';
const course = Course.normalizeCourse({ holes: Course.demoLayout() });
const holes = course.holes;
const cfg = course.config;

let pidSeq = 0;
function players(n, opts) {
  opts = opts || {};
  const out = [];
  for (let i = 0; i < n; i++) {
    pidSeq++;
    out.push({ id: (opts.idPrefix || 'p') + pidSeq, name: '球员' + pidSeq, isMember: !!(opts.members && opts.members[i]) });
  }
  return out;
}
function booking(id, teeMin, size, extra) {
  extra = extra || {};
  const ps = extra.players || players(size, extra);
  return Object.assign({
    id, date: DATE, routingId: 'r18', teeMin, size, players: ps, caddieIds: extra.caddieIds || [],
    status: 'booked', allowMerge: true, notes: '', createdAt: 0, version: 1
  }, extra.fields || {});
}
function plansFor(bookings, statsById) {
  const out = {};
  bookings.forEach(b => { out[b.id] = Pace.groupPlan(b.players, statsById || {}, cfg, DATE, b.size); });
  return out;
}
function sheet(extra) { return Object.assign({ courseId: 'demo', date: DATE, routingId: 'r18', openMin: 390, closeMin: 960, peakMode: false, fieldHoldMin: 0, seq: 0 }, extra || {}); }
function ctxFor(bookings, extra) {
  extra = extra || {};
  const statsById = extra.statsById || {};
  return Object.assign({
    sheet: sheet(extra.sheet), bookings, holes, cfg: extra.cfg || cfg,
    plansById: extra.plansById || plansFor(bookings, statsById), statsById,
    friendsOf: extra.friendsOf || (() => new Set()), now: extra.now != null ? extra.now : 380, waitlistLen: extra.waitlistLen || 0
  }, extra.ctx || {});
}
// 稳定的慢/快球员统计:nEff 极大 → fPlan ≈ f;roundsScored 1 → 不"置信"(iRec 上限仍为 iMax)
function stats(id, f, roundsScored) { return { playerId: id, f, v: 0.01, nEff: 1e9, lastRoundDate: DATE, roundsScored: roundsScored == null ? 1 : roundsScored }; }

// ---------- isMemberGroup ----------
test('isMemberGroup: any member → true; none / empty → false', () => {
  assert.equal(Merge.isMemberGroup({ players: [{ isMember: false }, { isMember: true }] }), true);
  assert.equal(Merge.isMemberGroup({ players: [{ isMember: false }, {}] }), false);
  assert.equal(Merge.isMemberGroup({ players: [] }), false);
  assert.equal(Merge.isMemberGroup({}), false);
});

// ---------- utilization / peakActive ----------
test('utilization counts active statuses with teeMin in [from, to) over floor((to−from)/iBase) slots', () => {
  const bs = [];
  for (let i = 0; i < 13; i++) bs.push(booking('u' + i, 480 + 8 * i, 4));           // 480..576
  bs.push(booking('cx', 500, 4, { fields: { status: 'cancelled' } }));
  bs.push(booking('ns', 508, 4, { fields: { status: 'noShow' } }));
  bs.push(booking('mg', 516, 4, { fields: { status: 'merged' } }));
  bs.push(booking('oc', 484, 4, { fields: { status: 'onCourse' } }));
  bs.push(booking('ci', 492, 4, { fields: { status: 'checkedIn' } }));
  bs.push(booking('late', 600, 4));                                                  // == to → excluded
  bs.push(booking('early', 479, 4));                                                 // < from → excluded
  // 15 个格子;13 + onCourse + checkedIn = 15
  approx(Merge.utilization(bs, cfg, 480, 600), 1.0);
  approx(Merge.utilization(bs.slice(0, 13), cfg, 480, 600), 13 / 15);
  approx(Merge.utilization(bs, cfg, 480, 484), 0);                                   // 分母 0 → 0
  approx(Merge.utilization([], cfg, 480, 600), 0);
});

test('peakActive: peakMode flag, waitlist, or any sliding 2-hour window ≥ 85%', () => {
  const sparse = [booking('s1', 480, 4), booking('s2', 560, 4), booking('s3', 700, 4)];
  assert.equal(Merge.peakActive(sheet(), sparse, cfg, 0), false);
  assert.equal(Merge.peakActive(sheet({ peakMode: true }), sparse, cfg, 0), true);
  assert.equal(Merge.peakActive(sheet(), sparse, cfg, 1), true);
  // 10:00–12:00 满格(15 组 × 8′):窗口起点 390 + 30×7 = 600 命中
  const dense = [];
  for (let i = 0; i < 15; i++) dense.push(booking('d' + i, 600 + 8 * i, 4));
  assert.equal(Merge.peakActive(sheet(), dense, cfg, 0), true);
  // 13/15 = 0.867 ≥ 0.85 → 旺季;12/15 = 0.8 → 非旺季
  assert.equal(Merge.peakActive(sheet(), dense.slice(0, 13), cfg, 0), true);
  assert.equal(Merge.peakActive(sheet(), dense.slice(0, 12), cfg, 0), false);
  // 阈值可配置
  const c2 = Course.mergeConfig(cfg, { merge: { utilThreshold: 0.5 } });
  assert.equal(Merge.peakActive(sheet(), dense.slice(0, 8), c2, 0), true);
  // 营业时长短于窗口 → 整段计算
  assert.equal(Merge.peakActive(sheet({ openMin: 600, closeMin: 660 }), dense.slice(0, 7), cfg, 0), true);   // 7/7
  assert.equal(Merge.peakActive(sheet({ openMin: 600, closeMin: 660 }), dense.slice(0, 5), cfg, 0), false);  // 5/7
});

// ---------- candidate filters ----------
test('candidate filters: status, allowMerge, party size, total size, time window, pace tolerance', () => {
  const a = booking('a', 640, 2);
  const ok = booking('b', 648, 1);
  const plans = plansFor([a, ok]);
  assert.equal(Merge.isCandidatePair(a, ok, cfg, plans), true);
  assert.equal(Merge.isCandidatePair(a, a, cfg, plans), false);
  // 状态
  ['onCourse', 'finished', 'noShow', 'cancelled', 'merged'].forEach(st => {
    assert.equal(Merge.isCandidatePair(a, booking('b', 648, 1, { fields: { status: st } }), cfg, plans), false, st);
  });
  assert.equal(Merge.isCandidatePair(a, booking('b', 648, 1, { fields: { status: 'checkedIn' } }), cfg, plans), true);
  // allowMerge
  assert.equal(Merge.isCandidatePair(a, booking('b', 648, 1, { fields: { allowMerge: false } }), cfg, plans), false);
  assert.equal(Merge.isCandidatePair(booking('a', 640, 2, { fields: { allowMerge: false } }), ok, cfg, plans), false);
  // 单方人数 ≤ maxPartySize(2)
  assert.equal(Merge.isCandidatePair(a, booking('b', 648, 3, {}), cfg, plans), false);
  // 合计 ≤ maxSize(4)
  assert.equal(Merge.isCandidatePair(a, booking('b', 648, 2, {}), cfg, plans), true);
  const c5 = Course.mergeConfig(cfg, { merge: { maxSize: 3 } });
  assert.equal(Merge.isCandidatePair(a, booking('b', 648, 2, {}), c5, plans), false);
  // 时间窗 |ΔT| ≤ windowMin(30)
  assert.equal(Merge.isCandidatePair(a, booking('b', 670, 1, {}), cfg, plans), true);
  assert.equal(Merge.isCandidatePair(a, booking('b', 671, 1, {}), cfg, plans), false);
  assert.equal(Merge.isCandidatePair(a, booking('b', 610, 1, {}), cfg, plans), true);
  assert.equal(Merge.isCandidatePair(a, booking('b', 609, 1, {}), cfg, plans), false);
  // 步速容差 |Δf| ≤ paceTol(0.2)
  assert.equal(Merge.isCandidatePair(a, ok, cfg, { a: { fPlan: 1.0 }, b: { fPlan: 1.2 } }), true);
  assert.equal(Merge.isCandidatePair(a, ok, cfg, { a: { fPlan: 1.0 }, b: { fPlan: 1.21 } }), false);
  assert.equal(Merge.isCandidatePair(a, ok, cfg, { a: { fPlan: 0.8 }, b: { fPlan: 1.0 } }), true);
  assert.equal(Merge.isCandidatePair(a, ok, cfg, { a: { fPlan: 0.79 }, b: { fPlan: 1.0 } }), false);
  // 缺计划 → fPlan 1
  assert.equal(Merge.isCandidatePair(a, ok, cfg, {}), true);
  // 不同日期不配对
  assert.equal(Merge.isCandidatePair(a, booking('b', 648, 1, { fields: { date: '2026-10-07' } }), cfg, plans), false);
});

// ---------- score ----------
test('score components: pace, time, sizeFit, sameTier, friends', () => {
  const a = booking('a', 640, 2);
  const b = booking('b', 648, 1);
  const none = () => new Set();
  // Δf 0 → 25;ΔT 8 → 20×(1−8/30);2+1=3 → 0.6 → 6;同档(都非会员)→ 10
  let s = Merge.scorePair(a, b, cfg, { a: { fPlan: 1 }, b: { fPlan: 1 } }, none);
  approx(s.score, 25 + 20 * (1 - 8 / 30) + 6 + 10, 1e-9);
  assert.equal(s.friends, 0); assert.equal(s.sameTier, 1); approx(s.sizeFit, 0.6);
  // Δf 0.1 → 12.5
  s = Merge.scorePair(a, b, cfg, { a: { fPlan: 1 }, b: { fPlan: 1.1 } }, none);
  approx(s.score, 12.5 + 20 * (1 - 8 / 30) + 6 + 10, 1e-9);
  // 同一时段 ΔT 0 → 20;2+2=4 → 10
  const b2 = booking('b2', 640, 2);
  s = Merge.scorePair(a, b2, cfg, { a: { fPlan: 1 }, b2: { fPlan: 1 } }, none);
  approx(s.score, 25 + 20 + 10 + 10, 1e-9);
  // 1+1=2 → 0.3 → 3
  const a1 = booking('a1', 640, 1), b1 = booking('b1', 650, 1);
  s = Merge.scorePair(a1, b1, cfg, {}, none);
  approx(s.score, 25 + 20 * (1 - 10 / 30) + 3 + 10, 1e-9);
  // 一方会员、无好友 → sameTier 0
  const m = booking('m', 648, 1, { members: [true] });
  s = Merge.scorePair(a, m, cfg, {}, none);
  assert.equal(s.sameTier, 0);
  approx(s.score, 25 + 20 * (1 - 8 / 30) + 6, 1e-9);
  // 好友 → +35 且 sameTier 恢复为 1(即使会员等级不同)
  const friendsOf = id => (id === m.players[0].id ? new Set([a.players[0].id]) : new Set());
  s = Merge.scorePair(a, m, cfg, {}, friendsOf);
  assert.equal(s.friends, 1); assert.equal(s.sameTier, 1);
  approx(s.score, 35 + 25 + 20 * (1 - 8 / 30) + 6 + 10, 1e-9);
  // friendsOf 反向(a 的球员的好友集中含 m 的球员)同样算好友;数组也接受
  const friendsOf2 = id => (id === a.players[1].id ? [m.players[0].id] : []);
  assert.equal(Merge.friendsBetween(a, m, friendsOf2), 1);
  assert.equal(Merge.friendsBetween(a, m, null), 0);
});

// ---------- keep rule ----------
test('keep rule: member side keeps; else larger party; tie → earlier slot (then id)', () => {
  const reg2 = booking('r2', 648, 2);
  const mem1 = booking('m1', 640, 1, { members: [true] });
  assert.equal(Merge.keepSide(reg2, mem1), 'b');            // 会员方保留(即使人少、时间晚)
  assert.equal(Merge.keepSide(mem1, reg2), 'a');
  const reg1 = booking('r1', 630, 1);
  assert.equal(Merge.keepSide(reg1, reg2), 'b');            // 人多者
  assert.equal(Merge.keepSide(reg2, reg1), 'a');
  const r1b = booking('r1b', 640, 1);
  assert.equal(Merge.keepSide(reg1, r1b), 'a');             // 同人数 → 较早
  assert.equal(Merge.keepSide(r1b, reg1), 'b');
  const sameT1 = booking('x', 640, 1), sameT2 = booking('y', 640, 1);
  assert.equal(Merge.keepSide(sameT2, sameT1), 'b');        // 同时间 → id 较小
  // 双方都有会员 → 回到人数规则
  const mem2 = booking('m2', 650, 2, { members: [true, false] });
  assert.equal(Merge.keepSide(mem1, mem2), 'b');
});

// ---------- feasibility ----------
test('feasibility: follower already held behind a; merging a+b (keep a, same fPlan) → ok, shift 0', () => {
  // a(2 人,f≈1.1)@480,c(4 人)@488 已被 a 阻挡(第 3 洞等待),b(1 人,f≈1.1)@500
  const a = booking('a', 480, 2);
  const c = booking('c', 488, 4);
  const b = booking('b', 500, 1);
  const statsById = {};
  a.players.concat(b.players).forEach(p => { statsById[p.id] = stats(p.id, 1.1); });
  const bookings = [a, c, b];
  const ctx = ctxFor(bookings, { statsById });
  approx(ctx.plansById.a.fPlan, 1.1, 1e-6);
  approx(ctx.plansById.b.fPlan, 1.1, 1e-6);
  const base = Merge.baselineFor(ctx);
  assert.ok(base.c.waitMin > 1, 'c is held behind a in the baseline (' + base.c.waitMin + ')');
  const fe = Merge.checkPair(ctx, a, b, 'a', base);
  assert.equal(fe.ok, true, JSON.stringify(fe.result));
  assert.equal(fe.result.reason, undefined);
  approx(fe.plan.fPlan, 1.1, 1e-6);
  assert.equal(fe.group.id, 'a'); assert.equal(fe.group.tee, 480); assert.equal(fe.group.size, 3);
  // c 的投影与今天表完全一致(偏移 0)
  const after = Pace.projectSheet(holes, Pace.insertCand(Pace.sheetGroups([c], ctx.plansById), fe.group)).byId;
  for (let i = 0; i < holes.length; i++) {
    approx(after.c.rows[i].start, base.c.rows[i].start, 1e-9);
    approx(after.c.rows[i].finish, base.c.rows[i].finish, 1e-9);
  }
  // 入参未被修改
  assert.equal(a.size, 2); assert.equal(bookings.length, 3); assert.equal(a.players.length, 2);
});

test('feasibility: a slower merged group that would delay the next group → IMPACTS_BEHIND → dropped by suggest', () => {
  // a(2 人,未知 → f 1.0)@480,c(4 人)@488,b(1 人,慢 f 1.2)@496;合并后 fPlan ≈ 1.147 → c 在第 3 洞被推迟
  const a = booking('a', 480, 2);
  const c = booking('c', 488, 4);
  const b = booking('b', 496, 1);
  const statsById = {}; statsById[b.players[0].id] = stats(b.players[0].id, 1.2);
  const ctx = ctxFor([a, c, b], { statsById, sheet: { peakMode: true } });
  assert.equal(Merge.isCandidatePair(a, b, cfg, ctx.plansById), true);
  const fe = Merge.checkPair(ctx, a, b, 'a');
  assert.equal(fe.ok, false);
  assert.equal(fe.result.reason, 'IMPACTS_BEHIND');
  assert.equal(fe.result.victimId, 'c');
  assert.ok(fe.result.shiftMin > 1);
  assert.ok(fe.plan.fPlan > 1.1 && fe.plan.fPlan < 1.2);
  assert.deepEqual(Merge.suggest(ctx), []);
  // 同一对,若 c 不存在 → 可行
  const ctx2 = ctxFor([a, b], { statsById, sheet: { peakMode: true } });
  const list = Merge.suggest(ctx2);
  assert.equal(list.length, 1);
  assert.equal(list[0].a, 'a'); assert.equal(list[0].b, 'b'); assert.equal(list[0].keep, 'a');
});

test('feasibility: merged group keeps the keep side slot; GAP checks apply vs neighbours', () => {
  // keep 方 b(会员)@496,a@480;移除 a,b 后 b' 与前组 p@490 只差 6′ < 8 → GAP_AHEAD
  const p = booking('p', 490, 4);
  const a = booking('a', 480, 1);
  const b = booking('b', 496, 1, { members: [true] });
  const ctx = ctxFor([a, p, b]);
  const fe = Merge.checkPair(ctx, a, b);
  assert.equal(fe.keep, 'b');
  assert.equal(fe.group.tee, 496);
  assert.equal(fe.ok, false);
  assert.equal(fe.result.reason, 'GAP_AHEAD');
});

// ---------- suggest: demo pair, greedy disjointness, maxShare ----------
function demoSheet() {
  // 8 分钟网格的旺季表:其余均为 3/4 人组,仅 10:40(2 人)+10:48(1 人)可并
  const bs = [];
  let n = 0;
  for (let t = 392; t <= 664; t += 8) {          // 06:32 起的 8 分钟网格,640/648 在格上
    if (t === 640 || t === 648) continue;
    bs.push(booking('g' + (n++), t, (n % 2) ? 4 : 3));
  }
  bs.push(booking('two', 640, 2));
  bs.push(booking('one', 648, 1));
  return bs;
}

test('demo pair: 2-some 10:40 + 1-some 10:48 in a peakMode sheet → exactly one proposal, keep the 2-some, 640/648', () => {
  const bs = demoSheet();
  const ctx = ctxFor(bs, { sheet: { peakMode: true }, now: 380 });
  const list = Merge.suggest(ctx);
  assert.equal(list.length, 1);
  const p = list[0];
  assert.equal(p.id, 'm-two-one');
  assert.equal(p.date, DATE);
  assert.equal(p.a, 'two'); assert.equal(p.b, 'one');
  assert.equal(p.keep, 'a');
  assert.equal(p.targetTeeMin, 640);
  assert.equal(p.freedTeeMin, 648);
  assert.equal(p.status, 'suggested');
  assert.deepEqual(p.decisions, {});
  assert.equal(p.createdAt, 380);
  approx(p.score, 25 + 20 * (1 - 8 / 30) + 6 + 10, 1e-9);
  // expiresAt = min(380 + 1440, 640 − 120) = 520
  assert.equal(p.expiresAt, 520);
  // 确定性:再算一次结果相同
  assert.deepEqual(Merge.suggest(ctx), list);
  // 该表 06:32–11:04 满格 → 即使 peakMode=false,利用率窗口也触发旺季
  assert.equal(Merge.suggest(ctxFor(bs, { sheet: { peakMode: false } })).length, 1);
  // 阈值抬高到不可达 + peakMode=false → 非旺季 → 无建议(同一张表)
  const quiet = Course.mergeConfig(cfg, { merge: { utilThreshold: 1.01 } });
  assert.deepEqual(Merge.suggest(ctxFor(bs, { sheet: { peakMode: false }, cfg: quiet })), []);
  // 候补 > 0 亦触发
  assert.equal(Merge.suggest(ctxFor(bs, { sheet: { peakMode: false }, cfg: quiet, waitlistLen: 2 })).length, 1);
  assert.equal(Merge.suggest(ctxFor(bs, { sheet: { peakMode: true }, cfg: quiet })).length, 1);
  // 输入未被修改
  assert.equal(bs.find(x => x.id === 'two').size, 2);
  assert.equal(bs.find(x => x.id === 'one').status, 'booked');
});

test('suggest: greedy disjoint selection by score desc; maxShare cap; infeasible pairs skipped', () => {
  // 三个 1 人组 x@600, y@608, z@616(其余为 4 人组,表很空 → 对任何合并都可行)
  const x = booking('x', 600, 1), y = booking('y', 608, 1), z = booking('z', 616, 1);
  const filler = [booking('f1', 500, 4), booking('f2', 700, 4)];
  const bs = filler.concat([x, y, z]);
  // 候选对:xy(ΔT 8)、yz(ΔT 8)、xz(ΔT 16) → 3 对;cap = ceil(0.3×3) = 1
  let ctx = ctxFor(bs, { sheet: { peakMode: true } });
  let pairs = Merge.candidatePairs(ctx);
  assert.deepEqual(pairs.map(p => p.a.id + p.b.id), ['xy', 'yz', 'xz']);
  let list = Merge.suggest(ctx);
  assert.equal(list.length, 1);
  assert.equal(list[0].id, 'm-x-y');
  // 放宽 maxShare → 互斥:xy 选中后 yz(含 y)跳过、xz(含 x)跳过 → 仍只有 1 个
  const c1 = Course.mergeConfig(cfg, { merge: { maxShare: 1 } });
  list = Merge.suggest(ctxFor(bs, { sheet: { peakMode: true }, cfg: c1 }));
  assert.equal(list.length, 1); assert.equal(list[0].id, 'm-x-y');
  // 四个 1 人组:xy、zw 两对不相交 → maxShare 1 下给出 2 个;默认 0.3 × 6 对 = ceil(1.8) = 2 → 也是 2
  const w = booking('w', 624, 1);
  const bs4 = filler.concat([x, y, z, w]);
  list = Merge.suggest(ctxFor(bs4, { sheet: { peakMode: true }, cfg: c1 }));
  assert.deepEqual(list.map(p => p.id).sort(), ['m-x-y', 'm-z-w']);
  list = Merge.suggest(ctxFor(bs4, { sheet: { peakMode: true } }));
  assert.equal(list.length, 2);
  // 更低上限:maxShare 0.1 × 6 = ceil(0.6) = 1
  const c2 = Course.mergeConfig(cfg, { merge: { maxShare: 0.1 } });
  list = Merge.suggest(ctxFor(bs4, { sheet: { peakMode: true }, cfg: c2 }));
  assert.equal(list.length, 1);
  // 好友提升分数改变选取顺序:y–z 为好友 → yz 排第一 → 选 yz,xw(ΔT 24)仍可行 → [yz, xw]
  const friendsOf = id => (id === y.players[0].id ? new Set([z.players[0].id]) : new Set());
  ctx = ctxFor(bs4, { sheet: { peakMode: true }, cfg: c1, friendsOf });
  pairs = Merge.candidatePairs(ctx);
  assert.equal(pairs[0].a.id + pairs[0].b.id, 'yz');
  list = Merge.suggest(ctx);
  assert.deepEqual(list.map(p => p.id), ['m-y-z', 'm-x-w']);
  // 不可行的高分对被跳过,改选次优对:
  // q(2 人未知)@600, c(4 人)@608, r(慢 1 人 f1.2)@616, v(1 人)@632
  //   候选:q+r(ΔT 16, sizeFit 0.6 → 分高)、r+v(ΔT 16, sizeFit 0.3 → 分低);q+v ΔT 32 > 30 不配对
  //   q+r 保留 q@600 且合并后 fPlan ≈ 1.147 → 紧随其后的 c 被推迟 → 跳过;r+v 保留 r@616,其后无人 → 可行
  const q = booking('q', 600, 2), c = booking('c', 608, 4), r = booking('r', 616, 1), v = booking('v', 632, 1);
  const statsById = {}; statsById[r.players[0].id] = stats(r.players[0].id, 1.2);
  const ctx3 = ctxFor(filler.concat([q, c, r, v]), { sheet: { peakMode: true }, statsById });
  const pairs3 = Merge.candidatePairs(ctx3);
  assert.deepEqual(pairs3.map(p => p.a.id + p.b.id), ['qr', 'rv']);
  assert.ok(pairs3[0].score > pairs3[1].score);
  const feQR = Merge.checkPair(ctx3, q, r);
  assert.equal(feQR.ok, false); assert.equal(feQR.result.reason, 'IMPACTS_BEHIND'); assert.equal(feQR.result.victimId, 'c');
  const list3 = Merge.suggest(ctx3);
  assert.deepEqual(list3.map(p => p.id), ['m-r-v']);
  assert.equal(list3[0].keep, 'a'); assert.equal(list3[0].targetTeeMin, 616); assert.equal(list3[0].freedTeeMin, 632);
});

test('suggest: proposal ids deterministic and a is the earlier slot; empty inputs are safe', () => {
  assert.equal(Merge.proposalId({ id: 'A' }, { id: 'B' }), 'm-A-B');
  assert.deepEqual(Merge.suggest(ctxFor([], { sheet: { peakMode: true } })), []);
  assert.deepEqual(Merge.suggest({ sheet: sheet({ peakMode: true }), bookings: [], holes, cfg }), []);
  const late = booking('late', 650, 1), early = booking('early', 640, 1);
  const list = Merge.suggest(ctxFor([late, early], { sheet: { peakMode: true } }));
  assert.equal(list.length, 1);
  assert.equal(list[0].a, 'early'); assert.equal(list[0].b, 'late'); assert.equal(list[0].id, 'm-early-late');
  assert.equal(list[0].keep, 'a'); assert.equal(list[0].targetTeeMin, 640); assert.equal(list[0].freedTeeMin, 650);
});

test('suggest honours sheet.fieldHoldMin consistently (no spurious GAP_AHEAD)', () => {
  const bs = demoSheet();
  const list = Merge.suggest(ctxFor(bs, { sheet: { peakMode: true, fieldHoldMin: 15 } }));
  assert.equal(list.length, 1);
  assert.equal(list[0].targetTeeMin, 640);       // 提议记录的是预订时间,不含全场暂停
});

// ---------- expiresAt ----------
test('expiresAt = min(createdAt + expireHours×60, targetTeeMin − expireBeforeTeeMin)', () => {
  assert.equal(Merge.expiresAtFor(380, 640, cfg), 520);          // 640 − 120 binds
  assert.equal(Merge.expiresAtFor(380, 2000, cfg), 1820);        // 380 + 1440 binds
  const c = Course.mergeConfig(cfg, { merge: { expireHours: 1, expireBeforeTeeMin: 30 } });
  assert.equal(Merge.expiresAtFor(500, 700, c), 560);
  assert.equal(Merge.expiresAtFor(500, 520, c), 490);            // 可早于 createdAt(离开球不足 expireBeforeTeeMin)
  const p = { status: 'proposed', expiresAt: 520 };
  assert.equal(Merge.isExpired(p, 519), false);
  assert.equal(Merge.isExpired(p, 520), true);
  assert.equal(Merge.isExpired({ status: 'applied', expiresAt: 520 }, 999), false);
});

// ---------- transition ----------
function prop(status, decisions) {
  return { id: 'm-a-b', date: DATE, a: 'a', b: 'b', keep: 'a', targetTeeMin: 640, freedTeeMin: 648, score: 50, status,
    decisions: decisions || {}, createdAt: 380, expiresAt: 520 };
}
const ALL = ['suggested', 'proposed', 'accepted_a', 'accepted_b', 'confirmed', 'applied', 'declined', 'expired', 'withdrawn'];
function allowed(status, action, side) {
  try { Merge.transition(prop(status), action, side, 400); return true; } catch (e) { assert.equal(e.code, 'INVALID_TRANSITION'); return false; }
}

test('transition happy path: propose → accept a → accept b → confirmed → apply', () => {
  const p0 = prop('suggested');
  const p1 = Merge.transition(p0, 'propose', null, 400);
  assert.equal(p1.status, 'proposed'); assert.equal(p1.proposedAt, 400);
  assert.equal(p0.status, 'suggested');                           // 不修改入参
  const p2 = Merge.transition(p1, 'accept', 'a', 401);
  assert.equal(p2.status, 'accepted_a'); assert.equal(p2.decisions.a, 'accept'); assert.equal(p2.decisions.b, undefined);
  assert.deepEqual(p1.decisions, {});
  const p3 = Merge.transition(p2, 'accept', 'b', 402);
  assert.equal(p3.status, 'confirmed'); assert.equal(p3.decisions.a, 'accept'); assert.equal(p3.decisions.b, 'accept');
  const p4 = Merge.transition(p3, 'apply', null, 403);
  assert.equal(p4.status, 'applied'); assert.equal(p4.appliedAt, 403);
  assert.equal(p4.id, 'm-a-b'); assert.equal(p4.keep, 'a'); assert.equal(p4.expiresAt, 520);
  // b 先接受亦可
  const q = Merge.transition(Merge.transition(p1, 'accept', 'b', 1), 'accept', 'a', 2);
  assert.equal(q.status, 'confirmed');
});

test('transition table: every (state, action) pair', () => {
  const table = {
    propose:  { suggested: true },
    'accept:a': { proposed: true, accepted_b: true },
    'accept:b': { proposed: true, accepted_a: true },
    'decline:a': { proposed: true, accepted_a: true, accepted_b: true },
    'decline:b': { proposed: true, accepted_a: true, accepted_b: true },
    withdraw: { suggested: true, proposed: true, accepted_a: true, accepted_b: true, confirmed: true },
    expire:   { suggested: true, proposed: true, accepted_a: true, accepted_b: true, confirmed: true },
    apply:    { confirmed: true }
  };
  Object.keys(table).forEach(key => {
    const parts = key.split(':');
    ALL.forEach(st => {
      assert.equal(allowed(st, parts[0], parts[1] || null), !!table[key][st], st + ' --' + key + '-->');
    });
  });
  // 结果状态
  assert.equal(Merge.transition(prop('proposed'), 'decline', 'b', 1).status, 'declined');
  assert.equal(Merge.transition(prop('accepted_a'), 'decline', 'b', 1).decisions.b, 'decline');
  assert.equal(Merge.transition(prop('confirmed'), 'withdraw', null, 1, '时段已不可行').note, '时段已不可行');
  assert.equal(Merge.transition(prop('suggested'), 'expire', null, 1).status, 'expired');
  // 非法 side / 非法 action / 空提议
  assert.throws(() => Merge.transition(prop('proposed'), 'accept', null, 1));
  assert.throws(() => Merge.transition(prop('proposed'), 'accept', 'c', 1));
  assert.throws(() => Merge.transition(prop('proposed'), 'decline', null, 1));
  assert.throws(() => Merge.transition(prop('proposed'), 'bogus', null, 1));
  assert.throws(() => Merge.transition(null, 'propose', null, 1));
  // 同一方重复接受 → 非法
  assert.throws(() => Merge.transition(prop('accepted_a'), 'accept', 'a', 1));
  // 终结状态不可再变
  ['applied', 'declined', 'expired', 'withdrawn'].forEach(st => {
    assert.equal(Merge.isTerminal(prop(st)), true);
    ['propose', 'withdraw', 'expire', 'apply'].forEach(ac => assert.throws(() => Merge.transition(prop(st), ac, null, 1), st + ' ' + ac));
    assert.throws(() => Merge.transition(prop(st), 'accept', 'a', 1));
    assert.throws(() => Merge.transition(prop(st), 'decline', 'a', 1));
  });
  assert.equal(Merge.isTerminal(prop('confirmed')), false);
});

// ---------- apply ----------
test('apply: keep absorbs size/players/caddies; other → merged with mergedInto; inputs untouched', () => {
  const a = booking('a', 640, 2, { caddieIds: ['c7'] });
  const b = booking('b', 648, 1, { caddieIds: ['c7', 'c12'] });
  const other = booking('o', 700, 4);
  const bookings = [other, a, b];
  const p = prop('confirmed');
  const out = Merge.apply(bookings, p);
  assert.notEqual(out, bookings);
  assert.equal(out.length, 3);
  assert.equal(out[0], other);                                     // 未涉及的预订按引用保留
  const ka = out[1], mb = out[2];
  assert.equal(ka.id, 'a'); assert.equal(ka.size, 3); assert.equal(ka.teeMin, 640); assert.equal(ka.status, 'booked');
  assert.deepEqual(ka.players.map(x => x.id), a.players.concat(b.players).map(x => x.id));
  assert.deepEqual(ka.caddieIds, ['c7', 'c12']);
  assert.equal(mb.id, 'b'); assert.equal(mb.status, 'merged'); assert.equal(mb.mergedInto, 'a'); assert.equal(mb.size, 1);
  // 入参不变
  assert.equal(a.size, 2); assert.equal(a.players.length, 2); assert.deepEqual(a.caddieIds, ['c7']);
  assert.equal(b.status, 'booked'); assert.equal(b.mergedInto, undefined);
  // keep = 'b'
  const out2 = Merge.apply(bookings, Object.assign({}, p, { keep: 'b' }));
  assert.equal(out2[2].size, 3); assert.equal(out2[2].status, 'booked');
  assert.equal(out2[1].status, 'merged'); assert.equal(out2[1].mergedInto, 'b');
  // 重复球员按 id 去重
  const shared = a.players[0];
  const b3 = booking('b3', 648, 1, { players: [shared] });
  const out3 = Merge.apply([a, b3], Object.assign({}, p, { b: 'b3' }));
  assert.equal(out3[0].players.length, 2); assert.equal(out3[0].size, 3);
  // 找不到预订 → throws
  assert.throws(() => Merge.apply([a], p));
});

test('end-to-end: suggest → propose → accept both → apply → merged bookings no longer candidates', () => {
  const bs = demoSheet();
  const ctx = ctxFor(bs, { sheet: { peakMode: true } });
  let p = Merge.suggest(ctx)[0];
  p = Merge.transition(p, 'propose', null, 390);
  p = Merge.transition(p, 'accept', 'a', 391);
  p = Merge.transition(p, 'accept', 'b', 392);
  const applied = Merge.apply(bs, p);
  p = Merge.transition(p, 'apply', null, 393);
  assert.equal(p.status, 'applied');
  const two = applied.find(x => x.id === 'two'), one = applied.find(x => x.id === 'one');
  assert.equal(two.size, 3); assert.equal(one.status, 'merged');
  const again = Merge.suggest(ctxFor(applied, { sheet: { peakMode: true } }));
  assert.deepEqual(again, []);
  // 利用率:merged 不再占格
  assert.ok(Merge.utilization(applied, cfg, 640, 656) < Merge.utilization(bs, cfg, 640, 656));
});
