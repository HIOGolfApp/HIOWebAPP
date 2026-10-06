/*
 * HIOTee.Live — 实时场况引擎(SPEC §5)。
 * 职责:由洞事件推导球组进度(deriveProgress)、场上顺序(liveOrder)、以实际开球时间为锚的进度滞后(lag)、
 * 位置感知的"前方空档"(openAhead / effLag)、黄/红告警状态机(nextAlertState,带滞回与驻留)、
 * 巡查建议排序(holdCount / priority)、让行建议(playThroughGate)、ETA、每 tick 一次的 evaluate,
 * 以及客户端隐私过滤视图(clientSnapshot / clientProposalView)。
 * 纯函数库:不读时钟、不随机、不碰 DOM;`now` 一律由调用方以"自午夜起的分钟数"传入;不修改入参对象。
 * 依赖:Course, Pace。浏览器下挂在 root.HIOTee.Live,Node 下 module.exports。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./course.js'), require('./pace.js'));
  } else {
    root.HIOTee = root.HIOTee || {};
    root.HIOTee.Live = factory(root.HIOTee.Course, root.HIOTee.Pace);
  }
})(typeof self !== 'undefined' ? self : this, function (Course, Pace) {
  'use strict';

  var EPS = Course.EPS;
  var INF = Infinity;
  var RANK = { green: 0, yellow: 1, red: 2 };
  // 这些状态的预订不在场上:finished → 'done';其余按约定由调用方排除(传入时同样视为 'done')
  var OFF_STATUS = { finished: true, noShow: true, cancelled: true, merged: true };

  function hasOwn(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  function rank(level) { return hasOwn(RANK, level) ? RANK[level] : 0; }
  // 浅拷贝合并(不修改任何入参)
  function assign(target) {
    for (var i = 1; i < arguments.length; i++) {
      var src = arguments[i];
      if (!src) continue;
      for (var k in src) if (hasOwn(src, k)) target[k] = src[k];
    }
    return target;
  }
  function planF(g) {
    if (g && g.plan && isNum(g.plan.fPlan)) return g.plan.fPlan;
    if (g && isNum(g.fPlan)) return g.fPlan;
    if (g && isNum(g.f)) return g.f;
    return 1;
  }
  function idOf(x) { return x == null ? null : (x.bookingId != null ? x.bookingId : (x.id != null ? x.id : null)); }

  // ---------- §5.1 进度推导 ----------
  // holeIdx 约定:'playing' → 正在打的洞序;'between' → 下一洞的洞序;notStarted → −1;done → H
  function deriveProgress(booking, events, holes) {
    booking = booking || {};
    holes = holes || [];
    var H = holes.length;
    var idxByNo = {}, i;
    for (i = 0; i < H; i++) idxByNo[holes[i].no] = i;

    // 语义去重:每 (holeNo, type) 取最早的 t;忽略不在本路线上的洞
    var ded = {};
    var list = events || [];
    for (i = 0; i < list.length; i++) {
      var e = list[i];
      if (!e || !isNum(e.t)) continue;
      if (e.bookingId != null && booking.id != null && String(e.bookingId) !== String(booking.id)) continue;
      if (!hasOwn(idxByNo, e.holeNo)) continue;
      var key = idxByNo[e.holeNo] + '|' + e.type;
      if (!hasOwn(ded, key) || e.t < ded[key]) ded[key] = e.t;
    }

    var actuals = {};
    var lastEventT;
    var lastLeaveGreen;
    for (var k in ded) if (hasOwn(ded, k)) {
      var parts = k.split('|');
      var idx = Number(parts[0]), type = parts[1], t = ded[k];
      if (lastEventT == null || t > lastEventT) lastEventT = t;
      if (type === 'teeOff') {
        if (!actuals[idx]) actuals[idx] = {};
        actuals[idx].start = t;
      } else if (type === 'leaveGreen') {
        if (!actuals[idx]) actuals[idx] = {};
        actuals[idx].finish = t;
      }
    }

    // 实际开球时间:第一洞最早的 teeOff 事件,否则 booking.teeOffActual
    var teeOffActual;
    if (H && hasOwn(ded, '0|teeOff')) teeOffActual = ded['0|teeOff'];
    else if (isNum(booking.teeOffActual)) teeOffActual = booking.teeOffActual;
    if (teeOffActual != null && H) {
      if (!actuals[0]) actuals[0] = {};
      if (actuals[0].start == null) actuals[0].start = teeOffActual;
      if (lastEventT == null || teeOffActual > lastEventT) lastEventT = teeOffActual;
    }

    var out = {
      bookingId: booking.id,
      holeIdx: -1,
      holeNo: null,
      phase: 'notStarted',
      teeOffActual: teeOffActual,
      currentHoleStart: undefined,
      lastLeaveGreen: undefined,
      lastEventT: lastEventT,
      actuals: actuals,
      playThrough: booking.playThrough || null
    };

    if (OFF_STATUS[booking.status]) {
      out.phase = 'done'; out.holeIdx = H;
      return out;
    }
    // 空路线(H == 0)或尚未开球 → notStarted(避免对 holes[0] 取值)
    if (!H || teeOffActual == null) return out;

    // m = 有任何实况的最大洞序
    var m = -1;
    for (var kk in actuals) if (hasOwn(actuals, kk)) {
      var ii = Number(kk);
      var a = actuals[kk];
      if (a && (a.start != null || a.finish != null) && ii > m) m = ii;
      if (a && a.finish != null && (lastLeaveGreen == null || a.finish > lastLeaveGreen)) lastLeaveGreen = a.finish;
    }
    out.lastLeaveGreen = lastLeaveGreen;
    if (m < 0) m = 0;
    var am = actuals[m] || {};
    if (am.finish != null) {
      if (m >= H - 1) { out.phase = 'done'; out.holeIdx = H; }
      else { out.phase = 'between'; out.holeIdx = m + 1; out.holeNo = holes[m + 1].no; }
    } else {
      out.phase = 'playing'; out.holeIdx = m; out.holeNo = holes[m].no;
      out.currentHoleStart = am.start != null ? am.start : teeOffActual;
    }
    return out;
  }

  function isOnCourse(p) { return !!p && (p.phase === 'playing' || p.phase === 'between'); }

  // ---------- §5.2 场上顺序 ----------
  function timeKey(p) { return p.phase === 'playing' ? p.currentHoleStart : p.lastLeaveGreen; }
  // a 已接受让行、让 b 先过
  function yieldsTo(a, b) {
    var pt = a.playThrough;
    return !!(pt && pt.decision === 'accepted' && pt.behindId != null && String(pt.behindId) === String(b.bookingId));
  }
  function cmpNum(a, b) {
    var na = isNum(a), nb = isNum(b);
    if (na && nb) return a === b ? 0 : a - b;
    if (na !== nb) return na ? -1 : 1;
    return 0;
  }
  function cmpId(a, b) {
    var sa = String(a), sb = String(b);
    return sa < sb ? -1 : (sa > sb ? 1 : 0);
  }
  function compareLive(a, b) {
    if (a.holeIdx !== b.holeIdx) return b.holeIdx - a.holeIdx;                       // 洞序大者在前
    if (a.phase !== b.phase) return a.phase === 'playing' ? -1 : 1;                   // playing 先于 between
    if (a.phase === 'between') {                                                      // 让行规则:接受让行者排在后面
      var ab = yieldsTo(a, b), ba = yieldsTo(b, a);
      if (ab && !ba) return 1;
      if (ba && !ab) return -1;
    }
    var c = cmpNum(timeKey(a), timeKey(b));
    if (c) return c;
    c = cmpNum(a.teeOffActual, b.teeOffActual);
    if (c) return c;
    return cmpId(a.bookingId, b.bookingId);
  }
  function liveOrder(progressList) {
    var on = [];
    for (var i = 0; i < (progressList || []).length; i++) if (isOnCourse(progressList[i])) on.push(progressList[i]);
    on.sort(compareLive);
    return on.map(function (p) { return p.bookingId; });
  }

  // ---------- §5.3 参考进度、滞后与位置 ----------
  // 返回每洞 { start, finish } 的参考时间表(以实际开球时间为锚,加全场暂停)
  function reference(prog, holes, cfg, fieldHoldMin, planSnapshot) {
    var H = holes.length;
    var hold = isNum(fieldHoldMin) ? fieldHoldMin : 0;
    var t0 = isNum(prog.teeOffActual) ? prog.teeOffActual : 0;
    var ref = new Array(H), i;
    if (cfg && cfg.lagReference === 'plan' && planSnapshot && planSnapshot.rows && planSnapshot.rows.length === H && isNum(planSnapshot.tee)) {
      var shift = t0 - planSnapshot.tee + hold;
      for (i = 0; i < H; i++) ref[i] = { start: planSnapshot.rows[i].start + shift, finish: planSnapshot.rows[i].finish + shift };
      return ref;
    }
    var t = t0 + hold;
    for (i = 0; i < H; i++) {
      if (i > 0) t += holes[i].transit;
      ref[i] = { start: t, finish: t + holes[i].std };
      t += holes[i].std;
    }
    return ref;
  }

  function lag(prog, ref, now) {
    var h = prog.holeIdx;
    if (prog.phase === 'playing' && ref[h]) {
      return Math.max(prog.currentHoleStart - ref[h].start, now - ref[h].finish);
    }
    if (prog.phase === 'between' && ref[h] && ref[h - 1]) {
      return Math.max(prog.lastLeaveGreen - ref[h - 1].finish, now - ref[h].start);
    }
    return 0;
  }

  function teeDelayOf(prog, booking) {
    if (!isNum(prog.teeOffActual) || !booking || !isNum(booking.teeMin)) return null;
    return prog.teeOffActual - booking.teeMin;
  }

  // 前方空档:只把"眼前确实空着"的那部分滞后算到本组头上
  function openAhead(g, p, now, cfg) {
    if (!p) return INF;
    var holesAhead = p.holeIdx - g.holeIdx;
    if (holesAhead >= 2) return INF;
    if (holesAhead === 1) {
      var a = p.actuals ? p.actuals[g.holeIdx] : null;
      if (a && a.finish != null) {
        var d = (isNum(g.teeOffActual) && isNum(p.teeOffActual)) ? g.teeOffActual - p.teeOffActual : cfg.iMin;
        var ipg = Math.max(cfg.iMin, d);
        return Math.max(0, now - a.finish - ipg);
      }
    }
    return 0;
  }

  // §5.3:effLag = cfg.positionAware ? min(lag, openAhead) : lag(按 SPEC 字面取真值)
  function effLag(lagV, open, cfg) {
    return (cfg && cfg.positionAware) ? Math.min(lagV, open) : lagV;
  }

  // ---------- §5.4 告警状态机 ----------
  function nextAlertState(prev, eff, now, cfg) {
    var cand = eff >= cfg.redOn - EPS ? 'red' : (eff >= cfg.yellowOn - EPS ? 'yellow' : 'green');
    if (!prev) return { level: cand, since: now };
    if (rank(cand) > rank(prev.level)) return assign({}, prev, { level: cand, since: now });
    var dwelled = now - prev.since >= cfg.dwellMin - EPS;
    if (prev.level === 'red' && eff <= cfg.redOff + EPS && dwelled) return assign({}, prev, { level: 'yellow', since: now });
    if (prev.level === 'yellow' && eff <= cfg.yellowOff + EPS && dwelled) return assign({}, prev, { level: 'green', since: now });
    return prev;
  }

  function cause(lagV, level, cfg) {
    if (lagV < cfg.yellowOn - EPS) return 'NONE';
    return level !== 'green' ? 'OWN' : 'AHEAD';
  }

  function snoozed(alert, now) {
    if (!alert || !isNum(alert.snoozeUntil)) return false;
    return alert.snoozeUntil > now && rank(alert.level) <= rank(alert.snoozedLevel);
  }

  // ---------- §5.5 巡查建议 ----------
  // ordered = liveOrder 顺序的组记录(含 cause/holeIdx);返回紧随 g 的"被阻挡链"长度
  function holdCount(ordered, i) {
    var count = 0;
    var prev = ordered[i];
    if (!prev) return 0;
    for (var k = i + 1; k < ordered.length; k++) {
      var q = ordered[k];
      if (q.cause === 'AHEAD' && q.holeIdx >= prev.holeIdx - 1) { count++; prev = q; } else break;
    }
    return count;
  }

  function priority(g) {
    return rank(g.level) * 1000 + (g.cause === 'OWN' ? 300 : 0) - (g.cause === 'AHEAD' ? 500 : 0)
      + 10 * (isNum(g.lag) ? g.lag : 0) + 20 * (g.holdCount || 0);
  }

  // 巡查列表:level != green || holdCount > 0 || cause == AHEAD;按 priority 降序,已催促(snoozed)排最后
  function marshalList(evalResult) {
    var rows = [];
    var groups = (evalResult && evalResult.groups) || [];
    for (var i = 0; i < groups.length; i++) {
      var g = groups[i];
      if (g.phase !== 'playing' && g.phase !== 'between') continue;
      if (g.level !== 'green' || g.holdCount > 0 || g.cause === 'AHEAD') rows.push(g);
    }
    rows.sort(function (a, b) {
      if (!!a.snoozed !== !!b.snoozed) return a.snoozed ? 1 : -1;
      if (a.priority !== b.priority) return b.priority - a.priority;
      return cmpId(a.bookingId, b.bookingId);
    });
    return rows;
  }

  // ---------- §5.6 让行 ----------
  // y(g):g 打完哪一洞后让后组先过;未开球(holeIdx −1)→ −1,使 fromHoleIdx = 0
  function yOf(g) {
    if (!g || g.phase === 'notStarted') return -1;
    return g.phase === 'playing' ? g.holeIdx : g.holeIdx - 1;
  }

  function ptActive(pt, behindId) {
    return !!(pt && isNum(pt.suggestedAt) && pt.decision == null && pt.clearedAt == null
      && (behindId === undefined || (pt.behindId != null && String(pt.behindId) === String(behindId))));
  }

  function playThroughGate(g, behind, cfg, now, H) {
    if (!g || !behind || !cfg) return false;
    var ptc = cfg.playThrough || {};
    if (g.level !== 'red' || g.cause !== 'OWN') return false;
    var bid = idOf(behind);
    // behind 必须紧随 g(evaluate 记录带 behindId;未带时由调用方保证)
    if (g.behindId !== undefined && (g.behindId == null || String(g.behindId) !== String(bid))) return false;
    if (!(behind.holeIdx === g.holeIdx || (behind.holeIdx === g.holeIdx - 1 && behind.cause === 'AHEAD'))) return false;
    if (planF(behind) > planF(g) + (ptc.maxPaceDiff || 0) + EPS) return false;        // 后组不能比我们慢
    if (H - yOf(g) - 1 < (ptc.minHolesLeft || 0)) return false;
    var pt = g.playThrough || null;
    if (pt && pt.decision === 'accepted') return false;
    if (pt && isNum(pt.suggestedAt)) {
      var active = ptActive(pt, bid);
      if (!active && now - pt.suggestedAt < (ptc.cooldownMin || 0) - EPS) return false;
    }
    return true;
  }

  function acceptPlayThrough(booking, behindId, now, progress) {
    var prev = booking.playThrough || {};
    var prog = progress || { phase: 'notStarted', holeIdx: -1 };
    var pt = assign({}, prev, { decision: 'accepted', decidedAt: now, behindId: behindId, fromHoleIdx: yOf(prog) + 1 });
    return assign({}, booking, { playThrough: pt });
  }

  function ignorePlayThrough(booking, now) {
    var prev = booking.playThrough || {};
    return assign({}, booking, { playThrough: assign({}, prev, { decision: 'ignored', decidedAt: now }) });
  }

  // ---------- §5.7 ETA ----------
  function eta(prog, proj, holes, fPlan, now) {
    var H = holes.length;
    var out = { remainingMin: null, overMin: 0, etaRoundMin: null, nextTeeEta: null };
    if (!proj || !proj.rows || proj.rows.length !== H) {
      if (prog.phase === 'done') out.remainingMin = 0;
      return out;
    }
    var rows = proj.rows;
    var h = prog.holeIdx;
    out.etaRoundMin = proj.finish - now;
    if (prog.phase === 'done') {
      out.remainingMin = 0; out.etaRoundMin = 0;
      return out;
    }
    if (prog.phase === 'playing' && rows[h]) {
      out.remainingMin = Math.max(0, rows[h].finish - now);
      out.overMin = Math.max(0, now - (prog.currentHoleStart + holes[h].std * (isNum(fPlan) ? fPlan : 1)));
    } else if (prog.phase === 'between' && rows[h]) {
      out.remainingMin = Math.max(0, rows[h].start - now);   // 正前往的那一洞(UI "前往第 N 洞 · 预计 HH:MM 开球" = now + remainingMin)
      out.overMin = 0;
    } else if (prog.phase === 'notStarted') {
      h = -1;
    }
    // §5.7 字面:nextTeeEta = h + 1 < H ? rows[h+1].start : null(对所有阶段一致;notStarted → 第 0 洞)
    var nh = (isNum(h) ? h : -1) + 1;
    out.nextTeeEta = (nh >= 0 && nh < H) ? rows[nh].start : null;
    return out;
  }

  // ---------- §5.8 buildCtx / evaluate ----------
  function buildCtx(loaded, now, prevAlerts) {
    loaded = loaded || {};
    var course = loaded.course;
    var sheet = loaded.sheet || {};
    var cfg = (course && course.config) || Course.defaultConfig();
    var holes = course ? Course.holesForRouting(course, sheet.routingId) : [];
    var bookings = loaded.bookings || [];
    var events = loaded.events || [];
    var paceStats = loaded.paceStats || {};
    var eventsByBooking = {}, i;
    for (i = 0; i < events.length; i++) {
      var e = events[i];
      if (!e || e.bookingId == null) continue;
      if (!eventsByBooking[e.bookingId]) eventsByBooking[e.bookingId] = [];
      eventsByBooking[e.bookingId].push(e);
    }
    var plansById = {}, planSnapshots = {};
    for (i = 0; i < bookings.length; i++) {
      var b = bookings[i];
      if (!b) continue;
      plansById[b.id] = Pace.groupPlan(b.players || [], paceStats, cfg, sheet.date, b.size);
      planSnapshots[b.id] = b.planSnapshot;
    }
    return {
      holes: holes, cfg: cfg, now: now, bookings: bookings, eventsByBooking: eventsByBooking,
      plansById: plansById, prevAlerts: prevAlerts || {}, fieldHoldMin: sheet.fieldHoldMin || 0,
      planSnapshots: planSnapshots
    };
  }

  function evaluate(ctx) {
    var holes = ctx.holes || [];
    var H = holes.length;
    var cfg = ctx.cfg || Course.defaultConfig();
    var now = ctx.now;
    var hold = ctx.fieldHoldMin || 0;
    var prevAlerts = ctx.prevAlerts || {};
    var plansById = ctx.plansById || {};
    var planSnapshots = ctx.planSnapshots || {};
    var eventsByBooking = ctx.eventsByBooking || {};
    var bookings = ctx.bookings || [];
    var i, b, id;

    // 1) 进度
    var bookingById = {}, progById = {}, progList = [];
    for (i = 0; i < bookings.length; i++) {
      b = bookings[i];
      if (!b || OFF_STATUS[b.status]) continue;
      bookingById[b.id] = b;
      var pr = deriveProgress(b, eventsByBooking[b.id] || [], holes);
      progById[b.id] = pr;
      progList.push(pr);
    }

    // 2) 场上顺序 + PGroups(场上组按 liveOrder,其后未开球组按 (tee, id))
    var order = liveOrder(progList);
    var pgroups = [], notStarted = [];
    for (i = 0; i < order.length; i++) {
      id = order[i];
      pgroups.push(Pace.toPGroup(bookingById[id], plansById[id] || null, { fieldHoldMin: hold, progress: progById[id] }));
    }
    for (i = 0; i < progList.length; i++) {
      if (progList[i].phase !== 'notStarted') continue;
      id = progList[i].bookingId;
      notStarted.push(Pace.toPGroup(bookingById[id], plansById[id] || null, { fieldHoldMin: hold, progress: progList[i] }));
    }
    notStarted.sort(Course.compareByTee);
    for (i = 0; i < notStarted.length; i++) pgroups.push(notStarted[i]);
    var projections = Pace.projectSheet(holes, pgroups, { now: now });

    // 3) 场上组:滞后、位置、告警
    var groups = [], byId = {}, alerts = {}, patches = {};
    var lags = [];
    for (i = 0; i < order.length; i++) {
      id = order[i];
      b = bookingById[id];
      var g = progById[id];
      var p = i > 0 ? progById[order[i - 1]] : null;
      var plan = plansById[id] || { fPlan: 1, confident: false };
      var ref = reference(g, holes, cfg, hold, planSnapshots[id]);
      var lagV = lag(g, ref, now);
      var open = openAhead(g, p, now, cfg);
      var eff = effLag(lagV, open, cfg);
      var alert = nextAlertState(prevAlerts[id] || null, eff, now, cfg);
      alerts[id] = alert;
      var e = eta(g, projections.byId[id], holes, plan.fPlan, now);
      var rec = {
        bookingId: id, holeIdx: g.holeIdx, holeNo: g.holeNo, phase: g.phase,
        teeDelay: teeDelayOf(g, b), lag: lagV, openAhead: open, effLag: eff,
        level: alert.level, since: alert.since, cause: cause(lagV, alert.level, cfg), snoozed: snoozed(alert, now),
        holesAhead: p ? p.holeIdx - g.holeIdx : null, aheadId: p ? p.bookingId : null,
        behindId: i + 1 < order.length ? order[i + 1] : null,
        holdCount: 0, priority: 0,
        remainingMin: e.remainingMin, overMin: e.overMin, etaRoundMin: e.etaRoundMin, nextTeeEta: e.nextTeeEta,
        playThroughSuggested: false, behindWaiting: false,
        // 附加(引擎内部与 UI 需要;客户端视图不会原样透出)
        plan: { fPlan: plan.fPlan, confident: !!plan.confident }, playThrough: g.playThrough, size: b.size,
        currentHoleStart: g.currentHoleStart, lastLeaveGreen: g.lastLeaveGreen, lastEventT: g.lastEventT, teeOffActual: g.teeOffActual
      };
      groups.push(rec);
      byId[id] = rec;
      lags.push(lagV);
    }
    // 4) 阻挡链、优先级、让行建议(需要后组的 cause)
    for (i = 0; i < groups.length; i++) {
      groups[i].holdCount = holdCount(groups, i);
      groups[i].priority = priority(groups[i]);
    }
    for (i = 0; i < groups.length; i++) {
      var gr = groups[i];
      var behind = i + 1 < groups.length ? groups[i + 1] : null;
      var behindId = behind ? behind.bookingId : null;
      gr.behindWaiting = !!(behind && (behind.holeIdx === gr.holeIdx || (behind.holeIdx === gr.holeIdx - 1 && behind.cause === 'AHEAD')));
      var gateNow = playThroughGate(gr, behind, cfg, now, H);
      var pt = gr.playThrough || null;
      var active = ptActive(pt);
      var activeForBehind = active && behind && String(pt.behindId) === String(behindId);
      if (gateNow) {
        if (!activeForBehind) patches[gr.bookingId] = { playThrough: { suggestedAt: now, behindId: behindId } };
        gr.playThroughSuggested = true;
      } else if (active) {
        var clear = false;
        if (!activeForBehind) clear = true;                                                            // 后组不再紧随
        else if (gr.level !== 'red' && now - gr.since >= ((cfg.playThrough && cfg.playThrough.clearAfterMin) || 0) - EPS) clear = true;
        if (clear) patches[gr.bookingId] = { playThrough: assign({}, pt, { clearedAt: now }) };
        else gr.playThroughSuggested = true;                                                           // 红转黄的滞回期内仍显示
      }
    }

    // 5) 未开球与已完成(状态仍为 onCourse)的组
    var rest = [];
    for (i = 0; i < progList.length; i++) if (!isOnCourse(progList[i])) rest.push(progList[i]);
    rest.sort(function (x, y) {
      var bx = bookingById[x.bookingId], by = bookingById[y.bookingId];
      var tx = isNum(bx.teeMin) ? bx.teeMin : 0, ty = isNum(by.teeMin) ? by.teeMin : 0;
      if (tx !== ty) return tx - ty;
      return cmpId(x.bookingId, y.bookingId);
    });
    for (i = 0; i < rest.length; i++) {
      var r = rest[i];
      b = bookingById[r.bookingId];
      var pl = plansById[r.bookingId] || { fPlan: 1, confident: false };
      var e2 = eta(r, projections.byId[r.bookingId], holes, pl.fPlan, now);
      var rec2 = {
        bookingId: r.bookingId, holeIdx: r.holeIdx, holeNo: r.holeNo, phase: r.phase,
        teeDelay: teeDelayOf(r, b), lag: 0, openAhead: null, effLag: 0,
        level: 'green', since: null, cause: 'NONE', snoozed: false,
        holesAhead: null, aheadId: null, behindId: null, holdCount: 0, priority: 0,
        remainingMin: e2.remainingMin, overMin: e2.overMin, etaRoundMin: e2.etaRoundMin, nextTeeEta: e2.nextTeeEta,
        playThroughSuggested: false, behindWaiting: false,
        plan: { fPlan: pl.fPlan, confident: !!pl.confident }, playThrough: r.playThrough, size: b.size,
        currentHoleStart: undefined, lastLeaveGreen: r.lastLeaveGreen, lastEventT: r.lastEventT, teeOffActual: r.teeOffActual
      };
      groups.push(rec2);
      byId[r.bookingId] = rec2;
    }

    var fieldDelayMin = lags.length ? Course.median(lags) : 0;
    return { groups: groups, byId: byId, order: order, projections: projections, fieldDelayMin: fieldDelayMin, alerts: alerts, patches: patches };
  }

  // ---------- §5.9 客户端视图(隐私过滤) ----------
  function isFriend(friendIds, pid) {
    if (!friendIds || pid == null) return false;
    if (typeof friendIds.has === 'function') return friendIds.has(pid);
    if (Array.isArray(friendIds)) return friendIds.indexOf(pid) >= 0;
    return hasOwn(friendIds, pid) && !!friendIds[pid];
  }
  function friendsOf(booking, friendIds) {
    var out = [];
    var ps = (booking && booking.players) || [];
    for (var i = 0; i < ps.length; i++) {
      var p = ps[i];
      if (!p || p.shareOnCourse === false || !isFriend(friendIds, p.id)) continue;
      var f = { name: p.name };
      if (p.avatarUrl) f.avatarUrl = p.avatarUrl;
      out.push(f);
    }
    return out;
  }
  function caddieList(booking, opts) {
    var ids = (booking && booking.caddieIds) || [];
    var dir = opts && opts.caddies;
    var byId = {}, i;
    if (Array.isArray(dir)) { for (i = 0; i < dir.length; i++) if (dir[i]) byId[dir[i].id] = dir[i]; }
    else if (dir) byId = dir;
    var out = [];
    for (i = 0; i < ids.length; i++) {
      var c = byId[ids[i]];
      out.push(c ? { no: c.no, name: c.name } : { no: null, name: null });
    }
    return out;
  }

  // opts(可选):{ caddies: Caddie[] | {id → Caddie} } 用于本组球童编号/姓名
  function clientSnapshot(evalResult, bookings, holes, me, friendIds, now, opts) {
    evalResult = evalResult || { groups: [], byId: {}, order: [] };
    bookings = bookings || [];
    holes = holes || [];
    me = me || {};
    var bookingById = {}, i;
    for (i = 0; i < bookings.length; i++) if (bookings[i]) bookingById[bookings[i].id] = bookings[i];

    var myB = bookingById[me.bookingId] || null;
    var g = evalResult.byId[me.bookingId] || null;
    var players = [];
    var ps = (myB && myB.players) || [];
    for (i = 0; i < ps.length; i++) {
      players.push({ name: ps[i].name, isMember: !!ps[i].isMember, isMe: me.userId != null && ps[i].id === me.userId });
    }
    var meOut = {
      bookingId: me.bookingId,
      holeIdx: g ? g.holeIdx : (myB && myB.status === 'finished' ? holes.length : -1),
      holeNo: g ? g.holeNo : null,
      phase: g ? g.phase : (myB && myB.status === 'finished' ? 'done' : 'notStarted'),
      remainingMin: g ? g.remainingMin : null,
      overMin: g ? g.overMin : 0,
      level: g ? g.level : 'green',
      cause: g ? g.cause : 'NONE',
      lag: g ? g.lag : 0,
      teeDelay: g ? g.teeDelay : null,
      etaRoundMin: g ? g.etaRoundMin : null,
      nextTeeEta: g ? g.nextTeeEta : null,
      teeMin: myB ? myB.teeMin : null,
      playThroughSuggested: !!(g && g.playThroughSuggested),
      behindWaiting: !!(g && g.behindWaiting),
      playThrough: (myB && myB.playThrough) || null,
      players: players,
      caddies: caddieList(myB, opts)
    };

    // 每洞的在场球组('between' 列在下一洞);按 liveOrder 顺序
    var holesOut = [];
    for (i = 0; i < holes.length; i++) holesOut.push({ no: holes[i].no, par: holes[i].par, groups: [] });
    var order = evalResult.order || [];
    for (i = 0; i < order.length; i++) {
      var r = evalResult.byId[order[i]];
      if (!r || (r.phase !== 'playing' && r.phase !== 'between')) continue;
      if (r.holeIdx < 0 || r.holeIdx >= holes.length) continue;
      var rb = bookingById[r.bookingId];
      holesOut[r.holeIdx].groups.push({
        size: rb ? rb.size : (r.size != null ? r.size : null),
        isMine: r.bookingId === me.bookingId,
        phase: r.phase,
        friends: friendsOf(rb, friendIds)
      });
    }

    var out = { now: now, me: meOut, holes: holesOut };
    if (g && g.behindId != null) {
      var bb = bookingById[g.behindId];
      var br = evalResult.byId[g.behindId];
      var sz = bb ? bb.size : (br ? br.size : null);
      if (sz != null) out.behindGroup = { size: sz };
    }
    // 前组所在洞(仅洞号,不含身份)
    if (g && g.aheadId != null) {
      var ar = evalResult.byId[g.aheadId];
      if (ar) out.aheadGroup = { holeNo: ar.holeNo, phase: ar.phase };
    }
    return out;
  }

  function clientProposalView(proposal, bookings, me, friendIds) {
    if (!proposal || !me) return null;
    var mySide = proposal.a === me.bookingId ? 'a' : (proposal.b === me.bookingId ? 'b' : null);
    if (!mySide) return null;
    var otherId = mySide === 'a' ? proposal.b : proposal.a;
    var myB = null, otherB = null;
    for (var i = 0; i < (bookings || []).length; i++) {
      var b = bookings[i];
      if (!b) continue;
      if (b.id === me.bookingId) myB = b;
      if (b.id === otherId) otherB = b;
    }
    return {
      id: proposal.id,
      status: proposal.status,
      myTeeMin: myB ? myB.teeMin : null,
      newTeeMin: proposal.targetTeeMin,
      mySide: mySide,
      other: { size: otherB ? otherB.size : null, friends: friendsOf(otherB, friendIds).map(function (f) { return { name: f.name }; }) },
      expiresAt: proposal.expiresAt
    };
  }

  return {
    deriveProgress: deriveProgress,
    liveOrder: liveOrder,
    reference: reference,
    lag: lag,
    openAhead: openAhead,
    effLag: effLag,
    nextAlertState: nextAlertState,
    cause: cause,
    snoozed: snoozed,
    rank: rank,
    holdCount: holdCount,
    priority: priority,
    marshalList: marshalList,
    playThroughGate: playThroughGate,
    acceptPlayThrough: acceptPlayThrough,
    ignorePlayThrough: ignorePlayThrough,
    eta: eta,
    buildCtx: buildCtx,
    evaluate: evaluate,
    clientSnapshot: clientSnapshot,
    clientProposalView: clientProposalView
  };
});
