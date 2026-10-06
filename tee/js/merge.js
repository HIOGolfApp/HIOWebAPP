/*
 * HIOTee.Merge — 旺季并组建议(SPEC §6)。
 * 职责:利用率/旺季判定、候选配对与打分、保留方规则("会员优先保留原时间")、可行性复核
 * (并组后不得让今天表上任何后组更晚开球或完成)、贪心互斥选取(maxShare 上限)、
 * 提议状态机(suggested → proposed → accepted_a/b → confirmed → applied,以及 declined/expired/withdrawn)、
 * 应用并组(保留方吸收人数/球员/球童,另一方标记 merged)。
 * 纯函数库:不读时钟、不随机、不碰 DOM;`now` 一律由调用方以"自午夜起的分钟数"传入;不修改任何入参对象。
 * 依赖:Course, Pace。浏览器下挂在 root.HIOTee.Merge,Node 下 module.exports。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./course.js'), require('./pace.js'));
  } else {
    root.HIOTee = root.HIOTee || {};
    root.HIOTee.Merge = factory(root.HIOTee.Course, root.HIOTee.Pace);
  }
})(typeof self !== 'undefined' ? self : this, function (Course, Pace) {
  'use strict';

  var EPS = Course.EPS;

  function hasOwn(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  function assign(target) {
    for (var i = 1; i < arguments.length; i++) {
      var src = arguments[i];
      if (!src) continue;
      for (var k in src) if (hasOwn(src, k)) target[k] = src[k];
    }
    return target;
  }
  function mergeCfg(cfg) {
    var d = Course.defaultConfig().merge;
    return assign({}, d, (cfg && cfg.merge) || {});
  }

  var ACTIVE_STATUS = { booked: true, checkedIn: true, onCourse: true };   // 占用时段的状态(利用率统计)
  var CAND_STATUS = { booked: true, checkedIn: true };                      // 可并组的状态(尚未开球)

  // ---------- 会员组 ----------
  function isMemberGroup(b) {
    var ps = (b && b.players) || [];
    for (var i = 0; i < ps.length; i++) if (ps[i] && ps[i].isMember) return true;
    return false;
  }

  // ---------- 利用率 ----------
  // count(status ∈ booked|checkedIn|onCourse 且 teeMin ∈ [from, to)) / floor((to−from)/iBase);分母为 0 → 0
  function utilization(bookings, cfg, fromMin, toMin) {
    var iBase = (cfg && isNum(cfg.iBase) && cfg.iBase > 0) ? cfg.iBase : 8;
    var slots = Math.floor((toMin - fromMin) / iBase + EPS);
    if (!(slots > 0)) return 0;
    var n = 0;
    for (var i = 0; i < (bookings || []).length; i++) {
      var b = bookings[i];
      if (!b || !ACTIVE_STATUS[b.status]) continue;
      if (b.teeMin >= fromMin - EPS && b.teeMin < toMin - EPS) n++;
    }
    return n / slots;
  }

  // 旺季判定:sheet.peakMode || 候补 > 0 || 任一滑动窗口 [openMin + 30k, +windowHours×60) 的利用率 ≥ utilThreshold
  function peakActive(sheet, bookings, cfg, waitlistLen) {
    sheet = sheet || {};
    if (sheet.peakMode) return true;
    if (isNum(waitlistLen) && waitlistLen > 0) return true;
    var mc = mergeCfg(cfg);
    var openMin = isNum(sheet.openMin) ? sheet.openMin : 390;
    var closeMin = isNum(sheet.closeMin) ? sheet.closeMin : 960;
    var len = mc.windowHours * 60;
    if (!(len > 0)) return false;
    if (closeMin - openMin < len - EPS) {
      // 营业时长短于窗口:退化为整段
      return closeMin > openMin && utilization(bookings, cfg, openMin, closeMin) >= mc.utilThreshold - EPS;
    }
    for (var start = openMin; start + len <= closeMin + EPS; start += 30) {
      if (utilization(bookings, cfg, start, start + len) >= mc.utilThreshold - EPS) return true;
    }
    return false;
  }

  // ---------- 候选配对 ----------
  function planFPlan(plansById, id) {
    var p = plansById && plansById[id];
    return (p && isNum(p.fPlan)) ? p.fPlan : 1;
  }

  // 单个预订是否可参与并组:状态 booked|checkedIn、allowMerge 未被关闭、人数 1..maxPartySize
  function isMergeable(b, cfg) {
    var mc = mergeCfg(cfg);
    if (!b || !CAND_STATUS[b.status]) return false;
    if (b.allowMerge === false) return false;
    if (!isNum(b.size) || b.size < 1 || b.size > mc.maxPartySize) return false;
    if (!isNum(b.teeMin)) return false;
    return true;
  }

  // a, b 是否构成候选对(§6 candidates 行)
  function isCandidatePair(a, b, cfg, plansById) {
    var mc = mergeCfg(cfg);
    if (!isMergeable(a, cfg) || !isMergeable(b, cfg)) return false;
    if (a.id === b.id) return false;
    if (a.date && b.date && a.date !== b.date) return false;
    if (a.size + b.size > mc.maxSize) return false;
    if (Math.abs(a.teeMin - b.teeMin) > mc.windowMin + EPS) return false;
    if (Math.abs(planFPlan(plansById, a.id) - planFPlan(plansById, b.id)) > mc.paceTol + EPS) return false;
    return true;
  }

  function setHas(s, id) {
    if (!s) return false;
    if (typeof s.has === 'function') return s.has(id);
    if (typeof s.indexOf === 'function') return s.indexOf(id) >= 0;
    if (typeof s === 'object') return !!s[id];
    return false;
  }

  // friends(a,b) = 1 若 a 的任一球员 ∈ friendsOf(b 的任一球员)(双向检查),否则 0
  function friendsBetween(a, b, friendsOf) {
    if (typeof friendsOf !== 'function') return 0;
    var pa = (a && a.players) || [], pb = (b && b.players) || [];
    for (var i = 0; i < pa.length; i++) {
      if (!pa[i] || pa[i].id == null) continue;
      for (var j = 0; j < pb.length; j++) {
        if (!pb[j] || pb[j].id == null) continue;
        if (setHas(friendsOf(pb[j].id), pa[i].id) || setHas(friendsOf(pa[i].id), pb[j].id)) return 1;
      }
    }
    return 0;
  }

  var SIZE_FIT = { 4: 1, 3: 0.6, 2: 0.3 };
  function sizeFit(total) { return hasOwn(SIZE_FIT, total) ? SIZE_FIT[total] : 0; }

  // 打分:35·friends + 25·(1 − |Δf|/paceTol) + 20·(1 − |ΔT|/windowMin) + 10·sizeFit + 10·sameTier
  function scorePair(a, b, cfg, plansById, friendsOf) {
    var mc = mergeCfg(cfg);
    var friends = friendsBetween(a, b, friendsOf);
    var sameTier = (isMemberGroup(a) === isMemberGroup(b)) || friends === 1 ? 1 : 0;
    var df = Math.abs(planFPlan(plansById, a.id) - planFPlan(plansById, b.id));
    var dt = Math.abs(a.teeMin - b.teeMin);
    var paceTerm = mc.paceTol > 0 ? Math.max(0, 1 - df / mc.paceTol) : (df <= EPS ? 1 : 0);
    var timeTerm = mc.windowMin > 0 ? Math.max(0, 1 - dt / mc.windowMin) : (dt <= EPS ? 1 : 0);
    var fit = sizeFit(a.size + b.size);
    return {
      score: 35 * friends + 25 * paceTerm + 20 * timeTerm + 10 * fit + 10 * sameTier,
      friends: friends, sameTier: sameTier, paceTerm: paceTerm, timeTerm: timeTerm, sizeFit: fit, dF: df, dT: dt
    };
  }

  // 保留方:恰有一方含会员 → 该方("会员优先保留原时间");否则人数多者;再平 → 较早时段((teeMin, id) 序)
  function keepSide(a, b) {
    var ma = isMemberGroup(a), mb = isMemberGroup(b);
    if (ma !== mb) return ma ? 'a' : 'b';
    if (a.size !== b.size) return a.size > b.size ? 'a' : 'b';
    return Course.compareByTee({ tee: a.teeMin, id: a.id }, { tee: b.teeMin, id: b.id }) <= 0 ? 'a' : 'b';
  }

  // 球员并集(按 id 去重;无 id 的球员全部保留)
  function unionPlayers(pa, pb) {
    var out = [], seen = {};
    var all = (pa || []).concat(pb || []);
    for (var i = 0; i < all.length; i++) {
      var p = all[i];
      if (!p) continue;
      if (p.id != null) {
        if (seen[p.id]) continue;
        seen[p.id] = true;
      }
      out.push(p);
    }
    return out;
  }
  function unionIds(xa, xb) {
    var out = [], seen = {};
    var all = (xa || []).concat(xb || []);
    for (var i = 0; i < all.length; i++) {
      if (all[i] == null || seen[all[i]]) continue;
      seen[all[i]] = true;
      out.push(all[i]);
    }
    return out;
  }

  // ---------- 可行性 ----------
  function sheetOpts(ctx) {
    var sheet = ctx.sheet || {};
    return { fieldHoldMin: isNum(sheet.fieldHoldMin) ? sheet.fieldHoldMin : 0, progressById: ctx.progressById, order: ctx.order };
  }

  // 今天表的基准投影(全部有效预订),供所有候选对共用
  function baselineFor(ctx) {
    var full = Pace.sheetGroups(ctx.bookings, ctx.plansById, sheetOpts(ctx));
    return Pace.projectSheet(ctx.holes, full).byId;
  }

  // 并组后的新组(PGroup)与规划因子
  function mergedGroup(ctx, a, b, keep) {
    var keepB = keep === 'b' ? b : a;
    var size = a.size + b.size;
    var players = unionPlayers(a.players, b.players);
    var plan = Pace.groupPlan(players, ctx.statsById || {}, ctx.cfg, ctx.sheet ? ctx.sheet.date : undefined, size);
    var g = Pace.toPGroup(assign({}, keepB, { size: size }), plan, { fieldHoldMin: sheetOpts(ctx).fieldHoldMin });
    return { group: g, plan: plan, players: players, size: size };
  }

  // 并组 a+b(保留 keep)是否可行:把合并组插回"去掉 a、b 的表",以今天表的投影为基准 —— 后面任何一组都不能更晚开球或完成
  function checkPair(ctx, a, b, keep, baseline) {
    if (keep == null) keep = keepSide(a, b);
    if (!baseline) baseline = baselineFor(ctx);
    var rest = [];
    for (var i = 0; i < (ctx.bookings || []).length; i++) {
      var q = ctx.bookings[i];
      if (q && q.id !== a.id && q.id !== b.id) rest.push(q);
    }
    var m = mergedGroup(ctx, a, b, keep);
    var restGroups = Pace.sheetGroups(rest, ctx.plansById, sheetOpts(ctx));
    var res = Pace.checkInsert(ctx.holes, ctx.cfg, restGroups, m.group, { baseline: baseline });
    return { ok: !!res.ok, result: res, group: m.group, plan: m.plan, keep: keep };
  }

  // ---------- 提议 ----------
  function proposalId(a, b) { return 'm-' + String(a.id) + '-' + String(b.id); }

  // expiresAt = min(createdAt + expireHours×60, targetTeeMin − expireBeforeTeeMin)
  function expiresAtFor(createdAt, targetTeeMin, cfg) {
    var mc = mergeCfg(cfg);
    return Math.min(createdAt + mc.expireHours * 60, targetTeeMin - mc.expireBeforeTeeMin);
  }

  function makeProposal(ctx, a, b, keep, score, now) {
    var keepB = keep === 'b' ? b : a, other = keep === 'b' ? a : b;
    var createdAt = isNum(now) ? now : 0;
    return {
      id: proposalId(a, b),
      date: ctx.sheet ? ctx.sheet.date : (a.date || b.date),
      a: a.id, b: b.id,
      keep: keep,
      targetTeeMin: keepB.teeMin,
      freedTeeMin: other.teeMin,
      score: score,
      status: 'suggested',
      decisions: {},
      createdAt: createdAt,
      expiresAt: expiresAtFor(createdAt, keepB.teeMin, ctx.cfg)
    };
  }

  // 候选对(已排序:score desc,再 (teeMin_a, id_a, teeMin_b, id_b) 保证确定性),不含可行性复核
  function candidatePairs(ctx) {
    var cfg = ctx.cfg, plansById = ctx.plansById || {};
    var list = [];
    for (var i = 0; i < (ctx.bookings || []).length; i++) if (isMergeable(ctx.bookings[i], cfg)) list.push(ctx.bookings[i]);
    list.sort(function (x, y) { return Course.compareByTee({ tee: x.teeMin, id: x.id }, { tee: y.teeMin, id: y.id }); });
    var pairs = [];
    for (i = 0; i < list.length; i++) {
      for (var j = i + 1; j < list.length; j++) {
        var a = list[i], b = list[j];
        if (!isCandidatePair(a, b, cfg, plansById)) continue;
        var s = scorePair(a, b, cfg, plansById, ctx.friendsOf);
        pairs.push({ a: a, b: b, keep: keepSide(a, b), score: s.score, detail: s });
      }
    }
    pairs.sort(function (x, y) {
      if (x.score !== y.score) return y.score - x.score;
      var c = Course.compareByTee({ tee: x.a.teeMin, id: x.a.id }, { tee: y.a.teeMin, id: y.a.id });
      if (c !== 0) return c;
      return Course.compareByTee({ tee: x.b.teeMin, id: x.b.id }, { tee: y.b.teeMin, id: y.b.id });
    });
    return pairs;
  }

  // suggest(ctx) → MergeProposal[]:非旺季 → [];否则候选对按分降序贪心互斥选取,逐对复核可行性,上限 ceil(maxShare × 候选对数)
  function suggest(ctx) {
    ctx = ctx || {};
    var cfg = ctx.cfg || Course.defaultConfig();
    var bookings = ctx.bookings || [];
    if (!peakActive(ctx.sheet, bookings, cfg, ctx.waitlistLen)) return [];
    var ctx2 = assign({}, ctx, { cfg: cfg, bookings: bookings });
    var pairs = candidatePairs(ctx2);
    if (!pairs.length) return [];
    var mc = mergeCfg(cfg);
    var cap = Math.ceil(mc.maxShare * pairs.length - EPS);
    if (cap < 0) cap = 0;
    var baseline = baselineFor(ctx2);
    var used = {}, out = [];
    for (var i = 0; i < pairs.length && out.length < cap; i++) {
      var pr = pairs[i];
      if (used[pr.a.id] || used[pr.b.id]) continue;
      var fe = checkPair(ctx2, pr.a, pr.b, pr.keep, baseline);
      if (!fe.ok) continue;
      used[pr.a.id] = true; used[pr.b.id] = true;
      out.push(makeProposal(ctx2, pr.a, pr.b, pr.keep, pr.score, ctx.now));
    }
    return out;
  }

  // ---------- 状态机 ----------
  var TERMINAL = { applied: true, declined: true, expired: true, withdrawn: true };
  var OPEN = { suggested: true, proposed: true, accepted_a: true, accepted_b: true, confirmed: true };

  function isTerminal(p) { return !!(p && TERMINAL[p.status]); }
  function isExpired(p, now) { return !!(p && OPEN[p.status] && isNum(p.expiresAt) && isNum(now) && now >= p.expiresAt - EPS); }

  function invalid(p, action, side) {
    var e = new Error('invalid merge transition: ' + (p && p.status) + ' --' + action + (side ? '(' + side + ')' : '') + '-->');
    e.code = 'INVALID_TRANSITION';
    e.status = p && p.status;
    e.action = action;
    return e;
  }

  function clone(p) {
    var out = assign({}, p);
    out.decisions = assign({}, p.decisions || {});
    return out;
  }

  // transition(p, action, side, now[, note]) → 新提议;非法 → throws
  //   propose: suggested→proposed; accept(side): proposed→accepted_side, accepted_other→confirmed; decline(side): proposed|accepted_*→declined;
  //   withdraw: 任一未终结状态→withdrawn; expire: 任一未终结状态→expired; apply: confirmed→applied
  function transition(p, action, side, now, note) {
    if (!p || !p.status) throw invalid(p, action, side);
    var st = p.status;
    var out = clone(p);
    var other;
    switch (action) {
      case 'propose':
        if (st !== 'suggested') throw invalid(p, action, side);
        out.status = 'proposed';
        out.proposedAt = now;
        break;
      case 'accept':
        if (side !== 'a' && side !== 'b') throw invalid(p, action, side);
        other = side === 'a' ? 'b' : 'a';
        if (st === 'proposed') out.status = 'accepted_' + side;
        else if (st === 'accepted_' + other) out.status = 'confirmed';
        else throw invalid(p, action, side);
        out.decisions[side] = 'accept';
        out.decisions[side + 'At'] = now;
        break;
      case 'decline':
        if (side !== 'a' && side !== 'b') throw invalid(p, action, side);
        if (st !== 'proposed' && st !== 'accepted_a' && st !== 'accepted_b') throw invalid(p, action, side);
        out.status = 'declined';
        out.decisions[side] = 'decline';
        out.decisions[side + 'At'] = now;
        out.declinedAt = now;
        break;
      case 'withdraw':
        if (!OPEN[st]) throw invalid(p, action, side);
        out.status = 'withdrawn';
        out.withdrawnAt = now;
        break;
      case 'expire':
        if (!OPEN[st]) throw invalid(p, action, side);
        out.status = 'expired';
        out.expiredAt = now;
        break;
      case 'apply':
        if (st !== 'confirmed') throw invalid(p, action, side);
        out.status = 'applied';
        out.appliedAt = now;
        break;
      default:
        throw invalid(p, action, side);
    }
    if (note != null) out.note = String(note);
    return out;
  }

  // ---------- 应用并组 ----------
  // apply(bookings, p) → 新 bookings 数组:保留方 size = size_a+size_b、players ∪、caddieIds ∪;另一方 status 'merged', mergedInto = keep.id
  function apply(bookings, p) {
    bookings = bookings || [];
    var ia = -1, ib = -1, i;
    for (i = 0; i < bookings.length; i++) {
      if (bookings[i] && bookings[i].id === p.a) ia = i;
      if (bookings[i] && bookings[i].id === p.b) ib = i;
    }
    if (ia < 0 || ib < 0) {
      var e = new Error('merge apply: booking not found (' + (ia < 0 ? p.a : p.b) + ')');
      e.code = 'NOT_FOUND';
      throw e;
    }
    var keepIdx = p.keep === 'b' ? ib : ia, otherIdx = p.keep === 'b' ? ia : ib;
    var keepB = bookings[keepIdx], other = bookings[otherIdx];
    var newKeep = assign({}, keepB, {
      size: (keepB.size || 0) + (other.size || 0),
      players: unionPlayers(keepB.players, other.players),
      caddieIds: unionIds(keepB.caddieIds, other.caddieIds)
    });
    var newOther = assign({}, other, { status: 'merged', mergedInto: keepB.id });
    var out = bookings.slice();
    out[keepIdx] = newKeep;
    out[otherIdx] = newOther;
    return out;
  }

  return {
    isMemberGroup: isMemberGroup,
    utilization: utilization,
    peakActive: peakActive,
    isMergeable: isMergeable,
    isCandidatePair: isCandidatePair,
    friendsBetween: friendsBetween,
    scorePair: scorePair,
    keepSide: keepSide,
    candidatePairs: candidatePairs,
    baselineFor: baselineFor,
    mergedGroup: mergedGroup,
    checkPair: checkPair,
    proposalId: proposalId,
    expiresAtFor: expiresAtFor,
    suggest: suggest,
    isTerminal: isTerminal,
    isExpired: isExpired,
    transition: transition,
    apply: apply
  };
});
