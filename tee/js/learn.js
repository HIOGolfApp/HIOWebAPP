/*
 * HIOTee.Learn — 步速学习与校准(SPEC §4)。
 *   observeRound    : 从一组的逐洞事件得到每洞观测(打球时长、是否被阻挡、转场)与本轮步速因子 fRound(中位数)
 *   updatePlayer    : 球员 PaceStats 的 EMA 更新(有效回合数随时间衰减,alpha = max(emaAlpha, 1/(n+1)))
 *   decayedN        : 今日视角下的有效回合数
 *   calibrate       : 由观测(原始分钟,不除 fGroup)建议每洞标准时间 / 转场时间
 *   applyCalibration: 采纳建议 → 新 Course(layoutVersion+1),可选步长限制
 *   resetDefaults   : 恢复默认 7/11/15、转场 2、清空比例
 * 纯函数库:不读时钟、不碰 DOM、不修改入参。浏览器下挂在 HIOTee.Learn,Node 下 module.exports。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./course.js'));
  } else {
    root.HIOTee = root.HIOTee || {};
    root.HIOTee.Learn = factory(root.HIOTee.Course);
  }
})(typeof self !== 'undefined' ? self : this, function (Course) {
  'use strict';

  // ---------- 小工具(ES5,不依赖 Object.assign) ----------
  function assign(target) {
    for (var a = 1; a < arguments.length; a++) {
      var src = arguments[a];
      if (!src) continue;
      for (var k in src) if (Object.prototype.hasOwnProperty.call(src, k)) target[k] = src[k];
    }
    return target;
  }
  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  function numOrNull(x) { return isNum(x) ? x : null; }
  function cfgOf(cfg, course) {
    if (cfg) return cfg;
    if (course && course.config) return course.config;
    return Course.defaultConfig();
  }
  function cloneHole(h) { return assign({}, h); }
  // 不修改入参的球场副本(洞数组深一层复制,其余引用保持或浅复制)
  function cloneCourse(course, holes) {
    var out = assign({}, course);
    out.holes = holes;
    if (course.routings) {
      out.routings = course.routings.map(function (r) {
        var c = assign({}, r);
        if (r.holeNos) c.holeNos = r.holeNos.slice();
        return c;
      });
    }
    if (course.config) out.config = Course.mergeConfig(course.config, {});
    return out;
  }
  // 以 step 为单位四舍五入:round2(2.3, 0.5) = 2.5
  function roundStep(x, step) { return Math.round(x / step) * step; }

  // ---------- 事件语义去重:每 (holeNo, type) 取最早的 t ----------
  function dedupe(events) {
    var map = {};
    if (!events) return map;
    for (var i = 0; i < events.length; i++) {
      var e = events[i];
      if (!e || !isNum(e.t)) continue;
      var no = Number(e.holeNo);
      if (!isFinite(no)) continue;
      var slot = map[no] || (map[no] = {});
      var type = String(e.type);
      if (slot[type] == null || e.t < slot[type]) slot[type] = e.t;
    }
    return map;
  }
  function pick(map, no, type) {
    var slot = map[no];
    if (!slot) return null;
    var v = slot[type];
    return isNum(v) ? v : null;
  }

  // ---------- §4 observeRound ----------
  function observeRound(holes, booking, events, aheadEvents, fGroup, cfg) {
    cfg = cfgOf(cfg);
    var mine = dedupe(events);
    var ahead = dedupe(aheadEvents);
    var clampLo = cfg.ratioClamp && cfg.ratioClamp.length ? cfg.ratioClamp[0] : 0.5;
    var clampHi = cfg.ratioClamp && cfg.ratioClamp.length > 1 ? cfg.ratioClamp[1] : 2.0;
    var bookingId = booking ? booking.id : undefined;
    var date = booking ? booking.date : undefined;
    var observations = [];
    var ratios = [];
    var prevLeave = null;

    for (var i = 0; i < holes.length; i++) {
      var h = holes[i];
      var no = h.no;
      var teeOff = pick(mine, no, 'teeOff');
      var leave = pick(mine, no, 'leaveGreen');
      var arrive = pick(mine, no, 'arriveTee');
      var aheadLeave = pick(ahead, no, 'leaveGreen');
      var minFollow = isNum(h.minFollow) ? h.minFollow : cfg.minFollow;

      var obs = (teeOff != null && leave != null) ? leave - teeOff : null;
      var held = (teeOff == null || leave == null)
        || (arrive != null && teeOff - arrive > 1)
        || (aheadLeave != null && leave - aheadLeave <= minFollow + 1.5);

      var o = { bookingId: bookingId, date: date, holeNo: no, obs: obs, held: held, fGroup: fGroup };

      if (!held) {
        var ratio = Course.clamp(obs / h.std, clampLo, clampHi);
        o.ratio = ratio;
        ratios.push(ratio);
      }
      if (i >= 1 && prevLeave != null) {
        if (arrive != null) o.transit = arrive - prevLeave;
        else if (!held && teeOff != null) o.transit = teeOff - prevLeave;
      }
      observations.push(o);
      prevLeave = leave;
    }

    var fRound = ratios.length >= cfg.minCleanHoles ? Course.median(ratios) : null;
    return { observations: observations, fRound: fRound, cleanHoles: ratios.length };
  }

  // ---------- §4 updatePlayer / decayedN ----------
  function updatePlayer(stats, fRound, date, cfg) {
    cfg = cfgOf(cfg);
    // fRound 为 null/NaN(本轮未评分)→ 不更新:原样返回(拷贝),不凭空计一轮
    if (!isNum(fRound)) return stats ? assign({}, stats) : null;
    var n = stats ? Course.decayN(Number(stats.nEff) || 0, stats.lastRoundDate, date, cfg) : 0;
    if (!isNum(n) || n < 0) n = 0;
    var alpha = Math.max(cfg.emaAlpha, 1 / (n + 1));
    var f0 = (stats && isNum(stats.f)) ? stats.f : 1;
    var v0 = (stats && isNum(stats.v)) ? stats.v : 0.04;
    var f1 = Course.clamp((1 - alpha) * f0 + alpha * fRound, cfg.fMin, cfg.fMax);
    var v1 = (1 - alpha) * v0 + alpha * (fRound - f1) * (fRound - f1);
    return {
      playerId: stats ? stats.playerId : undefined,
      f: f1,
      v: v1,
      nEff: n + 1,
      lastRoundDate: date,
      roundsScored: ((stats && stats.roundsScored) || 0) + 1
    };
  }

  function decayedN(stats, today, cfg) {
    if (!stats) return 0;
    cfg = cfgOf(cfg);
    var n = Course.decayN(Number(stats.nEff) || 0, stats.lastRoundDate, today, cfg);
    return isNum(n) ? n : 0;
  }

  // ---------- §4 calibrate ----------
  function calibrate(observations, holes, cfg) {
    cfg = cfgOf(cfg);
    var cal = cfg.calibration || Course.defaultConfig().calibration;
    var byHole = {};
    var i;
    for (i = 0; i < (observations ? observations.length : 0); i++) {
      var o = observations[i];
      if (!o) continue;
      var no = Number(o.holeNo);
      var b = byHole[no] || (byHole[no] = { obs: [], transits: [] });
      if (!o.held && isNum(o.obs)) b.obs.push(o.obs);
      if (isNum(o.transit)) b.transits.push(o.transit);
    }

    var out = [];
    for (i = 0; i < holes.length; i++) {
      var h = holes[i];
      var bucket = byHole[h.no] || { obs: [], transits: [] };
      var n = bucket.obs.length;
      var nTransit = bucket.transits.length;
      var stdObs = n ? Course.median(bucket.obs) : NaN;
      var transitP20 = nTransit ? Course.percentile(bucket.transits, 20) : NaN;
      var suggested = {};

      if (n >= cal.minN && isNum(stdObs) && Math.abs(stdObs - h.std) >= cal.stdDeltaMin - Course.EPS) {
        var s = Math.round(stdObs);
        if (s !== h.std) suggested.std = s;
      }
      if (nTransit >= cal.minN && isNum(transitP20) && Math.abs(transitP20 - h.transit) >= cal.transitDeltaMin - Course.EPS) {
        var t = roundStep(transitP20, 0.5);
        if (t !== h.transit) suggested.transit = t;
      }

      // 采纳本洞建议后的推导基础间隔(转场不影响 B(f),但统一走 derivedIBase)
      var effHoles = holes;
      if (suggested.std != null || suggested.transit != null) {
        effHoles = holes.map(function (x) {
          if (x.no !== h.no) return x;
          var c = cloneHole(x);
          if (suggested.std != null) c.std = suggested.std;
          if (suggested.transit != null) c.transit = suggested.transit;
          return c;
        });
      }
      out.push({
        holeNo: h.no,
        n: n,
        nTransit: nTransit,
        current: { std: h.std, transit: h.transit },
        observed: { std: numOrNull(stdObs), transit: numOrNull(transitP20) },
        suggested: suggested,
        effectOnIBase: Course.derivedIBase(effHoles, cfg)
      });
    }
    return out;
  }

  // ---------- §4 applyCalibration / resetDefaults ----------
  function applyCalibration(course, picks, cfg, opts) {
    cfg = cfgOf(cfg, course);
    var limitStep = !!(opts && opts.limitStep);
    var cal = cfg.calibration || Course.defaultConfig().calibration;
    var byNo = {};
    for (var i = 0; i < (picks ? picks.length : 0); i++) {
      var p = picks[i];
      if (!p) continue;
      var no = Number(p.holeNo);
      if (!isFinite(no)) continue;
      byNo[no] = assign(byNo[no] || {}, p);
    }
    var holes = course.holes.map(function (h) {
      var pk = byNo[h.no];
      if (!pk) return cloneHole(h);
      var c = cloneHole(h);
      if (isNum(pk.std) && pk.std > 0) {
        var std = pk.std;
        if (limitStep) std = Course.clamp(std, h.std - cal.maxStepStd, h.std + cal.maxStepStd);
        c.std = std;
      }
      if (isNum(pk.transit) && pk.transit >= 0) {
        var tr = pk.transit;
        if (limitStep) tr = Course.clamp(tr, h.transit - cal.maxStepTransit, h.transit + cal.maxStepTransit);
        c.transit = tr;
      }
      return c;
    });
    var out = cloneCourse(course, holes);
    out.layoutVersion = (Number(course.layoutVersion) || 0) + 1;
    return out;
  }

  function resetDefaults(course, cfg) {
    cfg = cfgOf(cfg, course);
    var holes = course.holes.map(function (h) {
      var c = cloneHole(h);
      var par = Number(h.par) || 4;
      c.std = cfg.stdByPar[par] != null ? cfg.stdByPar[par] : cfg.stdByPar[4];
      c.transit = cfg.transitDefault;
      c.clearFrac = cfg.clearFracByPar[par] != null ? cfg.clearFracByPar[par] : cfg.clearFracByPar[4];
      return c;
    });
    var out = cloneCourse(course, holes);
    out.layoutVersion = (Number(course.layoutVersion) || 0) + 1;
    return out;
  }

  return {
    observeRound: observeRound,
    updatePlayer: updatePlayer,
    decayedN: decayedN,
    calibrate: calibrate,
    applyCalibration: applyCalibration,
    resetDefaults: resetDefaults
  };
});
