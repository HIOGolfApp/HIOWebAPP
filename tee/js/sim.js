/*
 * HIOTee.Sim — 演示模拟器(SPEC §7)。
 *
 * 让球组沿球场按步速模型前进:洞内用时 = std × trueFactor × lognormal(0.12)(小概率 "找球" 额外 U(4,12) 分),
 * 转场 = transit × lognormal(0.2);完全遵守占用约束(minGap / clearFrac / minFollow,对象是物理上在前面的球组),
 * 自动开球使用与值班员相同的 sendAt = max(teeMin + 全场暂停, 前组实际开球 + iRec(前组)) + max(0, N(0,1))。
 *
 * 纯函数:不读时钟、不用 Math.random、不碰 DOM。随机性只来自 state 里保存的 mulberry32 生成器
 * (主生成器只用来给每个球组派发子种子;每个球组用自己的子流抽样,因此事件结果与 step 的切分方式无关)。
 * step() 永不修改传入的 state / bookings,而是返回结构复制后的新 state。
 *
 * 事件驱动推进:在 [fromMin, toMin] 内按时间顺序逐个处理 "下一事件",因此即使一次 step 跨 60 分钟,
 * 事件时间戳也是精确的,且 step(0,100) 与 step(0,50)+step(50,100) 产生完全相同的事件流。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./course.js'));
  } else {
    root.HIOTee = root.HIOTee || {};
    root.HIOTee.Sim = factory(root.HIOTee.Course);
  }
})(typeof self !== 'undefined' ? self : this, function (Course) {
  'use strict';

  var EPS = Course.EPS;
  var TWO32 = 4294967296;
  var ACTIVE = { booked: true, checkedIn: true, onCourse: true };
  var GONE = { noShow: true, cancelled: true, merged: true };

  // ---------- 随机数 ----------
  var imul = Math.imul || function (a, b) {
    var ah = (a >>> 16) & 0xffff, al = a & 0xffff;
    var bh = (b >>> 16) & 0xffff, bl = b & 0xffff;
    return ((al * bl) + (((ah * bl + al * bh) << 16) >>> 0)) | 0;
  };

  // mulberry32:32 位状态的小型 PRNG。rng() ∈ [0,1)。rng.state 为当前状态(调用后更新),
  // mulberry32(rng.state) 可精确续接同一序列 —— step() 用它来做到 "不修改输入 state"。
  function mulberry32(seed) {
    var s = (Number(seed) || 0) >>> 0;
    function rng() {
      s = (s + 0x6D2B79F5) >>> 0;
      var t = s;
      t = imul(t ^ (t >>> 15), t | 1);
      t ^= t + imul(t ^ (t >>> 7), t | 61);
      rng.state = s;
      return ((t ^ (t >>> 14)) >>> 0) / TWO32;
    }
    rng.seed = s;
    rng.state = s;
    return rng;
  }

  // Box–Muller 标准正态
  function normal(rng) {
    var u1 = 1 - rng();          // (0,1]:避免 log(0)
    var u2 = rng();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }

  function lognormal(rng, sigma) {
    return Math.exp((sigma || 0) * normal(rng));
  }

  // ---------- 小工具 ----------
  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  function has(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  function copyPlain(o) { return JSON.parse(JSON.stringify(o)); }
  function shallowCopy(o) {
    var out = {};
    for (var k in o) if (has(o, k)) out[k] = o[k];
    return out;
  }

  // 与 Pace.iRec 一致的推荐间隔(本模块只依赖 Course,故本地实现):
  // override > 0 → override;否则 clamp(round(iBase × fPlan), iMin, confident&&fPlan>1 ? iHardMax : iMax)
  function iRecInterval(plan, cfg, intervalOverride) {
    if (isNum(intervalOverride) && intervalOverride > 0) return intervalOverride;
    var fPlan = (plan && isNum(plan.fPlan)) ? plan.fPlan : 1;
    var confident = !!(plan && plan.confident);
    var r = Math.round(cfg.iBase * fPlan);
    var cap = (confident && fPlan > 1 + EPS) ? cfg.iHardMax : cfg.iMax;
    return Course.clamp(r, cfg.iMin, cap);
  }

  function mkEvent(bookingId, holeNo, type, t) {
    return { id: 'sim:' + bookingId + ':' + holeNo + ':' + type, bookingId: bookingId, holeNo: holeNo, type: type, t: t, source: 'sim' };
  }

  function statusOf(b) { return b && b.status ? b.status : 'booked'; }
  function isActive(b) { return !!b && ACTIVE[statusOf(b)] === true; }

  // ---------- 球组状态 ----------
  function newGroup(id, seed) {
    return {
      id: id,
      seed: seed,            // 子流种子(由主生成器派发)
      rngState: seed,        // 子流当前状态
      holeIdx: -1,           // 'playing': 正在打的洞;'between': 下一洞;-1 未开球;H 完成
      phase: 'notStarted',
      teeOffActual: null,
      sendNoise: 0,          // 自动开球的 max(0, N(0,1)) 噪声(注册时抽取一次)
      plannedSend: null,     // 最近一次计算的 sendAt(仅供显示/调试)
      arriveAt: null,        // 到达当前目标发球台的时间('between')
      arrived: false,        // 是否已发出 arriveTee
      startAt: null,         // 当前洞开球时间('playing')
      plannedFinish: null,   // 当前洞按自身用时的离开果岭时间(不含被前组压住的等待)
      lastLeaveGreen: null,
      starts: {},            // holeIdx → teeOff t
      leaves: {},            // holeIdx → leaveGreen t
      durs: {},              // holeIdx → 实际洞内用时(含找球)
      lostMin: {}            // holeIdx → 找球额外分钟(若发生)
    };
  }

  function buildCtx(st, bookings) {
    var byId = {}, list = [];
    (bookings || []).forEach(function (b) {
      if (!b || b.id == null) return;
      byId[b.id] = b;
      list.push({ id: String(b.id), tee: isNum(b.teeMin) ? b.teeMin : 0, b: b });
    });
    list.sort(Course.compareByTee);
    var order = [], orderIdx = {};
    list.forEach(function (x, i) { order.push(x.b.id); orderIdx[x.b.id] = i; });
    return { byId: byId, order: order, orderIdx: orderIdx };
  }

  function rollHole(st, g, i) {
    var hole = st.holes[i];
    var p = st.params;
    var tf = (p.trueFactorById && isNum(p.trueFactorById[g.id])) ? p.trueFactorById[g.id] : 1;
    var r = mulberry32(g.rngState);
    var dur = hole.std * tf * lognormal(r, p.playSigma);
    var u = r();
    var lo = p.lostBallMin[0], hi = p.lostBallMin[1];
    var extra = lo + r() * (hi - lo);          // 固定抽样次数,便于复现
    if (u < p.slowHoleProb) { dur += extra; g.lostMin[i] = extra; }
    g.rngState = r.state;
    g.durs[i] = dur;
    return dur;
  }

  function startHole(st, g, i, t) {
    g.phase = 'playing';
    g.holeIdx = i;
    g.starts[i] = t;
    g.startAt = t;
    g.arrived = false;
    g.arriveAt = null;
    if (i === 0) g.teeOffActual = t;
    g.plannedFinish = t + rollHole(st, g, i);
  }

  // 注册新预订(按发球表顺序,从主生成器派发子种子),并接管值班员手动开球的球组
  function registerGroups(st, ctx) {
    ctx.order.forEach(function (id) {
      if (!has(st.groups, id)) {
        var seed = Math.floor(st.rng() * TWO32) >>> 0;
        var g = newGroup(id, seed);
        var r = mulberry32(seed);
        g.sendNoise = Math.max(0, normal(r));
        g.rngState = r.state;
        st.groups[id] = g;
      }
      var b = ctx.byId[id];
      var gs = st.groups[id];
      if (gs.phase === 'notStarted' && statusOf(b) === 'onCourse' && isNum(b.teeOffActual) && st.holes.length) {
        startHole(st, gs, 0, b.teeOffActual);   // 值班员已开球:无需再发 teeOff 事件
      }
    });
  }

  // 作为 "前组" 是否仍算在场上(被取消/未到/并组的球组从球场消失;手动标记完成且本洞未离开的也消失,避免死锁)
  function presentAsAhead(st, ctx, q, i) {
    var b = ctx.byId[q.id];
    if (!b) return false;
    var s = statusOf(b);
    if (GONE[s]) return false;
    if (s === 'finished' && q.leaves[i] == null) return false;
    return true;
  }

  // 第 i 洞上、在 g 之前(或在所有人之后,gStart==null)开球的最近一组
  function findAhead(st, ctx, i, gId, gStart) {
    var best = null, bestStart = -Infinity, bestIdx = -1;
    var gIdx = has(ctx.orderIdx, gId) ? ctx.orderIdx[gId] : Infinity;
    for (var id in st.groups) if (has(st.groups, id)) {
      if (id === String(gId)) continue;
      var q = st.groups[id];
      var qs = q.starts[i];
      if (!isNum(qs)) continue;
      var qIdx = has(ctx.orderIdx, id) ? ctx.orderIdx[id] : Infinity;
      if (gStart != null) {
        if (qs > gStart + EPS) continue;
        if (Math.abs(qs - gStart) <= EPS && qIdx >= gIdx) continue;
      }
      if (!presentAsAhead(st, ctx, q, i)) continue;
      if (qs > bestStart + EPS || (Math.abs(qs - bestStart) <= EPS && qIdx > bestIdx)) {
        best = q; bestStart = qs; bestIdx = qIdx;
      }
    }
    return best;
  }

  // 前组 p 在第 i 洞的 "可开球" 时间:p.start + max(minGap, clearFrac × p 的洞内用时)(按 p 的物理位置)。
  // clearFrac ≥ 1(三杆洞)表示整洞必须清空:还要等 p 真正离开果岭。
  function clearTime(p, i, hole) {
    var ps = p.starts[i];
    var c = ps + Math.max(hole.minGap, hole.clearFrac * p.durs[i]);
    if (hole.clearFrac >= 1 - EPS) {
      if (!isNum(p.leaves[i])) return null;
      c = Math.max(c, p.leaves[i]);
    }
    return c;
  }

  // 物理前组(禁止超车):在第 i−1 洞比 g 早离开果岭的最近一组。它尚未在第 i 洞开球时,g 不得开球。
  function predecessor(st, ctx, i, g) {
    var gl = g.leaves[i - 1];
    if (!isNum(gl)) return null;
    var gIdx = has(ctx.orderIdx, g.id) ? ctx.orderIdx[g.id] : Infinity;
    var best = null, bestLeave = -Infinity, bestIdx = -1;
    for (var id in st.groups) if (has(st.groups, id)) {
      if (id === String(g.id)) continue;
      var q = st.groups[id];
      var ql = q.leaves[i - 1];
      if (!isNum(ql)) continue;
      var qIdx = has(ctx.orderIdx, id) ? ctx.orderIdx[id] : Infinity;
      if (ql > gl + EPS || (Math.abs(ql - gl) <= EPS && qIdx >= gIdx)) continue;
      if (!presentAsAhead(st, ctx, q, i)) continue;
      if (ql > bestLeave + EPS || (Math.abs(ql - bestLeave) <= EPS && qIdx > bestIdx)) {
        best = q; bestLeave = ql; bestIdx = qIdx;
      }
    }
    return best;
  }

  // g 是否是第 i 洞上某个已接受让行的在场球组的 "被让方"(taker)—— 允许它超过物理前组
  function isTaker(st, ctx, g, i) {
    for (var id in ctx.byId) if (has(ctx.byId, id)) {
      var b = ctx.byId[id];
      var pt = b && b.playThrough;
      if (!pt || pt.decision !== 'accepted' || pt.fromHoleIdx !== i || String(pt.behindId) !== String(g.id)) continue;
      var q = st.groups[id];
      if (!q || !isActive(b) || q.phase === 'done' || isNum(q.starts[i])) continue;
      return true;
    }
    return false;
  }

  // 让行:g 若在第 i 洞让 behindId 先打,则在对方开球前不得开球
  function mustYield(st, ctx, g, b, i) {
    var pt = b.playThrough;
    if (!pt || pt.decision !== 'accepted' || pt.fromHoleIdx !== i || pt.behindId == null || String(pt.behindId) === String(g.id)) return false;
    var taker = st.groups[pt.behindId];
    var tb = ctx.byId[pt.behindId];
    if (!taker || !isActive(tb) || taker.phase === 'done') return false;
    return !isNum(taker.starts[i]);
  }

  // 下一事件:遍历发球表顺序上的球组,取最早可执行的事件(同刻按发球表顺序)
  function nextEvent(st, ctx, t, fieldHold, plansById) {
    var H = st.holes.length;
    var best = null;
    var autoSeen = false;
    for (var k = 0; k < ctx.order.length; k++) {
      var id = ctx.order[k];
      var b = ctx.byId[id];
      var g = st.groups[id];
      if (!g || !isActive(b)) continue;
      var cand = null;

      if (g.phase === 'notStarted') {
        if (statusOf(b) === 'onCourse' || b.autoSend === false || autoSeen || !H) continue;
        autoSeen = true;
        var p0 = findAhead(st, ctx, 0, id, null);
        var base = (isNum(b.teeMin) ? b.teeMin : 0) + fieldHold;
        if (p0) {
          var pb = ctx.byId[p0.id];
          base = Math.max(base, p0.starts[0] + iRecInterval(plansById[p0.id], st.cfg, pb ? pb.intervalOverride : undefined));
        }
        var sendAt = base + g.sendNoise;
        g.plannedSend = sendAt;
        if (mustYield(st, ctx, g, b, 0)) continue;
        var c0 = p0 ? clearTime(p0, 0, st.holes[0]) : -Infinity;
        if (c0 === null) continue;
        cand = { time: Math.max(sendAt, c0), type: 'teeOff', hole: 0 };
      } else if (g.phase === 'between') {
        var i = g.holeIdx;
        if (!g.arrived) {
          cand = { time: g.arriveAt, type: 'arriveTee', hole: i };
        } else {
          if (mustYield(st, ctx, g, b, i)) continue;
          var pred = predecessor(st, ctx, i, g);
          if (pred && !isNum(pred.starts[i]) && !isTaker(st, ctx, g, i)) continue;   // 不得超车
          var p = findAhead(st, ctx, i, id, null);
          var c = p ? clearTime(p, i, st.holes[i]) : -Infinity;
          if (c === null) continue;
          cand = { time: Math.max(g.arriveAt, c), type: 'teeOff', hole: i };
        }
      } else if (g.phase === 'playing') {
        var j = g.holeIdx;
        var pa = findAhead(st, ctx, j, id, g.starts[j]);
        var lt = g.plannedFinish;
        if (pa) {
          if (!isNum(pa.leaves[j])) continue;        // 前组还在果岭上:等
          lt = Math.max(lt, pa.leaves[j] + st.holes[j].minFollow);
        }
        cand = { time: lt, type: 'leaveGreen', hole: j };
      } else {
        continue; // done
      }

      if (cand && (best === null || cand.time < best.time - EPS)) {
        cand.id = id;
        best = cand;
      }
    }
    return best;
  }

  function applyEvent(st, ctx, ev, t, events) {
    var g = st.groups[ev.id];
    var H = st.holes.length;
    var hole = st.holes[ev.hole];
    if (ev.type === 'teeOff') {
      startHole(st, g, ev.hole, t);
      events.push(mkEvent(g.id, hole.no, 'teeOff', t));
    } else if (ev.type === 'arriveTee') {
      g.arrived = true;
      g.arriveAt = t;
      events.push(mkEvent(g.id, hole.no, 'arriveTee', t));
    } else if (ev.type === 'leaveGreen') {
      var i = ev.hole;
      g.leaves[i] = t;
      g.lastLeaveGreen = t;
      g.startAt = null;
      g.plannedFinish = null;
      events.push(mkEvent(g.id, hole.no, 'leaveGreen', t));
      if (i + 1 >= H) {
        g.phase = 'done';
        g.holeIdx = H;
      } else {
        g.phase = 'between';
        g.holeIdx = i + 1;
        var r = mulberry32(g.rngState);
        var tr = st.holes[i + 1].transit * lognormal(r, st.params.transitSigma);
        g.rngState = r.state;
        g.arriveAt = t + tr;
        g.arrived = false;
      }
    }
  }

  // ---------- 公共 API ----------
  function normalizeParams(p) {
    p = p || {};
    var lb = (p.lostBallMin && p.lostBallMin.length === 2) ? [Number(p.lostBallMin[0]), Number(p.lostBallMin[1])] : [4, 12];
    var tf = {};
    if (p.trueFactorById) for (var k in p.trueFactorById) if (has(p.trueFactorById, k)) tf[k] = Number(p.trueFactorById[k]);
    return {
      seed: (Number(p.seed) || 0) >>> 0,
      slowHoleProb: isNum(p.slowHoleProb) ? p.slowHoleProb : 0.04,
      lostBallMin: lb,
      trueFactorById: tf,
      playSigma: isNum(p.playSigma) ? p.playSigma : 0.12,
      transitSigma: isNum(p.transitSigma) ? p.transitSigma : 0.2,
      fieldHoldMin: isNum(p.fieldHoldMin) ? p.fieldHoldMin : 0,
      plansById: p.plansById || null
    };
  }

  function create(p) {
    p = p || {};
    var holes = (p.holes && p.holes.length) ? p.holes : Course.normalizeCourse({ holes: Course.demoLayout() }).holes;
    var cfg = p.cfg || Course.defaultConfig();
    var params = normalizeParams(p);
    var st = { rng: mulberry32(params.seed), groups: {}, holes: holes, cfg: cfg, params: params, now: null };
    registerGroups(st, buildCtx(st, p.bookings || []));
    return st;
  }

  // 结构复制:groups 深拷贝,rng 从同一状态续接;holes/cfg/params 视为不可变,共享引用
  function cloneState(state) {
    var groups = {};
    for (var k in state.groups) if (has(state.groups, k)) groups[k] = copyPlain(state.groups[k]);
    var rs = state.rng && isNum(state.rng.state) ? state.rng.state : (isNum(state.rngState) ? state.rngState : 0);
    return { rng: mulberry32(rs), groups: groups, holes: state.holes, cfg: state.cfg, params: state.params, now: state.now };
  }

  // step(state, bookings, fromMin, toMin, opts?) → { state, events }
  // opts = { fieldHoldMin?, plansById? }(覆盖 create 时的参数;plansById[bookingId] = { fPlan, confident })
  function step(state, bookings, fromMin, toMin, opts) {
    opts = opts || {};
    var st = cloneState(state);
    var fieldHold = isNum(opts.fieldHoldMin) ? opts.fieldHoldMin : (st.params.fieldHoldMin || 0);
    var plansById = opts.plansById || st.params.plansById || {};
    var ctx = buildCtx(st, bookings);
    registerGroups(st, ctx);
    var events = [];
    if (!isNum(fromMin) || !isNum(toMin) || toMin < fromMin) {
      return { state: st, events: events };
    }
    var t = fromMin;
    var guard = 0, maxEvents = (ctx.order.length + 1) * (st.holes.length * 3 + 1) + 10;
    for (;;) {
      var ev = nextEvent(st, ctx, t, fieldHold, plansById);
      if (!ev || ev.time > toMin + EPS) break;
      if (ev.time > t) t = ev.time;          // 过期事件(如起始时刻晚于计划)在当前时刻补发
      applyEvent(st, ctx, ev, t, events);
      if (++guard > maxEvents) throw new Error('Sim.step: event loop did not converge');
    }
    st.now = toMin;
    return { state: st, events: events };
  }

  // 持久化辅助(供 Store 存 sim.<date>):holes/cfg 不入库,恢复时由调用方提供
  function serialize(state) {
    return {
      version: 1,
      rngState: state.rng && isNum(state.rng.state) ? state.rng.state : 0,
      now: state.now == null ? null : state.now,
      params: copyPlain(state.params),
      groups: copyPlain(state.groups)
    };
  }

  function deserialize(obj, ctx) {
    ctx = ctx || {};
    var holes = (ctx.holes && ctx.holes.length) ? ctx.holes : Course.normalizeCourse({ holes: Course.demoLayout() }).holes;
    var cfg = ctx.cfg || Course.defaultConfig();
    var params = normalizeParams(obj && obj.params);
    var groups = {};
    if (obj && obj.groups) for (var k in obj.groups) if (has(obj.groups, k)) groups[k] = copyPlain(obj.groups[k]);
    return {
      rng: mulberry32(obj && isNum(obj.rngState) ? obj.rngState : params.seed),
      groups: groups, holes: holes, cfg: cfg, params: params,
      now: obj && obj.now != null ? obj.now : null
    };
  }

  return {
    mulberry32: mulberry32,
    normal: normal,
    lognormal: lognormal,
    iRecInterval: iRecInterval,
    create: create,
    step: step,
    serialize: serialize,
    deserialize: deserialize
  };
});
