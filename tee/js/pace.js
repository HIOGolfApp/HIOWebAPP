/*
 * HIOTee.Pace — 投影与派发引擎(SPEC §2)。
 * 职责:Booking → PGroup 转换、整张发球表的逐洞投影(含场上实况锚定)、推荐间隔 iRec、
 * 步速规划因子(置信收缩)、插入可行性判定("千万不能影响后面人")、时段推荐与自动排布。
 * 纯函数库:不读时钟、不随机、不碰 DOM;`now` 一律由调用方以"自午夜起的分钟数"传入。
 * 依赖:Course。浏览器下挂在 root.HIOTee.Pace,Node 下 module.exports。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./course.js'));
  } else {
    root.HIOTee = root.HIOTee || {};
    root.HIOTee.Pace = factory(root.HIOTee.Course);
  }
})(typeof self !== 'undefined' ? self : this, function (Course) {
  'use strict';

  var EPS = Course.EPS;
  var NEG = -Infinity;

  function hasOwn(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  function isNum(x) { return typeof x === 'number' && isFinite(x); }

  // 规范化任意 group / plan 形态为 { fPlan, confident }
  function planOf(group) {
    var p = group && group.plan;
    if (p) {
      var fp = isNum(p.fPlan) ? p.fPlan : (isNum(group.f) ? group.f : 1);
      return { fPlan: fp, confident: !!p.confident };
    }
    return { fPlan: (group && isNum(group.f)) ? group.f : 1, confident: false };
  }

  // ---------- §2.1 Booking → PGroup ----------
  function toPGroup(booking, plan, opts) {
    opts = opts || {};
    var prog = opts.progress || null;
    var started = !!(prog && prog.phase !== 'notStarted' && prog.phase !== 'done');
    var fPlan = (plan && isNum(plan.fPlan)) ? plan.fPlan : 1;
    var tee;
    if (started) {
      tee = isNum(prog.teeOffActual) ? prog.teeOffActual
        : (isNum(booking.teeOffActual) ? booking.teeOffActual : booking.teeMin);
    } else {
      tee = booking.teeMin + (opts.fieldHoldMin || 0);
    }
    var out = {
      id: booking.id,
      tee: tee,
      f: fPlan,
      plan: { fPlan: fPlan, confident: !!(plan && plan.confident) },
      size: booking.size,
      onCourse: started
    };
    if (started) out.actuals = prog.actuals || {};
    if (booking.intervalOverride != null) out.intervalOverride = booking.intervalOverride;
    return out;
  }

  var ACTIVE_STATUS = { booked: true, checkedIn: true, onCourse: true };

  // 发球表 → PGroup[]:场上组在前(按 opts.order,否则按 tee/id),未开球组按 (tee, id) 排在后面
  function sheetGroups(bookings, plansById, opts) {
    opts = opts || {};
    plansById = plansById || {};
    var progressById = opts.progressById || {};
    var on = [], off = [];
    for (var i = 0; i < (bookings || []).length; i++) {
      var b = bookings[i];
      if (!b || !ACTIVE_STATUS[b.status]) continue;
      var prog = progressById[b.id] || null;
      if (prog && prog.phase === 'done') continue;          // 已打完但状态仍为 onCourse:不再是发球表上的组(与 Live.evaluate 一致)
      var pg = toPGroup(b, plansById[b.id] || null, { fieldHoldMin: opts.fieldHoldMin || 0, progress: prog });
      (pg.onCourse ? on : off).push(pg);
    }
    on.sort(Course.compareByTee);
    off.sort(Course.compareByTee);
    if (opts.order && opts.order.length) {
      var byId = {}, j;
      for (j = 0; j < on.length; j++) byId[on[j].id] = on[j];
      var ordered = [], used = {};
      for (j = 0; j < opts.order.length; j++) {
        var id = opts.order[j];
        if (byId[id] && !used[id]) { ordered.push(byId[id]); used[id] = true; }
      }
      for (j = 0; j < on.length; j++) if (!used[on[j].id]) ordered.push(on[j]);
      on = ordered;
    }
    return on.concat(off);
  }

  // ---------- §2.2 逐洞投影递推 ----------
  // 单组投影:只依赖 (tee, f, actuals, now) 与前一组 p 的 rows(Markov 性质)
  function projectGroup(holes, g, p, now) {
    var H = holes.length;
    var f = isNum(g.f) ? g.f : planOf(g).fPlan;
    var actuals = g.actuals || null;
    var hasNow = isNum(now);
    var nowV = hasNow ? now : NEG;

    // m = 有任何实况的最大洞序
    var m = -1;
    if (actuals) {
      for (var k in actuals) if (hasOwn(actuals, k)) {
        var idx = Number(k), a0 = actuals[k];
        if (a0 && (a0.start != null || a0.finish != null) && idx >= 0 && idx < H && idx > m) m = idx;
      }
    }

    var rows = new Array(H);
    var waitMin = 0;
    var prevFinish = g.tee;
    var clampedToNow = false;

    for (var i = 0; i < H; i++) {
      var h = holes[i];
      var play = h.std * f;
      var a = (actuals && actuals[i]) ? actuals[i] : null;
      var aStart = (a && a.start != null) ? a.start : null;
      var aFinish = (a && a.finish != null) ? a.finish : null;
      var pr = p ? p.rows[i] : null;

      var arr = (i === 0) ? g.tee : prevFinish + h.transit;   // 第 0 洞的 transit 忽略
      // 规则 (4):场上组的第一个 i > m 的洞不能在过去开球;未开球组永不锚定到 now
      if (g.onCourse && hasNow && !clampedToNow && i > m) { arr = Math.max(arr, nowV); clampedToNow = true; }

      var start, finish, waitGreen;
      if (aStart != null) {
        // 规则 (1):实况开球时间,不施加前组约束
        start = aStart;
        arr = Math.min(arr, start);
      } else {
        start = arr;
        if (pr) {
          start = Math.max(start, pr.start + h.minGap, pr.start + h.clearFrac * (pr.finish - pr.start));
        }
      }

      var followC = pr ? pr.finish + h.minFollow : NEG;
      if (aFinish != null) {
        // 规则 (2):实况离开果岭时间
        finish = aFinish;
        if (aStart == null) {
          start = Math.min(Math.max(finish - play, arr), finish);   // clamp(finish − play, arr, finish)
          waitGreen = 0;
        } else {
          waitGreen = Math.max(0, finish - (start + play));
        }
      } else {
        finish = Math.max(start + play, followC);
        // 规则 (3):正在打的洞(i == m,有开球无离岭)完成时间不早于 now
        if (i === m && aStart != null) finish = Math.max(finish, nowV);
        waitGreen = Math.max(0, finish - (start + play));
      }

      var waitTee = Math.max(0, start - arr);
      rows[i] = { holeNo: h.no, arr: arr, start: start, waitTee: waitTee, play: play, finish: finish, waitGreen: waitGreen };
      waitMin += waitTee + waitGreen;
      prevFinish = finish;
    }

    var fin = H ? rows[H - 1].finish : g.tee;
    return { id: g.id, tee: g.tee, f: f, rows: rows, finish: fin, roundMin: fin - g.tee, waitMin: waitMin };
  }

  // 整张表按数组顺序投影(引擎不排序),O(N·H)
  function projectSheet(holes, groups, opts) {
    opts = opts || {};
    var now = isNum(opts.now) ? opts.now : null;
    var byId = {}, list = [];
    var prev = null;
    for (var i = 0; i < (groups || []).length; i++) {
      var r = projectGroup(holes, groups[i], prev, now);
      byId[r.id] = r;
      list.push(r);
      prev = r;
    }
    return { byId: byId, list: list };
  }

  // ---------- §2.3 推荐间隔 ----------
  function iRec(group, cfg) {
    var ov = group ? group.intervalOverride : null;
    if (isNum(ov) && ov > 0) {
      return { interval: ov, raw: ov, capped: false, floored: false, slow: false, uncapped: ov, override: true };
    }
    var plan = planOf(group);
    var raw = cfg.iBase * plan.fPlan;
    var r = Math.round(raw);
    var slow = plan.fPlan > 1 + EPS;
    var cap = (plan.confident && slow) ? cfg.iHardMax : cfg.iMax;
    var I = Course.clamp(r, cfg.iMin, cap);
    return { interval: I, raw: raw, capped: r > cap, floored: r < cfg.iMin, slow: slow, uncapped: r, override: false };
  }

  // ---------- §2.4 规划因子(置信收缩) ----------
  function unknownPlan() { return { f: 1, fPlan: 1, nEff: 0, roundsScored: 0, known: false }; }

  function playerPlan(stats, cfg, todayDate) {
    if (!stats || !(stats.nEff > 0)) return unknownPlan();
    var n = Course.decayN(stats.nEff, stats.lastRoundDate, todayDate, cfg);
    var f = isNum(stats.f) ? stats.f : 1;
    var n0 = f < 1 ? cfg.n0Fast : cfg.n0Slow;      // "慢"快信、"快"慢信
    var w = n / (n + n0);
    var fPlan = 1 + w * (f - 1);
    return { f: f, fPlan: fPlan, nEff: n, roundsScored: stats.roundsScored || 0, known: true };
  }

  function groupPlan(players, statsById, cfg, todayDate, size) {
    players = players || [];
    statsById = statsById || {};
    if (size == null) size = players.length || 1;
    var plans = [], i;
    for (i = 0; i < players.length; i++) {
      var pid = players[i] && players[i].id;
      plans.push(playerPlan(pid != null && statsById[pid] ? statsById[pid] : null, cfg, todayDate));
    }
    var unknownGuests = Math.max(0, size - players.length);
    for (i = 0; i < unknownGuests; i++) plans.push(unknownPlan());
    if (plans.length === 0) plans.push(unknownPlan());

    var fs = [], fps = [], unknown = 0, confident = true;
    for (i = 0; i < plans.length; i++) {
      fs.push(plans[i].f);
      fps.push(plans[i].fPlan);
      if (!plans[i].known) unknown++;
      if (!(plans[i].known && plans[i].roundsScored >= cfg.confidentRounds)) confident = false;
    }
    var lambda = cfg.lambdaMax;
    var sizeKey = Course.clamp(size, 1, 4);
    var sm = (cfg.sizeMult && cfg.sizeMult[sizeKey] != null) ? cfg.sizeMult[sizeKey] : 1;
    var f = Course.clamp((lambda * Math.max.apply(null, fs) + (1 - lambda) * Course.mean(fs)) * sm, cfg.fMin, cfg.fMax);
    var fPlan = Course.clamp((lambda * Math.max.apply(null, fps) + (1 - lambda) * Course.mean(fps)) * sm, cfg.fMin, cfg.fMax);
    if (unknown * 2 >= plans.length) fPlan = Math.max(fPlan, 1.0);   // 多数未知 → 不快于标准
    return { f: f, fPlan: fPlan, confident: confident, unknown: unknown, size: size };
  }

  // ---------- §2.5 插入可行性 ----------
  // 场上组保持原序并留在前面;候选插入未开球组中第一个 compareByTee(q, cand) > 0 之前
  function insertCand(groups, cand) {
    var on = [], off = [], i;
    for (i = 0; i < (groups || []).length; i++) (groups[i].onCourse ? on : off).push(groups[i]);
    var idx = off.length;
    for (i = 0; i < off.length; i++) if (Course.compareByTee(off[i], cand) > 0) { idx = i; break; }
    var out = on.slice();
    for (i = 0; i < idx; i++) out.push(off[i]);
    out.push(cand);
    for (i = idx; i < off.length; i++) out.push(off[i]);
    return out;
  }

  function maxShift(afterRows, refRows) {
    var mx = -Infinity;
    for (var i = 0; i < afterRows.length; i++) {
      var ds = afterRows[i].start - refRows[i].start;
      var df = afterRows[i].finish - refRows[i].finish;
      if (ds > mx) mx = ds;
      if (df > mx) mx = df;
    }
    return mx;
  }

  function reject(reason, extra) {
    var out = { ok: false, reason: reason, candWait: null, candRound: null, projection: null, warnings: [] };
    if (extra) for (var k in extra) if (hasOwn(extra, k)) out[k] = extra[k];
    return out;
  }

  function checkInsert(holes, cfg, groups, cand, opts) {
    opts = opts || {};
    groups = groups || [];
    var H = holes.length;
    // 候选 id 不得与表上任何组重复(byId 以 id 为键;moveBooking 必须先把被移动的组从 groups 中剔除)
    for (var d = 0; d < groups.length; d++) {
      if (groups[d] && cand && String(groups[d].id) === String(cand.id)) {
        throw new Error('checkInsert: cand.id "' + cand.id + '" collides with a group already on the sheet');
      }
    }
    // 0. 营业时间
    if (isNum(opts.openMin) && cand.tee < opts.openMin - EPS) return reject('OUTSIDE_HOURS', { need: opts.openMin });
    if (isNum(opts.closeMin) && cand.tee > opts.closeMin + EPS) return reject('OUTSIDE_HOURS', { need: opts.closeMin });

    // 1. 合并后的顺序
    var merged = insertCand(groups, cand);
    var ci = -1, i;
    for (i = 0; i < merged.length; i++) if (merged[i] === cand) { ci = i; break; }
    var p = ci > 0 ? merged[ci - 1] : null;
    var n = ci < merged.length - 1 ? merged[ci + 1] : null;
    var prevId = p ? p.id : null, nextId = n ? n.id : null;

    // 2./3. 与前后组的最小间隔
    if (p) {
      var ip = iRec(p, cfg).interval;
      if (cand.tee - p.tee < ip - EPS) return reject('GAP_AHEAD', { need: ip, prevId: prevId, nextId: nextId });
    }
    if (n) {
      var ic = iRec(cand, cfg).interval;
      if (n.tee - cand.tee < ic - EPS) return reject('GAP_BEHIND', { need: ic, prevId: prevId, nextId: nextId });
    }

    // 4. 重新投影,后面任何一组都不能被推迟
    var now = isNum(opts.now) ? opts.now : null;
    var base = opts.baseline || null;
    var baseOwn = null;
    var after = projectSheet(holes, merged, { now: now }).byId;
    var tol = cfg.shiftTolMin || 0;
    var frozen = opts.frozenPlans || null;
    var victimId = null, victimBudget = -Infinity, victimImpact = 0;
    for (i = ci + 1; i < merged.length; i++) {
      var q = merged[i];
      var bq = base ? base[q.id] : null;
      if (!bq || !bq.rows || bq.rows.length !== H) {
        if (!baseOwn) baseOwn = projectSheet(holes, groups, { now: now }).byId;
        bq = baseOwn[q.id];
      }
      var aq = after[q.id];
      var impact = Math.max(0, maxShift(aq.rows, bq.rows));
      var refRows = bq.rows;
      if (tol > 0 && frozen && frozen[q.id] && frozen[q.id].rows && frozen[q.id].rows.length === H) refRows = frozen[q.id].rows;
      var budget = maxShift(aq.rows, refRows);
      if (impact > EPS && budget > tol + EPS && budget > victimBudget) {
        victimBudget = budget; victimId = q.id; victimImpact = impact;
      }
    }
    if (victimId != null) {
      return reject('IMPACTS_BEHIND', { shiftMin: victimImpact, victimId: victimId, prevId: prevId, nextId: nextId,
        projection: after[cand.id], candWait: after[cand.id].waitMin, candRound: after[cand.id].roundMin });
    }

    // 5. 可行
    var cr = after[cand.id];
    var warnings = [];
    if (cr.waitMin > cfg.maxCandWaitMin) warnings.push('CAND_WAITS');
    return { ok: true, candWait: cr.waitMin, candRound: cr.roundMin, projection: cr, warnings: warnings, prevId: prevId, nextId: nextId };
  }

  // 时段推荐:在 tReq ± windowMin 内按 gridMin 扫描整数分钟,返回代价最低的 ≤ 5 个
  function suggestSlots(holes, cfg, groups, req) {
    req = req || {};
    groups = groups || [];
    var windowMin = isNum(req.windowMin) ? req.windowMin : 60;
    var plan = req.plan ? { fPlan: isNum(req.plan.fPlan) ? req.plan.fPlan : 1, confident: !!req.plan.confident } : { fPlan: 1, confident: false };
    var size = isNum(req.size) ? req.size : 1;
    var tReq = req.tReq;
    var lo = tReq - windowMin, hi = tReq + windowMin;
    if (isNum(req.openMin)) lo = Math.max(lo, req.openMin);
    if (isNum(req.closeMin)) hi = Math.min(hi, req.closeMin);
    // 扫描范围始终限定在一天之内(tee 为自午夜起的分钟数),避免异常 windowMin 造成无界扫描
    lo = Math.max(lo, 0); hi = Math.min(hi, 1440);
    var step = (isNum(cfg.gridMin) && cfg.gridMin > 0) ? cfg.gridMin : 1;
    var now = isNum(req.now) ? req.now : null;
    // 给了 now(如迟到改时 tReq = now):不推荐已经过去的时间
    if (now != null) lo = Math.max(lo, Math.ceil(now - EPS));
    var baseline = req.baseline || projectSheet(holes, groups, { now: now }).byId;
    var opts = { openMin: req.openMin, closeMin: req.closeMin, now: now, baseline: baseline, frozenPlans: req.frozenPlans };

    var rejected = { OUTSIDE_HOURS: 0, GAP_AHEAD: 0, GAP_BEHIND: 0, IMPACTS_BEHIND: 0 };
    var slots = [], scanned = 0;
    for (var T = Math.ceil(lo - EPS); T <= hi + EPS; T += step) {
      scanned++;
      var cand = { id: '__cand', tee: T, f: plan.fPlan, plan: plan, size: size, onCourse: false };
      var res = checkInsert(holes, cfg, groups, cand, opts);
      if (!res.ok) { rejected[res.reason] = (rejected[res.reason] || 0) + 1; continue; }
      var merged = insertCand(groups, cand);
      var ci = merged.indexOf(cand);
      var p = ci > 0 ? merged[ci - 1] : null;
      var n = ci < merged.length - 1 ? merged[ci + 1] : null;
      var fragA = p ? T - p.tee - iRec(p, cfg).interval : 0;
      var fragB = n ? n.tee - T - iRec(cand, cfg).interval : 0;
      var frag = (fragA > 0 && fragA < cfg.iMin ? 1 : 0) + (fragB > 0 && fragB < cfg.iMin ? 1 : 0);
      var cost = Math.abs(T - tReq) + 0.5 * res.candWait + 3 * frag + (res.candWait > cfg.maxCandWaitMin ? 10 : 0);
      slots.push({ tee: T, cost: cost, candWait: res.candWait, candRound: res.candRound, frag: frag, warnings: res.warnings });
    }
    slots.sort(function (a, b) { return a.cost !== b.cost ? a.cost - b.cost : a.tee - b.tee; });
    if (slots.length > 5) slots = slots.slice(0, 5);
    return { slots: slots, rejected: rejected, scanned: scanned };
  }

  // 自动排布:按 tReq 排序,逐个放在 [max(tReq − flex, prev.tee + iRec(prev)), tReq + flex] 内第一个可行整数分钟
  function autoPack(holes, cfg, requests, openMin, closeMin) {
    var reqs = (requests || []).slice().sort(function (a, b) {
      if (a.tReq !== b.tReq) return a.tReq - b.tReq;
      return String(a.id) < String(b.id) ? -1 : (String(a.id) > String(b.id) ? 1 : 0);
    });
    var placed = [], waitlist = [];
    for (var k = 0; k < reqs.length; k++) {
      var r = reqs[k];
      var flex = isNum(r.flexMin) ? r.flexMin : 0;
      var plan = r.plan ? { fPlan: isNum(r.plan.fPlan) ? r.plan.fPlan : 1, confident: !!r.plan.confident } : { fPlan: 1, confident: false };
      var size = isNum(r.size) ? r.size : 1;
      var prev = placed.length ? placed[placed.length - 1] : null;
      var lo = r.tReq - flex;
      var hi = r.tReq + flex;
      var lastReason = 'NO_SLOT';
      if (prev) {
        var minT = prev.tee + iRec(prev, cfg).interval;
        if (minT > hi + EPS) lastReason = 'GAP_AHEAD';          // 窗口整体落在前组推荐间隔之内
        lo = Math.max(lo, minT);
      }
      if (isNum(openMin) && openMin > hi + EPS) lastReason = 'OUTSIDE_HOURS';
      if (isNum(closeMin) && closeMin < lo - EPS) lastReason = 'OUTSIDE_HOURS';
      if (isNum(openMin)) lo = Math.max(lo, openMin);
      if (isNum(closeMin)) hi = Math.min(hi, closeMin);
      var done = false;
      for (var T = Math.ceil(lo - EPS); T <= hi + EPS; T++) {
        var cand = { id: r.id, tee: T, f: plan.fPlan, plan: plan, size: size, onCourse: false };
        if (r.intervalOverride != null) cand.intervalOverride = r.intervalOverride;
        var res = checkInsert(holes, cfg, placed, cand, { openMin: openMin, closeMin: closeMin });
        if (res.ok) { placed = insertCand(placed, cand); done = true; break; }
        lastReason = res.reason;
      }
      if (!done) waitlist.push({ id: r.id, tReq: r.tReq, reason: lastReason });
    }
    return { placed: placed, waitlist: waitlist };
  }

  return {
    toPGroup: toPGroup,
    sheetGroups: sheetGroups,
    projectGroup: projectGroup,
    projectSheet: projectSheet,
    iRec: iRec,
    playerPlan: playerPlan,
    groupPlan: groupPlan,
    insertCand: insertCand,
    checkInsert: checkInsert,
    suggestSlots: suggestSlots,
    autoPack: autoPack
  };
});
