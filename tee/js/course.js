/*
 * HIOTee.Course — 球场模型:洞数据、标准时间(3杆7 / 4杆11 / 5杆15)、转场时间、配置默认值与通用工具。
 * 纯函数库:不读时钟、不碰 DOM。浏览器下挂在 window.HIOTee.Course,Node 下 module.exports。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.HIOTee = root.HIOTee || {};
    root.HIOTee.Course = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var EPS = 1e-6;

  // ---------- 配置默认值(见 SPEC §1.1) ----------
  function defaultConfig() {
    return {
      stdByPar: { 3: 7, 4: 11, 5: 15 },
      transitDefault: 2,
      clearFracByPar: { 3: 1.0, 4: 0.45, 5: 0.40 },
      minGap: 6,
      minFollow: 1,
      iBase: 8, iMin: 6, iMax: 8, iHardMax: 10, buffer: 1,
      gridMin: 1, shiftTolMin: 0, maxCandWaitMin: 15,
      fMin: 0.75, fMax: 1.4, emaAlpha: 0.3, n0Fast: 3, n0Slow: 1, halfLifeDays: 180, lambdaMax: 0.6,
      sizeMult: { 1: 1, 2: 1, 3: 1, 4: 1 },
      minCleanHoles: 6, ratioClamp: [0.5, 2.0], confidentRounds: 3,
      lagReference: 'standard',
      positionAware: true,
      yellowOn: 1, yellowOff: 0.5, redOn: 10, redOff: 8, dwellMin: 1, snoozeMin: 10, fieldDelayBannerMin: 5,
      playThrough: { cooldownMin: 20, minHolesLeft: 3, maxPaceDiff: 0.05, clearAfterMin: 3 },
      merge: { utilThreshold: 0.85, windowMin: 30, paceTol: 0.2, windowHours: 2, maxSize: 4, maxPartySize: 2, maxShare: 0.3, expireHours: 24, expireBeforeTeeMin: 120 },
      starter: { noShowGraceMin: 5, checkInWarnMin: 15, earlySendMaxMin: 2 },
      calibration: { minN: 30, windowDays: 60, autoCalibrate: false, maxStepStd: 1, maxStepTransit: 0.5, stepEveryDays: 7, stdDeltaMin: 1, transitDeltaMin: 0.5 },
      engineVersion: '1.0.0'
    };
  }

  function isPlainObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

  // 一层深合并:嵌套对象(如 merge/starter/stdByPar)按键合并,数组与标量整体替换
  function mergeConfig(base, over) {
    var out = {};
    var k;
    for (k in base) if (Object.prototype.hasOwnProperty.call(base, k)) {
      out[k] = isPlainObject(base[k]) ? mergeConfig(base[k], {}) : (Array.isArray(base[k]) ? base[k].slice() : base[k]);
    }
    if (!over) return out;
    for (k in over) if (Object.prototype.hasOwnProperty.call(over, k)) {
      if (isPlainObject(over[k]) && isPlainObject(out[k])) {
        var sub = out[k];
        for (var j in over[k]) if (Object.prototype.hasOwnProperty.call(over[k], j)) {
          sub[j] = isPlainObject(over[k][j]) ? mergeConfig(isPlainObject(sub[j]) ? sub[j] : {}, over[k][j]) : over[k][j];
        }
      } else {
        out[k] = Array.isArray(over[k]) ? over[k].slice() : over[k];
      }
    }
    return out;
  }

  // ---------- 洞与球场 ----------
  function normalizeHole(h, cfg) {
    var par = Number(h.par) || 4;
    var std = (h.std != null && isFinite(h.std)) ? Number(h.std) : (cfg.stdByPar[par] != null ? cfg.stdByPar[par] : cfg.stdByPar[4]);
    var out = {
      no: Number(h.no),
      par: par,
      std: std,
      transit: (h.transit != null && isFinite(h.transit)) ? Number(h.transit) : cfg.transitDefault,
      clearFrac: (h.clearFrac != null && isFinite(h.clearFrac)) ? Number(h.clearFrac) : (cfg.clearFracByPar[par] != null ? cfg.clearFracByPar[par] : cfg.clearFracByPar[4]),
      minGap: (h.minGap != null && isFinite(h.minGap)) ? Number(h.minGap) : cfg.minGap,
      minFollow: (h.minFollow != null && isFinite(h.minFollow)) ? Number(h.minFollow) : cfg.minFollow
    };
    if (h.yards != null) out.yards = Number(h.yards);
    if (h.name) out.name = String(h.name);
    return out;
  }

  function normalizeCourse(raw, cfgOverride) {
    raw = raw || {};
    var cfg = mergeConfig(defaultConfig(), raw.config || {});
    if (cfgOverride) cfg = mergeConfig(cfg, cfgOverride);
    var holes = (raw.holes && raw.holes.length ? raw.holes : demoLayout()).map(function (h) { return normalizeHole(h, cfg); });
    holes.sort(function (a, b) { return a.no - b.no; });
    var routings = (raw.routings || []).map(function (r) {
      return { id: String(r.id), name: r.name || String(r.id), holeNos: (r.holeNos || []).map(Number) };
    });
    if (!routings.some(function (r) { return r.id === 'r18'; })) {
      routings.unshift({ id: 'r18', name: holes.length + ' 洞', holeNos: holes.map(function (h) { return h.no; }) });
    }
    return {
      id: raw.id || 'demo',
      name: raw.name || '演示球场',
      timezone: raw.timezone || 'Asia/Shanghai',
      holes: holes,
      routings: routings,
      config: cfg,
      layoutVersion: raw.layoutVersion || 1
    };
  }

  function holesForRouting(course, routingId) {
    var r = null;
    for (var i = 0; i < course.routings.length; i++) if (course.routings[i].id === routingId) { r = course.routings[i]; break; }
    if (!r) r = course.routings[0];
    var byNo = {};
    course.holes.forEach(function (h) { byNo[h.no] = h; });
    return r.holeNos.map(function (no) { return byNo[no]; }).filter(Boolean);
  }

  // 瓶颈清空时间 B(f) = max_i max(minGap_i, clearFrac_i × std_i × f)
  function bottleneck(holes, f) {
    var b = 0;
    for (var i = 0; i < holes.length; i++) {
      var h = holes[i];
      var c = Math.max(h.minGap, h.clearFrac * h.std * f);
      if (c > b) b = c;
    }
    return b;
  }

  // 由瓶颈推导的基础间隔:ceil(B(1.0) + buffer)。默认球场 → 8。
  function derivedIBase(holes, cfg) {
    return Math.ceil(bottleneck(holes, 1.0) + cfg.buffer - EPS);
  }

  // 演示球场布局:par 72,4 个三杆洞、4 个五杆洞
  var DEMO_PARS = [4, 4, 3, 5, 4, 4, 3, 5, 4, 4, 3, 5, 4, 4, 3, 4, 5, 4];
  var DEMO_YARDS = [392, 410, 165, 530, 405, 388, 180, 545, 415, 398, 172, 520, 420, 385, 160, 430, 555, 400];
  function demoLayout() {
    return DEMO_PARS.map(function (par, i) { return { no: i + 1, par: par, yards: DEMO_YARDS[i] }; });
  }

  // ---------- 时间与数学工具 ----------
  function pad2(n) { return n < 10 ? '0' + n : '' + n; }
  function fmtHM(min) {
    if (min == null || !isFinite(min)) return '--:--';
    var m = Math.floor(min + EPS);
    m = ((m % 1440) + 1440) % 1440;
    return pad2(Math.floor(m / 60)) + ':' + pad2(m % 60);
  }
  function parseHM(s) {
    var m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(String(s || ''));
    if (!m) return NaN;
    return Number(m[1]) * 60 + Number(m[2]);
  }
  function fmtDur(min) {
    if (min == null || !isFinite(min)) return '—';
    var m = Math.round(min);
    if (m < 60) return m + ' 分钟';
    var h = Math.floor(m / 60), r = m % 60;
    return h + '小时' + (r ? r + '分' : '');
  }
  function clamp(x, lo, hi) { return x < lo ? lo : (x > hi ? hi : x); }
  function median(arr) {
    var a = arr.filter(function (x) { return x != null && isFinite(x); }).slice().sort(function (x, y) { return x - y; });
    if (!a.length) return NaN;
    var mid = a.length >> 1;
    return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
  }
  // 线性插值百分位,p ∈ [0,100]
  function percentile(arr, p) {
    var a = arr.filter(function (x) { return x != null && isFinite(x); }).slice().sort(function (x, y) { return x - y; });
    if (!a.length) return NaN;
    var pos = (a.length - 1) * clamp(p, 0, 100) / 100;
    var lo = Math.floor(pos), hi = Math.ceil(pos);
    return a[lo] + (a[hi] - a[lo]) * (pos - lo);
  }
  function mean(arr) {
    var a = arr.filter(function (x) { return x != null && isFinite(x); });
    if (!a.length) return NaN;
    var s = 0; for (var i = 0; i < a.length; i++) s += a[i];
    return s / a.length;
  }
  // 'YYYY-MM-DD' → 自 1970 起的天数(UTC),不依赖本地时钟
  function dayNumber(dateStr) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ''));
    if (!m) return NaN;
    return Math.round(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86400000);
  }
  function daysBetween(a, b) { return dayNumber(b) - dayNumber(a); }
  // 分组稳定排序键:(teeMin asc, id asc)
  function compareByTee(a, b) {
    if (a.tee !== b.tee) return a.tee - b.tee;
    return String(a.id) < String(b.id) ? -1 : (String(a.id) > String(b.id) ? 1 : 0);
  }

  return {
    EPS: EPS,
    defaultConfig: defaultConfig,
    mergeConfig: mergeConfig,
    normalizeHole: normalizeHole,
    normalizeCourse: normalizeCourse,
    holesForRouting: holesForRouting,
    bottleneck: bottleneck,
    derivedIBase: derivedIBase,
    demoLayout: demoLayout,
    fmtHM: fmtHM,
    parseHM: parseHM,
    fmtDur: fmtDur,
    clamp: clamp,
    median: median,
    percentile: percentile,
    mean: mean,
    dayNumber: dayNumber,
    daysBetween: daysBetween,
    compareByTee: compareByTee
  };
});
