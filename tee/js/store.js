/*
 * HIOTee.Store — 数据层(SPEC §8)。
 *   State / DataSource 接口(getState / subscribe / onModeChange / load / command / poll / clientSnapshot / clientProposals / demo)
 *   LocalDataSource : localStorage(或内存 Map)+ 演示模拟:单写者租约、演示时钟(06:20 起,×1/×10/×60)、
 *                     每 tick:推进时钟 → 自动签到 → Sim.step → 应用事件(开球 / 完成 → 评分学习)→ Live.evaluate → 告警 / 让行补丁
 *                     → 并组建议复核(旺季)→ 提议过期 → 通知订阅者
 *   ApiDataSource   : fetch 封装(Bearer / Idempotency-Key / If-Match / 信封解包 / 304),连续 3 次失败回退到 Local 并每 60 s 重试
 *   Store.auto      : GET /tee-api/v1/me(3 s 超时)→ Api,否则 Local(横幅:后端不可达,当前为演示数据)
 *   Store.demoSeed  : 演示球场 + 发球表种子数据(全部钉死的演示场景见 SPEC §8.3)
 * 所有纯引擎调用都发生在这里;引擎本身不读时钟。本文件允许读时钟 / 存储 / 定时器,但所有墙钟读取集中在 wallClock() 一个助手里
 * (测试可注入)。Node 下 require() 时不碰 DOM。
 * 依赖:Course, Pace, Learn, Live, Merge, Sim。浏览器下挂在 root.HIOTee.Store,Node 下 module.exports。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./course.js'), require('./pace.js'), require('./learn.js'), require('./live.js'), require('./merge.js'), require('./sim.js'));
  } else {
    root.HIOTee = root.HIOTee || {};
    root.HIOTee.Store = factory(root.HIOTee.Course, root.HIOTee.Pace, root.HIOTee.Learn, root.HIOTee.Live, root.HIOTee.Merge, root.HIOTee.Sim);
  }
})(typeof self !== 'undefined' ? self : this, function (Course, Pace, Learn, Live, Merge, Sim) {
  'use strict';

  // 全局对象:浏览器 self,Node globalThis;加载时不触碰 DOM
  const G = (typeof self !== 'undefined') ? self : ((typeof globalThis !== 'undefined') ? globalThis : {});

  const PREFIX = 'hio.tee.v1.';
  const LEASE_TTL_MS = 3000;
  const DEMO_START_MIN = 380;            // 06:20
  const DAY_END_MIN = 1440;              // 演示时钟到 24:00 停止(不跨日)
  const KEEP_DAYS = 3;                   // 按日期存储的键只保留最近 N 天(每天约 600 KB)
  const DATED_KEYS = ['bookings.', 'events.', 'alerts.', 'observations.', 'proposals.', 'sim.', 'sheet.'];
  const BANNER = {
    local: '演示模式：本地模拟数据',
    api: '已连接后端',
    fallback: '演示模式：后端不可达，当前为演示数据'
  };
  const DEFAULT_OPERATOR = { role: 'operator', userId: 'demo-op', name: '值班员' };
  const ACTIVE = { booked: true, checkedIn: true, onCourse: true };
  const OPEN_PROPOSAL = { suggested: true, proposed: true, accepted_a: true, accepted_b: true, confirmed: true };
  const IN_FLIGHT = { proposed: true, accepted_a: true, accepted_b: true, confirmed: true };

  // ---------- 小工具 ----------
  function hasOwn(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  function assign(target) {
    for (let i = 1; i < arguments.length; i++) {
      const src = arguments[i];
      if (!src) continue;
      for (const k in src) if (hasOwn(src, k)) target[k] = src[k];
    }
    return target;
  }
  function clone(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }
  function pad2(n) { return n < 10 ? '0' + n : '' + n; }
  function fail(code, message, data) {
    const e = new Error(message);
    e.code = code;
    if (data !== undefined) e.data = data;
    return e;
  }

  // 唯一的墙钟读取点(毫秒)。测试通过 Store.setWallClock(fn) 或 createLocal({ wallClock }) 注入。
  let wallClockImpl = function () { return Date.now(); };
  function wallClock() { return wallClockImpl(); }
  function setWallClock(fn) { wallClockImpl = typeof fn === 'function' ? fn : function () { return Date.now(); }; }

  function todayDate(clock) {
    const d = new Date(clock());
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }
  // 'YYYY-MM-DD' ± n 天(纯 UTC 运算)
  function addDays(date, n) {
    const dn = Course.dayNumber(date);
    if (!isFinite(dn)) return date;
    const d = new Date((dn + n) * 86400000);
    return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
  }

  function uuid() {
    const c = G.crypto;
    if (c && typeof c.randomUUID === 'function') return c.randomUUID();
    let s = '';
    for (let i = 0; i < 32; i++) s += Math.floor(Math.random() * 16).toString(16);
    return s.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
  }

  let idCounter = 0;
  function newId(prefix) {
    idCounter++;
    return prefix + '-' + wallClock().toString(36) + '-' + idCounter.toString(36);
  }

  // ---------- 存储适配:{getItem,setItem,removeItem} | Map | 默认 localStorage(失败回退内存) ----------
  function memStorage() {
    const m = new Map();
    return {
      getItem: function (k) { return m.has(k) ? m.get(k) : null; },
      setItem: function (k, v) { m.set(k, String(v)); },
      removeItem: function (k) { m.delete(k); },
      _map: m
    };
  }
  function mapStorage(m) {
    return {
      getItem: function (k) { return m.has(k) ? m.get(k) : null; },
      setItem: function (k, v) { m.set(k, String(v)); },
      removeItem: function (k) { m.delete(k); },
      _map: m
    };
  }
  function defaultStorage() {
    try {
      const ls = G.localStorage;
      if (!ls) return memStorage();
      ls.setItem(PREFIX + 'probe', '1');
      ls.removeItem(PREFIX + 'probe');
      return ls;
    } catch (e) {
      return memStorage();
    }
  }
  // 带前缀 + JSON + try/catch 的读写封装
  function wrapStorage(raw) {
    let s;
    if (!raw) s = defaultStorage();
    else if (typeof raw.getItem === 'function') s = raw;
    else if (typeof raw.get === 'function' && typeof raw.set === 'function') s = mapStorage(raw);
    else s = memStorage();
    const w = {
      get raw() { return s; },
      get: function (key) {
        try {
          const v = s.getItem(PREFIX + key);
          if (v == null) return null;
          return JSON.parse(v);
        } catch (e) { return null; }
      },
      set: function (key, value) {
        try { s.setItem(PREFIX + key, JSON.stringify(value)); return true; } catch (e) { return false; }
      },
      remove: function (key) {
        try { s.removeItem(PREFIX + key); return true; } catch (e) { return false; }
      },
      // 带前缀的全部键(localStorage 用 key(i);Map 用 keys())
      keys: function () {
        const out = [];
        try {
          if (s._map) { s._map.forEach(function (_, k) { if (String(k).indexOf(PREFIX) === 0) out.push(String(k).slice(PREFIX.length)); }); }
          else if (typeof s.key === 'function' && isNum(s.length)) { for (let i = 0; i < s.length; i++) { const k = s.key(i); if (k && k.indexOf(PREFIX) === 0) out.push(k.slice(PREFIX.length)); } }
        } catch (e) { /* ignore */ }
        return out;
      },
      // 存储写入失败(配额满)→ 换成内存 Map,并把 keys 里的现有值搬过去,之后的读写都在内存里
      toMemory: function (seedKeys) {
        const m = memStorage();
        (seedKeys || []).forEach(function (k) {
          try { const v = s.getItem(PREFIX + k); if (v != null) m.setItem(PREFIX + k, v); } catch (e) { /* ignore */ }
        });
        s = m;
        return m;
      },
      get inMemory() { return !!s._map; }
    };
    return w;
  }

  // ---------- §8.3 演示种子 ----------
  const SURNAMES = ['张', '李', '王', '刘', '陈', '杨', '赵', '周', '吴', '郑', '孙', '朱', '何', '林', '高', '马', '黄', '徐', '罗', '梁',
    '谢', '宋', '唐', '韩', '冯', '曹', '彭', '董', '袁', '邓', '许', '傅', '沈', '曾', '吕', '苏', '卢', '蒋', '蔡', '贾', '魏', '薛', '叶',
    '阎', '余', '潘', '杜', '戴', '夏', '钟', '汪', '田', '任', '姜', '范', '方', '石', '姚', '谭', '廖'];
  const GIVEN = ['伟', '娜', '强', '洋', '静', '帆', '敏', '杰', '昊', '爽', '莉', '琳', '峥', '峰', '原', '丽', '磊', '宇', '晖', '佳',
    '雪', '程', '飞', '洁', '朗', '超', '晴', '雷', '腾', '毅', '畅', '欣', '明', '玲', '晨', '凯', '童', '男', '江', '亮', '泉', '文',
    '力', '晗', '松', '凡', '星', '川', '蕾', '维', '涵', '健', '辉', '岚', '航', '勇', '兵', '非', '茜', '佳怡', '子墨', '思远', '雨桐', '浩然'];
  // 前 8 个名字固定为 SPEC 列出的示例
  const FIXED_NAMES = ['张伟', '李娜', '王强', '刘洋', '陈静', '杨帆', '赵敏', '周杰'];

  function demoSeed(date, seed) {
    date = date || '2026-10-06';
    const rng = Sim.mulberry32((seed == null ? 1 : Number(seed)) >>> 0);
    const course = Course.normalizeCourse({ id: 'demo', name: '演示球场', holes: Course.demoLayout() });
    const sheet = { courseId: 'demo', date: date, routingId: 'r18', openMin: 390, closeMin: 960, peakMode: true, fieldHoldMin: 0, seq: 0 };

    const usedNames = {};
    let nameIdx = 0;
    function nextName() {
      let n;
      if (nameIdx < FIXED_NAMES.length) n = FIXED_NAMES[nameIdx++];
      else {
        do { n = SURNAMES[Math.floor(rng() * SURNAMES.length)] + GIVEN[Math.floor(rng() * GIVEN.length)]; } while (usedNames[n]);
      }
      usedNames[n] = true;
      return n;
    }
    let pIdx = 0;
    const players = {};
    function mkPlayer(forceMember) {
      pIdx++;
      const p = { id: 'u' + pad2(pIdx < 100 ? pIdx : pIdx), name: nextName(), isMember: forceMember == null ? rng() < 0.3 : !!forceMember, shareOnCourse: true };
      if (pIdx < 10) p.id = 'u00' + pIdx; else if (pIdx < 100) p.id = 'u0' + pIdx; else p.id = 'u' + pIdx;
      players[p.id] = p;
      return p;
    }
    function hhmm(min) { return Course.fmtHM(min).replace(':', ''); }

    // 8 分钟格:392(06:32)…656(10:56),共 34 格;留 8 个空档 → 26 组
    const GAPS = { 416: true, 432: true, 528: true, 584: true, 600: true, 616: true, 632: true, 656: true };
    const PIN = {
      448: { size: 4, tf: 0.97, notes: '' },                                                    // 慢组前一组:正常步速,不遮蔽慢组的告警
      456: { size: 4, members: false, tf: 1.35, notes: '演示：慢组（真实步速 1.35）' },
      464: { size: 4, tf: 1.0, notes: '演示：标准步速，紧随慢组' },
      480: { size: 4, notes: '演示：球员端示例球组（球童 17）', caddieIds: ['c17'] },
      496: { size: 2, members: false, fast: true, tf: 0.85, allowMerge: false, notes: '演示：两位快打常客（已有步速数据）' },
      544: { size: 3, noShow: true, autoSend: false, notes: '演示：未到（不会签到）' },
      560: { size: 3, late: true, autoSend: false, notes: '演示：迟到 12 分钟' },
      640: { size: 2, members: false, tf: 1.0, notes: '演示：并组候选 A（2 人）' },
      648: { size: 1, members: false, tf: 1.0, notes: '演示：并组候选 B（1 人）' },
      784: { size: 2, members: false, tf: 1.0, notes: '演示：下午并组候选 C（2 人）' },   // 13:04 / 13:12:开球前 2 小时才过期,
      792: { size: 1, members: false, tf: 1.0, notes: '演示：下午并组候选 D（1 人）' }    // 上午全程都能在「并组建议」里看到并操作
    };
    const bookings = [];
    const trueFactorById = {};
    const paceStats = {};
    const fastIds = [];
    const TIMES = [];
    for (let t = 392; t <= 656; t += 8) if (!GAPS[t]) TIMES.push(t);
    TIMES.push(784, 792);
    for (const t of TIMES) {
      const pin = PIN[t] || {};
      const size = pin.size != null ? pin.size : (rng() < 0.25 ? 3 : 4);
      const ps = [];
      for (let i = 0; i < size; i++) {
        const p = mkPlayer(pin.members === false ? false : null);
        if (pin.fast) fastIds.push(p.id);
        ps.push(p);
      }
      const b = {
        id: 'b' + hhmm(t), date: date, routingId: 'r18', teeMin: t, size: size, players: ps,
        caddieIds: pin.caddieIds ? pin.caddieIds.slice() : [],
        status: 'booked', allowMerge: pin.allowMerge !== false, notes: pin.notes || '',
        createdAt: 0, version: 1,
        checkInAt: t - (5 + Math.floor(rng() * 21))                       // teeMin − U(5, 25)
      };
      if (pin.autoSend === false) b.autoSend = false;
      if (pin.noShow) { b.checkInAt = null; b.demoNoShow = true; }
      if (pin.late) { b.checkInAt = t + 12; b.demoLate = true; }
      bookings.push(b);
      trueFactorById[b.id] = pin.tf != null ? pin.tf : Math.round((0.90 + rng() * 0.14) * 100) / 100;   // 其余 0.90–1.04
    }
    // 两位快打常客:f 0.85, nEff 4, roundsScored 4, lastRoundDate = date − 7
    fastIds.forEach(function (id) {
      paceStats[id] = { playerId: id, f: 0.85, v: 0.01, nEff: 4, lastRoundDate: addDays(date, -7), roundsScored: 4 };
    });
    // 球童 7 / 12 / 17:两位在职、一位待批准;17 已分配给 08:00 组,7 分配给 06:32 组
    const caddies = [
      { id: 'c7', name: '小陈', no: '7', status: 'active' },
      { id: 'c12', name: '小李', no: '12', status: 'pending' },
      { id: 'c17', name: '小周', no: '17', status: 'active' }
    ];
    const first = bookings[0];
    if (first) first.caddieIds = ['c7'];
    // 好友:球员端示例 = 08:00 组第一位球员;其互相好友在 08:24 组
    const friends = {};
    const persona = bookings.filter(function (b) { return b.teeMin === 480; })[0];
    const friendGroup = bookings.filter(function (b) { return b.teeMin === 504; })[0];
    if (persona && friendGroup) {
      const me = persona.players[0].id, fr = friendGroup.players[0].id;
      friends[me] = [fr];
      friends[fr] = [me];
    }
    return { course: course, sheet: sheet, bookings: bookings, players: players, friends: friends, caddies: caddies, paceStats: paceStats, trueFactorById: trueFactorById,
      simParams: { slowHoleProb: 0.02, lostBallMin: [3, 8] } };          // 演示里"找球"少而短,让慢组的故事线清晰
  }

  // ---------- 通用:事件去重索引 ----------
  function eventKey(e) { return String(e.bookingId) + '|' + String(e.holeNo) + '|' + String(e.type); }

  function reasonText(res) {
    if (!res) return '不可行';
    const need = isNum(res.need) ? res.need : null;
    switch (res.reason) {
      case 'OUTSIDE_HOURS': return '不在营业时间内';
      case 'GAP_AHEAD': return '与前组间隔不足' + (need != null ? '（需 ≥ ' + need + ' 分钟）' : '');
      case 'GAP_BEHIND': return '与后组间隔不足' + (need != null ? '（需 ≥ ' + need + ' 分钟）' : '');
      case 'IMPACTS_BEHIND': return '会影响后组' + (isNum(res.shiftMin) ? '（推迟约 ' + Math.ceil(res.shiftMin) + ' 分钟）' : '');
      default: return '该时间不可行';
    }
  }

  // ======================================================================
  // LocalDataSource
  // ======================================================================
  function createLocal(opts) {
    opts = opts || {};
    const clock = typeof opts.wallClock === 'function' ? opts.wallClock : wallClock;
    const store = wrapStorage(opts.storage);
    const tabId = opts.tabId || ('tab-' + Math.floor(Math.random() * 1e9).toString(36));
    const seed = opts.seed == null ? 1 : Number(opts.seed);
    let date = opts.date || todayDate(clock);

    const state = {
      course: null, sheet: null, bookings: [], events: [], paceStats: {}, observations: [], proposals: [], ratings: [],
      caddies: [], players: {}, friends: {}, me: null, friendIds: new Set(),
      alerts: {}, live: null, now: DEMO_START_MIN, date: date, mode: 'local', seq: 0, serverNow: undefined,
      banner: opts.banner || BANNER.local, storageError: false, dayEnded: false
    };
    let lastPersistedSeq = 0;              // 本页最后一次成功写入存储的 seq;只有存储里的 seq 更新时才回读
    let sim = null;
    let lastCtx = null;
    let eventIndex = {};
    const subs = [];
    const modeSubs = [];
    let demoSpeed = 1;
    let demoAutoSend = true;
    let timer = null;
    let leader = false;
    let mergeDirty = true;
    let lastMergeMinute = -1;
    let dirty = {};
    let storageListener = null;

    // me:显式 opts.me > 客户端模式的已存 ClientProfile(可为空 → 注册页) > 值班员
    if (opts.me) state.me = assign({}, opts.me);
    else if (opts.client) state.me = store.get('client') || null;
    else state.me = assign({}, DEFAULT_OPERATOR);

    // ---------- 取值助手 ----------
    function cfg() { return state.course ? state.course.config : Course.defaultConfig(); }
    function holes() { return state.course ? Course.holesForRouting(state.course, state.sheet ? state.sheet.routingId : undefined) : []; }
    function bookingById(id) {
      for (let i = 0; i < state.bookings.length; i++) if (state.bookings[i].id === id) return state.bookings[i];
      return null;
    }
    function mustBooking(id) {
      const b = bookingById(id);
      if (!b) throw fail(40401, '预订不存在：' + id);
      return b;
    }
    function proposalById(id) {
      for (let i = 0; i < state.proposals.length; i++) if (state.proposals[i].id === id) return state.proposals[i];
      return null;
    }
    function mustProposal(id) {
      const p = proposalById(id);
      if (!p) throw fail(40401, '并组提议不存在：' + id);
      return p;
    }
    function eventsOf(bookingId) {
      return state.events.filter(function (e) { return e.bookingId === bookingId; });
    }
    function rebuildEventIndex() {
      eventIndex = {};
      state.events.forEach(function (e) { eventIndex[eventKey(e)] = e; });
    }
    function progressMap() {
      const hs = holes();
      const out = {};
      state.bookings.forEach(function (b) {
        if (!ACTIVE[b.status]) return;
        out[b.id] = Live.deriveProgress(b, eventsOf(b.id), hs);
      });
      return out;
    }
    function liveOrder() { return state.live && state.live.order ? state.live.order : undefined; }
    function friendsOf(pid) { return new Set(state.friends[pid] || []); }
    function computeFriendIds() {
      const s = new Set();
      const me = state.me;
      if (me && me.userId != null) {
        (state.friends[me.userId] || []).forEach(function (f) {
          if ((state.friends[f] || []).indexOf(me.userId) >= 0) s.add(f);
        });
      }
      state.friendIds = s;
    }
    function loadRatings() {
      const me = state.me;
      state.ratings = (me && me.userId != null) ? (store.get('ratings.' + me.userId) || []) : [];
    }
    function playersDirectoryFromBookings() {
      state.bookings.forEach(function (b) {
        (b.players || []).forEach(function (p) { if (p && p.id != null && !state.players[p.id]) state.players[p.id] = p; });
      });
    }

    // ---------- 租约(单写者) ----------
    function readLease() { return store.get('simLease'); }
    function tryLease(force) {
      const nowMs = clock();
      const l = readLease();
      if (force || !l || !isNum(l.until) || l.until <= nowMs || l.owner === tabId) {
        if (!store.set('simLease', { owner: tabId, until: nowMs + LEASE_TTL_MS })) onStorageFailure();
        leader = true;
        return true;
      }
      leader = false;
      return false;
    }
    function isLeader() {
      const l = readLease();
      return !!(l && l.owner === tabId && isNum(l.until) && l.until > clock());
    }
    // 存储写入失败(配额满等):切到内存存储,带上当前所有键,之后本页继续独立运行;state.storageError 供页面显示横幅
    function onStorageFailure() {
      if (store.inMemory) return;
      store.toMemory(store.keys());
      state.storageError = true;
      markAll();
      store.set('simLease', { owner: tabId, until: clock() + LEASE_TTL_MS });
      leader = true;
    }

    // ---------- 持久化 ----------
    function markAll() {
      dirty = { bookings: true, events: true, alerts: true, observations: true, pace: true, proposals: true, course: true, directory: true, sim: true };
    }
    // 返回是否全部写入成功;失败一次即切到内存存储并重写一遍(数据不丢,只是不再落盘)
    function persist(force) {
      if (!leader && !force) { dirty = {}; return true; }
      state.seq++;
      state.sheet.seq = state.seq;
      let ok = writeDirty();
      if (!ok) {
        onStorageFailure();
        ok = writeDirty();
      }
      if (ok) lastPersistedSeq = state.seq;
      dirty = {};
      return ok;
    }
    function writeDirty() {
      let ok = true;
      function w(key, value) { if (!store.set(key, value)) ok = false; }
      if (dirty.bookings) w('bookings.' + date, state.bookings);
      if (dirty.events) w('events.' + date, state.events);
      if (dirty.alerts) w('alerts.' + date, state.alerts);
      if (dirty.observations) w('observations.' + date, state.observations);
      if (dirty.pace) w('pace', state.paceStats);
      if (dirty.proposals) w('proposals.' + date, state.proposals);
      if (dirty.course) { w('course', state.course); w('config', state.course.config); }
      if (dirty.directory) w('directory', { players: state.players, friends: state.friends, caddies: state.caddies });
      w('sheet.' + date, state.sheet);
      if (sim) {
        const ser = Sim.serialize(sim);
        ser.clock = { now: state.now, speed: demoSpeed, autoSend: demoAutoSend };
        w('sim.' + date, ser);
      }
      return ok;
    }
    // 清理过期的按日期键(保留最近 KEEP_DAYS 天),避免 5 MB 配额被旧演示日占满
    function purgeOldDates() {
      store.keys().forEach(function (k) {
        for (let i = 0; i < DATED_KEYS.length; i++) {
          const pre = DATED_KEYS[i];
          if (k.indexOf(pre) !== 0) continue;
          const kd = k.slice(pre.length);
          if (!/^\d{4}-\d{2}-\d{2}$/.test(kd)) continue;
          const diff = Course.daysBetween(kd, date);
          if (isFinite(diff) && diff > KEEP_DAYS) store.remove(k);
        }
      });
    }

    function restoreFromStorage() {
      const course = store.get('course');
      const config = store.get('config');
      if (course) state.course = Course.normalizeCourse(course, config || undefined);
      const sheet = store.get('sheet.' + date);
      if (sheet) state.sheet = sheet;
      state.bookings = store.get('bookings.' + date) || [];
      state.events = store.get('events.' + date) || [];
      state.alerts = store.get('alerts.' + date) || {};
      state.observations = store.get('observations.' + date) || [];
      state.paceStats = store.get('pace') || {};
      state.proposals = store.get('proposals.' + date) || [];
      const dir = store.get('directory') || {};
      state.players = dir.players || {};
      state.friends = dir.friends || {};
      state.caddies = dir.caddies || [];
      playersDirectoryFromBookings();
      rebuildEventIndex();
      const simObj = store.get('sim.' + date);
      if (simObj) {
        sim = Sim.deserialize(simObj, { holes: holes(), cfg: cfg() });
        if (simObj.clock) {
          if (isNum(simObj.clock.now)) { state.now = Math.min(simObj.clock.now, DAY_END_MIN); state.dayEnded = state.now >= DAY_END_MIN - Course.EPS; }
          if (isNum(simObj.clock.speed)) demoSpeed = simObj.clock.speed;
          if (typeof simObj.clock.autoSend === 'boolean') demoAutoSend = simObj.clock.autoSend;
        }
      }
      state.seq = state.sheet && isNum(state.sheet.seq) ? state.sheet.seq : 0;
      lastPersistedSeq = state.seq;
    }

    function seedNew(sd) {
      const s = demoSeed(date, sd);
      state.dayEnded = false;
      state.course = s.course;
      state.sheet = s.sheet;
      state.bookings = s.bookings;
      state.events = [];
      state.alerts = {};
      state.observations = [];
      state.paceStats = s.paceStats;
      state.proposals = [];
      state.players = s.players;
      state.friends = s.friends;
      state.caddies = s.caddies;
      state.now = DEMO_START_MIN;
      state.seq = 0;
      rebuildEventIndex();
      sim = Sim.create(assign({ holes: holes(), cfg: cfg(), bookings: state.bookings, trueFactorById: s.trueFactorById, seed: sd }, s.simParams || {}));
      lastMergeMinute = -1;
      mergeDirty = true;
      markAll();
    }

    // 从存储刷新(跟随者 / 领导者发现 seq 变化时)
    function refreshFromStorage() {
      const stored = store.get('bookings.' + date);
      if (!stored || !stored.length) return false;
      restoreFromStorage();
      computeFriendIds();
      evaluateOnly();
      return true;
    }

    // ---------- 事件应用 ----------
    function addEvent(ev) {
      const hs = holes();
      if (!ev || !isNum(ev.t) || ev.bookingId == null) return null;
      let known = false;
      for (let i = 0; i < hs.length; i++) if (hs[i].no === Number(ev.holeNo)) { known = true; break; }
      if (!known) return null;
      const key = eventKey(ev);
      const existing = eventIndex[key];
      if (existing) {
        if (ev.t < existing.t - Course.EPS) {
          existing.t = ev.t; existing.source = ev.source; if (ev.by != null) existing.by = ev.by;
          dirty.events = true;
          return existing;
        }
        return null;
      }
      const e = { id: ev.id || newId('ev'), bookingId: ev.bookingId, holeNo: Number(ev.holeNo), type: ev.type, t: ev.t, source: ev.source || 'sim' };
      if (ev.by != null) e.by = ev.by;
      state.events.push(e);
      eventIndex[key] = e;
      dirty.events = true;
      return e;
    }

    function scoreRound(b) {
      const hs = holes();
      const evs = eventsOf(b.id);
      let aheadId = null;
      if (state.live && state.live.byId && state.live.byId[b.id]) aheadId = state.live.byId[b.id].aheadId;
      const aheadEvs = aheadId ? eventsOf(aheadId) : [];
      let fGroup = 1;
      if (lastCtx && lastCtx.plansById && lastCtx.plansById[b.id]) fGroup = lastCtx.plansById[b.id].f;
      else fGroup = Pace.groupPlan(b.players || [], state.paceStats, cfg(), date, b.size).f;
      const obs = Learn.observeRound(hs, b, evs, aheadEvs, fGroup, cfg());
      b.fRound = obs.fRound;
      b.cleanHoles = obs.cleanHoles;
      if (obs.fRound != null) {
        (b.players || []).forEach(function (p) {
          if (!p || p.id == null) return;
          const prev = state.paceStats[p.id] || null;
          const next = Learn.updatePlayer(prev, obs.fRound, date, cfg());
          next.playerId = p.id;
          state.paceStats[p.id] = next;
        });
        dirty.pace = true;
        state.observations = state.observations.concat(obs.observations);
        dirty.observations = true;
      }
      return obs;
    }

    function finishBooking(b, t, manual) {
      b.status = 'finished';
      b.finishedAt = t;
      if (manual) b.finishedManually = true;
      b.version = (b.version || 1) + 1;
      dirty.bookings = true;
      mergeDirty = true;
      scoreRound(b);
    }

    function applyEvents(evs) {
      const hs = holes();
      if (!hs.length) return;
      const firstNo = hs[0].no, lastNo = hs[hs.length - 1].no;
      evs.forEach(function (ev) {
        const stored = addEvent(ev);
        if (!stored) return;
        const b = bookingById(ev.bookingId);
        if (!b) return;
        if (stored.type === 'teeOff' && stored.holeNo === firstNo && (b.status === 'booked' || b.status === 'checkedIn')) {
          b.status = 'onCourse';
          b.teeOffActual = stored.t;
          if (b.checkedInAt == null) b.checkedInAt = stored.t;
          b.version = (b.version || 1) + 1;
          dirty.bookings = true;
          mergeDirty = true;
        }
        if (stored.type === 'leaveGreen' && stored.holeNo === lastNo && b.status === 'onCourse') finishBooking(b, stored.t, false);
      });
    }

    // ---------- 自动签到 ----------
    function autoCheckIn(to) {
      state.bookings.forEach(function (b) {
        if (b.status !== 'booked' || !isNum(b.checkInAt) || b.checkInAt > to) return;
        b.status = 'checkedIn';
        b.checkedInAt = b.checkInAt;
        if (b.demoLate) b.autoSend = true;          // 迟到者签到后恢复自动开球
        b.version = (b.version || 1) + 1;
        dirty.bookings = true;
      });
    }

    // ---------- 评估 + 并组复核 ----------
    function mergeCtx(ctx) {
      return {
        sheet: state.sheet, bookings: state.bookings, holes: ctx.holes, cfg: ctx.cfg, plansById: ctx.plansById,
        statsById: state.paceStats, friendsOf: friendsOf, now: state.now, waitlistLen: 0,
        progressById: progressMap(), order: liveOrder()
      };
    }
    function reconcileMerges(ctx) {
      const mctx = mergeCtx(ctx);
      const fresh = Merge.suggest(mctx);
      const freshById = {};
      fresh.forEach(function (p) { freshById[p.id] = p; });
      const next = [];
      let changed = false;
      state.proposals.forEach(function (p) {
        if (p.status === 'suggested') {
          if (freshById[p.id]) { next.push(p); delete freshById[p.id]; }
          else changed = true;                                              // 不再建议 → 移除
        } else if (IN_FLIGHT[p.status]) {
          const a = bookingById(p.a), b = bookingById(p.b);
          let ok = !!(a && b && Merge.isMergeable(a, ctx.cfg) && Merge.isMergeable(b, ctx.cfg));
          if (ok) {
            try { ok = Merge.checkPair(mctx, a, b, p.keep).ok; } catch (e) { ok = false; }
          }
          if (ok) next.push(p);
          else { next.push(Merge.transition(p, 'withdraw', null, state.now, '时段已不可行，系统自动撤回')); changed = true; }
          delete freshById[p.id];
        } else {
          next.push(p);                                                      // 终态保留(含已过期,供 UI 说明原因)
          delete freshById[p.id];
        }
      });
      for (const id in freshById) if (hasOwn(freshById, id)) {
        let p = freshById[id];
        if (isNum(p.expiresAt) && p.expiresAt < p.createdAt) p = Merge.transition(p, 'expire', null, state.now, '距开球不足 120 分钟，无法发起并组');
        next.push(p);
        changed = true;
      }
      if (changed || next.length !== state.proposals.length) { state.proposals = next; dirty.proposals = true; }
      mergeDirty = false;
    }
    function expireProposals() {
      let changed = false;
      state.proposals = state.proposals.map(function (p) {
        if (OPEN_PROPOSAL[p.status] && Merge.isExpired(p, state.now)) { changed = true; return Merge.transition(p, 'expire', null, state.now, '已过期'); }
        return p;
      });
      if (changed) dirty.proposals = true;
    }

    // 只评估、不写存储(跟随者 / 加载)
    function evaluateOnly() {
      const ctx = Live.buildCtx(state, state.now, state.alerts);
      lastCtx = ctx;
      const res = Live.evaluate(ctx);
      state.live = res;
      return res;
    }
    // 评估 + 告警 + 让行补丁 + 并组复核 + 过期 + 持久化 + 通知(领导者的每个 tick / 每条命令之后)
    function evaluateAndFinish(force) {
      const ctx = Live.buildCtx(state, state.now, state.alerts);
      lastCtx = ctx;
      const res = Live.evaluate(ctx);
      state.live = res;
      state.alerts = res.alerts;
      dirty.alerts = true;
      for (const id in res.patches) if (hasOwn(res.patches, id)) {
        const b = bookingById(id);
        if (b && res.patches[id].playThrough) { b.playThrough = res.patches[id].playThrough; dirty.bookings = true; }
      }
      if (mergeDirty) reconcileMerges(ctx);
      expireProposals();
      persist(force);
      notify();
      return res;
    }

    function notify() {
      subs.slice().forEach(function (cb) {
        try { cb(state); } catch (e) { /* 订阅者错误不影响数据层 */ }
      });
    }

    // ---------- 演示时钟 ----------
    function reloadIfChanged() {
      // 只有存储里的 seq 比本页最后一次成功写入的更新(别的标签页写过)才回读;本页写失败不会把自己回退
      const sheet = store.get('sheet.' + date);
      if (sheet && isNum(sheet.seq) && sheet.seq > lastPersistedSeq) refreshFromStorage();
    }
    function advance(dtMin) {
      const from = state.now;
      const to = Math.min(from + dtMin, DAY_END_MIN);
      if (to <= from) { endDay(); return; }
      state.now = to;
      if (to >= DAY_END_MIN - Course.EPS) endDay();
      autoCheckIn(to);
      const ctxPre = Live.buildCtx(state, from, state.alerts);
      const simBookings = demoAutoSend ? state.bookings : state.bookings.map(function (b) { return assign({}, b, { autoSend: false }); });
      const r = Sim.step(sim, simBookings, from, to, { fieldHoldMin: state.sheet.fieldHoldMin || 0, plansById: ctxPre.plansById });
      sim = r.state;
      dirty.sim = true;
      applyEvents(r.events);
      const minute = Math.floor(to + Course.EPS);
      if (minute !== lastMergeMinute) { mergeDirty = true; lastMergeMinute = minute; }
    }
    // 24:00:演示结束,时钟停住(不跨日,不把 1442 这样的时间写进存储);reset() 重新开始
    function endDay() {
      if (state.dayEnded) return;
      state.dayEnded = true;
      stop();
    }
    function tick(dtMin) {
      if (!state.sheet) return;
      if (state.dayEnded) { stop(); return; }
      if (!tryLease(false)) {               // 跟随者:只读
        refreshFromStorage();
        notify();
        return;
      }
      reloadIfChanged();
      if (isNum(dtMin) && dtMin > 0) advance(dtMin);
      evaluateAndFinish();
    }
    function start() {
      if (timer != null) return;
      if (typeof G.setInterval !== 'function') return;
      timer = G.setInterval(function () {
        try { tick(demoSpeed / 60); } catch (e) { /* 演示时钟不因单次错误停摆 */ }
      }, 1000);
    }
    function stop() {
      if (timer != null && typeof G.clearInterval === 'function') G.clearInterval(timer);
      timer = null;
    }
    function jumpTo(min) {
      if (!isNum(min)) return;
      min = Math.min(min, DAY_END_MIN);
      if (min <= state.now || state.dayEnded) return;
      let guard = 0;
      while (state.now < min - Course.EPS && guard++ < 2000) {
        const step = Math.min(1, min - state.now);
        if (!tryLease(false)) { refreshFromStorage(); break; }
        advance(step);
        if (state.dayEnded) break;
        if (state.now < min - Course.EPS) {
          // 中间步骤:评估但不通知
          const ctx = Live.buildCtx(state, state.now, state.alerts);
          lastCtx = ctx;
          const res = Live.evaluate(ctx);
          state.live = res; state.alerts = res.alerts;
          for (const id in res.patches) if (hasOwn(res.patches, id)) {
            const b = bookingById(id);
            if (b && res.patches[id].playThrough) b.playThrough = res.patches[id].playThrough;
          }
          if (mergeDirty) reconcileMerges(ctx);
          expireProposals();
        }
      }
      dirty.bookings = dirty.events = dirty.alerts = true;
      evaluateAndFinish();
    }
    function reset(sd) {
      stop();
      ['bookings.', 'events.', 'alerts.', 'observations.', 'proposals.', 'sim.', 'sheet.'].forEach(function (k) { store.remove(k + date); });
      store.remove('pace'); store.remove('course'); store.remove('config'); store.remove('directory');
      if (sd != null) opts.seed = Number(sd);
      state.dayEnded = false;
      tryLease(true);
      seedNew(sd == null ? seed : Number(sd));
      computeFriendIds();
      loadRatings();
      evaluateAndFinish(true);
      if (opts.startClock !== false) start();
    }

    // ---------- 可行性(createBooking / moveBooking 共用) ----------
    function feasibility(booking) {
      const ctx = Live.buildCtx(state, state.now, state.alerts);
      const plan = Pace.groupPlan(booking.players || [], state.paceStats, ctx.cfg, date, booking.size);
      const others = state.bookings.filter(function (b) { return b.id !== booking.id; });
      const groups = Pace.sheetGroups(others, ctx.plansById, { fieldHoldMin: ctx.fieldHoldMin, progressById: progressMap(), order: liveOrder() });
      const cand = Pace.toPGroup(booking, plan, { fieldHoldMin: ctx.fieldHoldMin });
      const res = Pace.checkInsert(ctx.holes, ctx.cfg, groups, cand, { openMin: state.sheet.openMin, closeMin: state.sheet.closeMin, now: state.now });
      let snapshot = res.projection || null;
      if (!snapshot) snapshot = Pace.projectSheet(ctx.holes, Pace.insertCand(groups, cand), { now: state.now }).byId[cand.id];
      return { res: res, snapshot: snapshot, plan: plan };
    }

    // ---------- §8.2 命令 ----------
    const commands = {
      createBooking: function (p) {
        p = p || {};
        const teeMin = Math.round(Number(p.teeMin));
        if (!isNum(teeMin)) throw fail(40001, '请填写开球时间');
        const size = Math.max(1, Math.min(4, Math.round(Number(p.size) || (p.players ? p.players.length : 0) || 1)));
        const players = (p.players || []).slice(0, size).map(function (x, i) {
          const pl = { id: x && x.id != null ? x.id : newId('u'), name: String((x && x.name) || ('球员 ' + (i + 1))), isMember: !!(x && x.isMember), shareOnCourse: true };
          return pl;
        });
        const b = {
          id: newId('bk'), date: date, routingId: state.sheet.routingId, teeMin: teeMin, size: size, players: players,
          caddieIds: (p.caddieIds || []).slice(), status: 'booked', allowMerge: p.allowMerge !== false, notes: String(p.notes || ''),
          createdAt: state.now, version: 1, checkInAt: teeMin - 10
        };
        if (isNum(p.intervalOverride) && p.intervalOverride > 0) b.intervalOverride = p.intervalOverride;
        const fe = feasibility(b);
        if (!fe.res.ok && !p.force) throw fail(42201, reasonText(fe.res), fe.res);
        b.planSnapshot = fe.snapshot;
        if (!fe.res.ok) b.forced = true;
        state.bookings.push(b);
        players.forEach(function (pl) { state.players[pl.id] = pl; });
        dirty.bookings = true; dirty.directory = true; mergeDirty = true;
        return b;
      },
      moveBooking: function (p) {
        const b = mustBooking(p.id);
        if (b.status !== 'booked' && b.status !== 'checkedIn') throw fail(40001, '已开球或已结束的球组不能改时');
        const teeMin = Math.round(Number(p.teeMin));
        if (!isNum(teeMin)) throw fail(40001, '请填写开球时间');
        const moved = assign({}, b, { teeMin: teeMin });
        const fe = feasibility(moved);
        if (!fe.res.ok && !p.force) throw fail(42201, reasonText(fe.res), fe.res);
        b.teeMin = teeMin;
        b.planSnapshot = fe.snapshot;
        if (isNum(b.checkInAt) && b.status === 'booked') b.checkInAt = Math.min(b.checkInAt, teeMin - 5);
        b.version = (b.version || 1) + 1;
        dirty.bookings = true; mergeDirty = true;
        return b;
      },
      patchBooking: function (p) {
        const b = mustBooking(p.id);
        if (p.version != null && Number(p.version) !== (b.version || 1)) throw fail(40901, '版本冲突，请刷新后重试', { version: b.version });
        const patch = p.patch || {};
        for (const k in patch) if (hasOwn(patch, k) && k !== 'id' && k !== 'version') b[k] = patch[k];
        b.version = (b.version || 1) + 1;
        dirty.bookings = true; mergeDirty = true;
        return b;
      },
      checkIn: function (p) {
        const b = mustBooking(p.id);
        if (b.status !== 'booked') throw fail(40001, '当前状态不能签到：' + b.status);
        b.status = 'checkedIn';
        b.checkedInAt = state.now;
        if (b.demoLate) b.autoSend = true;
        b.version = (b.version || 1) + 1;
        dirty.bookings = true;
        return b;
      },
      noShow: function (p) {
        const b = mustBooking(p.id);
        if (b.status !== 'booked' && b.status !== 'checkedIn') throw fail(40001, '当前状态不能标记未到：' + b.status);
        b.status = 'noShow';
        b.version = (b.version || 1) + 1;
        dirty.bookings = true; mergeDirty = true;
        return b;
      },
      cancel: function (p) {
        const b = mustBooking(p.id);
        if (b.status === 'onCourse' || b.status === 'finished') throw fail(40001, '已开球的球组不能取消');
        b.status = 'cancelled';
        b.version = (b.version || 1) + 1;
        dirty.bookings = true; mergeDirty = true;
        return b;
      },
      finishManually: function (p) {
        const b = mustBooking(p.id);
        if (b.status !== 'onCourse') throw fail(40001, '只有场上球组可以标记完成');
        finishBooking(b, state.now, true);
        return b;
      },
      teeOff: function (p) {
        const b = mustBooking(p.id);
        if (b.status !== 'booked' && b.status !== 'checkedIn') throw fail(40001, '当前状态不能开球：' + b.status);
        const hs = holes();
        const t = isNum(p.t) ? p.t : state.now;
        b.autoSend = false;
        applyEvents([{ bookingId: b.id, holeNo: hs[0].no, type: 'teeOff', t: t, source: 'marshal', by: state.me ? state.me.userId : undefined }]);
        if (b.status !== 'onCourse') { b.status = 'onCourse'; b.teeOffActual = t; dirty.bookings = true; }
        return b;
      },
      setSheet: function (p) {
        const patch = (p && p.patch) || {};
        ['peakMode', 'openMin', 'closeMin', 'fieldHoldMin'].forEach(function (k) { if (hasOwn(patch, k)) state.sheet[k] = patch[k]; });
        mergeDirty = true;
        return state.sheet;
      },
      fieldHold: function (p) {
        state.sheet.fieldHoldMin = Math.max(0, Number((p && p.min) || 0));
        mergeDirty = true;
        return state.sheet;
      },
      postEvent: function (p) {
        const b = mustBooking(p.bookingId);
        if (!p.type || ['arriveTee', 'teeOff', 'leaveGreen'].indexOf(p.type) < 0) throw fail(40001, '未知事件类型');
        requireActiveCaddie();                                                 // 待批准的球童不能记录事件
        const ev = { bookingId: b.id, holeNo: Number(p.holeNo), type: p.type, t: isNum(p.t) ? p.t : state.now, source: p.source || 'marshal', by: p.by != null ? p.by : (state.me ? state.me.userId : undefined) };
        const before = eventIndex[eventKey(ev)];
        applyEvents([ev]);
        return eventIndex[eventKey(ev)] || before;
      },
      ackAlert: function (p) {
        const b = mustBooking(p.bookingId);
        const c = cfg();
        const prev = state.alerts[b.id] || { level: 'green', since: state.now };
        const snooze = p.action === 'ignore' ? 20 : (c.snoozeMin || 10);
        const next = assign({}, prev, { snoozeUntil: state.now + snooze, snoozedLevel: prev.level, ackedAt: state.now, ackAction: p.action || 'urge' });
        state.alerts[b.id] = next;
        dirty.alerts = true;
        return next;
      },
      playThrough: function (p) {
        const b = mustBooking(p.bookingId);
        const idx = state.bookings.indexOf(b);
        let out;
        if (p.decision === 'accepted') {
          let behindId = p.behindId;
          if (behindId == null && b.playThrough) behindId = b.playThrough.behindId;
          if (behindId == null && state.live && state.live.byId[b.id]) behindId = state.live.byId[b.id].behindId;
          if (behindId == null) throw fail(40001, '没有可让行的后组');
          const prog = Live.deriveProgress(b, eventsOf(b.id), holes());
          out = Live.acceptPlayThrough(b, behindId, state.now, prog);
        } else if (p.decision === 'ignored') {
          out = Live.ignorePlayThrough(b, state.now);
        } else throw fail(40001, '未知决定：' + p.decision);
        out.version = (b.version || 1) + 1;
        state.bookings[idx] = out;
        dirty.bookings = true;
        return out;
      },
      proposeMerge: function (p) { return transitionProposal(p.proposalId, 'propose', null); },
      withdrawMerge: function (p) { return transitionProposal(p.proposalId, 'withdraw', null); },
      respondMerge: function (p) {
        if (p.side !== 'a' && p.side !== 'b') throw fail(40001, 'side 必须是 a 或 b');
        return transitionProposal(p.proposalId, p.decision === 'accept' ? 'accept' : 'decline', p.side);
      },
      applyMerge: function (p) {
        const pr = mustProposal(p.proposalId);
        if (pr.status !== 'confirmed') throw fail(40001, '只有双方确认的提议可以应用');
        state.bookings = Merge.apply(state.bookings, pr);
        const keepB = bookingById(pr.keep === 'b' ? pr.b : pr.a);
        if (keepB) {
          keepB.version = (keepB.version || 1) + 1;
          try { keepB.planSnapshot = feasibility(keepB).snapshot; } catch (e) { /* 快照可选 */ }
        }
        const next = Merge.transition(pr, 'apply', null, state.now);
        replaceProposal(next);
        dirty.bookings = true; mergeDirty = true;
        return next;
      },
      adoptCalibration: function (p) {
        state.course = Learn.applyCalibration(state.course, (p && p.picks) || [], cfg());
        afterCourseChange();
        return state.course;
      },
      resetCalibration: function () {
        state.course = Learn.resetDefaults(state.course, cfg());
        afterCourseChange();
        return state.course;
      },
      saveConfig: function (p) {
        const merged = Course.mergeConfig(cfg(), (p && p.config) || {});
        state.course = assign({}, state.course, { config: merged });
        afterCourseChange();
        return state.course;
      },
      saveHoles: function (p) {
        const raw = assign({}, state.course, { holes: (p && p.holes) || state.course.holes });
        const c = Course.normalizeCourse(raw);
        c.layoutVersion = (Number(state.course.layoutVersion) || 0) + 1;
        state.course = c;
        afterCourseChange();
        return state.course;
      },
      approveCaddie: function (p) {
        let c = null;
        state.caddies.forEach(function (x) { if (x.id === p.id) c = x; });
        if (!c) throw fail(40401, '球童不存在：' + p.id);
        c.status = 'active';
        dirty.directory = true;
        return c;
      },
      rate: function (p) {
        const me = state.me;
        if (!me || me.userId == null) throw fail(40101, '请先注册');
        requireActiveCaddie();                                                 // 待批准的球童不能评分
        const b = mustBooking(p.bookingId);
        const raterRole = me.role === 'caddie' ? 'caddie' : 'player';
        const playerIds = (b.players || []).map(function (x) { return x.id; });
        const caddieIds = b.caddieIds || [];
        const raterIn = raterRole === 'caddie' ? caddieIds.indexOf(me.userId) >= 0 : playerIds.indexOf(me.userId) >= 0;
        if (!raterIn) throw fail(40301, '只能评价自己所在球组');
        if (b.status !== 'finished') throw fail(40001, '完赛后才能评分');     // 与 live.html 的表单门槛一致
        const rateeRole = p.rateeRole || (raterRole === 'caddie' ? 'player' : 'caddie');
        if (rateeRole === raterRole) throw fail(40001, '球员评价球童，球童评价球员');
        const rateeIn = rateeRole === 'caddie' ? caddieIds.indexOf(p.rateeId) >= 0 : playerIds.indexOf(p.rateeId) >= 0;
        if (!rateeIn) throw fail(40001, '被评价者不在该球组');
        const stars = Math.max(1, Math.min(5, Math.round(Number(p.stars) || 0)));
        if (!stars) throw fail(40001, '请选择 1–5 星');
        let r = null;
        state.ratings.forEach(function (x) { if (x.bookingId === b.id && x.raterId === me.userId && x.rateeId === p.rateeId) r = x; });
        if (r) {
          r.stars = stars; r.tags = (p.tags || []).slice(); r.comment = String(p.comment || ''); r.updatedAt = state.now;
        } else {
          r = { id: newId('r'), bookingId: b.id, date: date, raterId: me.userId, raterRole: raterRole, rateeId: p.rateeId, rateeRole: rateeRole,
            stars: stars, tags: (p.tags || []).slice(), comment: String(p.comment || ''), createdAt: state.now, updatedAt: state.now };
          state.ratings.push(r);
        }
        store.set('ratings.' + me.userId, state.ratings);                  // 仅评分者可读
        return r;
      },
      registerClient: function (p) {
        p = p || {};
        const role = p.role === 'caddie' ? 'caddie' : 'player';
        const name = String(p.name || '').trim();
        if (!name) throw fail(40001, '请填写姓名');
        let userId = p.userId != null ? p.userId : null;
        let bookingId = p.bookingId != null ? p.bookingId : undefined;
        let caddieNo;
        if (role === 'caddie') {
          caddieNo = String(p.caddieNo || '').trim();
          if (!caddieNo) throw fail(40001, '请填写球童编号');
          let c = null;
          state.caddies.forEach(function (x) { if (String(x.no) === caddieNo) c = x; });
          if (!c) {
            c = { id: 'c' + caddieNo, name: name, no: caddieNo, status: 'pending' };
            state.caddies.push(c);
            dirty.directory = true;
          }
          if (userId == null) userId = c.id;
          if (bookingId === undefined) {
            state.bookings.forEach(function (b) { if (bookingId === undefined && ACTIVE[b.status] && (b.caddieIds || []).indexOf(c.id) >= 0) bookingId = b.id; });
          }
        } else {
          const b = bookingId ? bookingById(bookingId) : null;
          if (b && userId == null) (b.players || []).forEach(function (x) { if (userId == null && x.name === name) userId = x.id; });
          if (userId == null) {
            for (const pid in state.players) if (hasOwn(state.players, pid) && state.players[pid].name === name && userId == null) {
              userId = pid;
              if (bookingId === undefined) state.bookings.forEach(function (bb) {
                if (bookingId === undefined && ACTIVE[bb.status] && (bb.players || []).some(function (x) { return x.id === pid; })) bookingId = bb.id;
              });
            }
          }
          if (userId == null) userId = newId('guest');
        }
        const me = { role: role, userId: userId, name: name, createdAt: state.now };
        if (caddieNo) me.caddieNo = caddieNo;
        if (bookingId !== undefined) me.bookingId = bookingId;
        state.me = me;
        store.set('client', me);
        computeFriendIds();
        loadRatings();
        return me;
      }
    };

    // 球童身份:须在球童名录中且已批准(index.html 球童卡片承诺「批准后才能记录事件与评分」)
    function requireActiveCaddie() {
      const me = state.me;
      if (!me || me.role !== 'caddie') return;
      let c = null;
      state.caddies.forEach(function (x) { if (x.id === me.userId) c = x; });
      if (!c || c.status !== 'active') throw fail(40301, '球童尚未获球场批准，暂不能记录事件与评分');
    }
    function afterCourseChange() {
      dirty.course = true;
      mergeDirty = true;
      if (sim) sim = Sim.deserialize(Sim.serialize(sim), { holes: holes(), cfg: cfg() });
    }
    function replaceProposal(next) {
      state.proposals = state.proposals.map(function (p) { return p.id === next.id ? next : p; });
      dirty.proposals = true;
    }
    function transitionProposal(id, action, side) {
      const p = mustProposal(id);
      let next;
      try { next = Merge.transition(p, action, side, state.now); }
      catch (e) { throw fail(40001, '当前状态（' + p.status + '）不能执行 ' + action, { status: p.status }); }
      replaceProposal(next);
      return next;
    }

    // 命令执行:跟随者先刷新再写(force 持久化,领导者下个 tick 通过 seq 发现变化并重载)
    function exec(name, payload) {
      if (!hasOwn(commands, name)) throw fail(40001, '未知命令：' + name);
      if (!state.sheet) throw fail(40001, '数据尚未加载');
      const amLeader = tryLease(false);
      if (!amLeader) refreshFromStorage();
      const result = commands[name](payload || {});
      evaluateAndFinish(true);
      return result;
    }
    function command(name, payload) {
      return new Promise(function (resolve, reject) {
        try { resolve(exec(name, payload)); } catch (e) { reject(e); }
      });
    }

    // ---------- 加载 ----------
    function doLoad(d) {
      if (d) { date = d; }
      state.date = date;
      purgeOldDates();
      const stored = store.get('bookings.' + date);
      if (stored && stored.length) {
        restoreFromStorage();
        if (!state.course || !state.sheet) seedNew(seed);
        if (!sim) sim = Sim.create({ holes: holes(), cfg: cfg(), bookings: state.bookings, seed: seed });
      } else {
        seedNew(seed);
      }
      tryLease(!!opts.leader);
      computeFriendIds();
      loadRatings();
      lastMergeMinute = Math.floor(state.now);
      mergeDirty = true;
      if (leader) evaluateAndFinish(); else { evaluateOnly(); notify(); }
      attachStorageListener();
      if (opts.startClock !== false) start();
      return state;
    }
    function load(d) {
      return new Promise(function (resolve, reject) {
        try { resolve(doLoad(d)); } catch (e) { reject(e); }
      });
    }
    function detachStorageListener() {
      if (storageListener && typeof G.removeEventListener === 'function') G.removeEventListener('storage', storageListener);
      storageListener = null;
    }
    // 释放:停时钟、摘掉 storage 监听、清空订阅(ApiDataSource 重连后调用,避免孤儿 Local 继续驱动页面)
    function dispose() {
      stop();
      detachStorageListener();
      subs.length = 0;
      modeSubs.length = 0;
    }
    function attachStorageListener() {
      if (storageListener || typeof G.addEventListener !== 'function') return;
      storageListener = function (ev) {
        try {
          if (!ev || !ev.key || ev.key.indexOf(PREFIX) !== 0) return;
          if (ev.key === PREFIX + 'simLease' || ev.key === PREFIX + 'client' || ev.key.indexOf(PREFIX + 'ratings.') === 0) return;
          if (isLeader()) return;
          if (ev.key === PREFIX + 'sim.' + date) { refreshFromStorage(); notify(); }
        } catch (e) { /* ignore */ }
      };
      G.addEventListener('storage', storageListener);
    }

    // ---------- 客户端视图 ----------
    function clientSnapshot() {
      return new Promise(function (resolve) {
        const me = state.me || {};
        const live = state.live || evaluateOnly();
        resolve(Live.clientSnapshot(live, state.bookings, holes(), me, state.friendIds, state.now, { caddies: state.caddies }));
      });
    }
    function clientProposals() {
      return new Promise(function (resolve) {
        const me = state.me;
        if (!me || me.bookingId == null) return resolve([]);
        const out = [];
        state.proposals.forEach(function (p) {
          if (p.a !== me.bookingId && p.b !== me.bookingId) return;
          if (p.status === 'suggested' || p.proposedAt == null) return;    // 从未由值班员发出(含建议阶段就过期的):客户不该看到
          if (!IN_FLIGHT[p.status]) {                                        // 已结束的邀请只再显示 30 分钟
            const closedAt = isNum(p.declinedAt) ? p.declinedAt : (isNum(p.withdrawnAt) ? p.withdrawnAt : (isNum(p.appliedAt) ? p.appliedAt : (isNum(p.expiredAt) ? p.expiredAt : (isNum(p.expiresAt) ? p.expiresAt : p.proposedAt))));
            if (isNum(closedAt) && state.now - closedAt > 30) return;
          }
          const v = Live.clientProposalView(p, state.bookings, me, state.friendIds);
          if (v) out.push(v);
        });
        resolve(out);
      });
    }
    function poll(since) {
      return new Promise(function (resolve) {
        const changed = !isNum(since) || since < state.seq;
        resolve({ seq: state.seq, events: changed ? state.events : [], bookings: changed ? state.bookings : [], proposals: changed ? state.proposals : [], serverNow: state.now, alerts: state.alerts });
      });
    }

    // 演示身份(非规范助手):role 'player' → 该组第一位球员;'caddie' → 该组球童,否则 17 号
    function persona(role, bookingId) {
      const b = bookingId ? bookingById(bookingId) : null;
      if (role === 'caddie') {
        let c = null;
        const ids = b ? (b.caddieIds || []) : [];
        state.caddies.forEach(function (x) { if (!c && (ids.indexOf(x.id) >= 0 || (!ids.length && x.no === '17'))) c = x; });
        if (!c) c = state.caddies[0];
        return c ? { role: 'caddie', name: c.name, caddieNo: c.no, bookingId: b ? b.id : undefined, userId: c.id } : null;
      }
      const p = b && b.players && b.players[0];
      return p ? { role: 'player', name: p.name, bookingId: b.id, userId: p.id } : null;
    }

    const demo = {
      get speed() { return demoSpeed; },
      setSpeed: function (x) { const v = Number(x); if (isNum(v) && v > 0) demoSpeed = v; },
      jumpTo: jumpTo,
      reset: reset,
      now: function () { return state.now; },
      tick: tick,
      start: start,
      stop: stop,
      isLeader: isLeader,
      get autoSend() { return demoAutoSend; },
      setAutoSend: function (v) { demoAutoSend = !!v; },
      persona: persona,
      tabId: tabId
    };

    const api = {
      get mode() { return state.mode; },
      get me() { return state.me; },
      getState: function () { return state; },
      subscribe: function (cb) {
        if (typeof cb !== 'function') return function () {};
        subs.push(cb);
        return function () { const i = subs.indexOf(cb); if (i >= 0) subs.splice(i, 1); };
      },
      onModeChange: function (cb) {
        if (typeof cb === 'function') modeSubs.push(cb);
        return function () { const i = modeSubs.indexOf(cb); if (i >= 0) modeSubs.splice(i, 1); };
      },
      load: load,
      command: command,
      poll: poll,
      clientSnapshot: clientSnapshot,
      clientProposals: clientProposals,
      demo: demo,
      dispose: dispose,
      debug: {
        otherPlayerNames: function (me) {
          me = me || state.me || {};
          const out = [];
          state.bookings.forEach(function (b) {
            if (b.id === me.bookingId) return;
            (b.players || []).forEach(function (p) {
              if (!p || state.friendIds.has(p.id) || p.id === me.userId) return;
              out.push(p.name);
            });
          });
          return out;
        },
        exec: exec,
        get storage() { return store.raw._map || store.raw; },
        get lastPersistedSeq() { return lastPersistedSeq; }
      }
    };
    return api;
  }

  // ======================================================================
  // ApiDataSource(§8.4)
  // ======================================================================
  function createApi(opts) {
    opts = opts || {};
    const base = opts.base || '/tee-api/v1';
    const fetchImpl = opts.fetchImpl || (typeof G.fetch === 'function' ? G.fetch.bind(G) : null);
    let tokenStorage = opts.tokenStorage;
    if (!tokenStorage) { try { tokenStorage = G.sessionStorage || null; } catch (e) { tokenStorage = null; } }
    const localOpts = opts.localOpts || {};
    const retryMs = isNum(opts.retryMs) ? opts.retryMs : 60000;
    const clock = typeof opts.wallClock === 'function' ? opts.wallClock : wallClock;

    const state = {
      course: null, sheet: null, bookings: [], events: [], paceStats: {}, observations: [], proposals: [], ratings: [],
      caddies: [], players: {}, friends: {}, me: opts.me || null, friendIds: new Set(),
      alerts: {}, live: null, now: 0, date: opts.date || todayDate(clock), mode: 'api', seq: 0, serverNow: undefined,
      banner: BANNER.api
    };
    let cid = opts.courseId || null;
    let failures = 0;
    let local = null;
    let etag = null;
    let retryTimer = null;
    const subs = [];
    const modeSubs = [];
    let serverAlerts = null;

    function token() {
      try { return tokenStorage ? tokenStorage.getItem(PREFIX + 'token') : null; } catch (e) { return null; }
    }
    function transportError(msg, status) {
      const e = fail(50300, msg || '后端不可达');
      e.transport = true;
      if (status != null) e.status = status;
      return e;
    }
    function request(method, path, body, o) {
      o = o || {};
      if (!fetchImpl) return Promise.reject(transportError('当前环境没有 fetch'));
      const headers = { Accept: 'application/json' };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const tok = token();
      if (tok) headers.Authorization = 'Bearer ' + tok;
      if (method === 'POST' && o.creating) headers['Idempotency-Key'] = uuid();
      if (method === 'PATCH' && o.version != null) headers['If-Match'] = String(o.version);
      if (o.etag) headers['If-None-Match'] = o.etag;
      const init = { method: method, headers: headers, credentials: 'same-origin' };
      if (body !== undefined) init.body = JSON.stringify(body);
      let p;
      try { p = Promise.resolve(fetchImpl(base + path, init)); } catch (e) { p = Promise.reject(e); }
      return p.then(function (res) {
        if (!res) throw transportError('空响应');
        if (res.status === 304) { failures = 0; return { notModified: true }; }
        return Promise.resolve(typeof res.text === 'function' ? res.text() : (typeof res.json === 'function' ? res.json().then(JSON.stringify) : '')).then(function (text) {
          let json = null;
          try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }
          if (!json || typeof json.code !== 'number') {
            if (res.status >= 200 && res.status < 300 && json) { failures = 0; return json; }
            throw transportError('HTTP ' + res.status, res.status);
          }
          if (json.code !== 0) { failures = 0; throw fail(json.code, json.message || ('后端错误 ' + json.code), json.data); }
          failures = 0;
          const out = json.data;
          if (res.headers && typeof res.headers.get === 'function' && o.trackEtag) etag = res.headers.get('ETag') || etag;
          return out;
        });
      }, function (err) {
        throw transportError(err && err.message ? err.message : '网络错误');
      }).catch(function (e) {
        if (e && e.transport) {
          failures++;
          if (failures >= 3) fallbackToLocal();
        }
        throw e;
      });
    }

    function notify() { subs.slice().forEach(function (cb) { try { cb(getState()); } catch (e) { /* ignore */ } }); }
    function notifyMode(mode) { modeSubs.slice().forEach(function (cb) { try { cb(mode, getState()); } catch (e) { /* ignore */ } }); }
    function getState() { return local ? local.getState() : state; }

    function computeFriendIds() {
      const s = new Set();
      const me = state.me;
      if (me && me.userId != null) (state.friends[me.userId] || []).forEach(function (f) { if ((state.friends[f] || []).indexOf(me.userId) >= 0) s.add(f); });
      state.friendIds = s;
    }
    function evaluate() {
      if (!state.course || !state.sheet) return null;
      const ctx = Live.buildCtx(state, state.now, serverAlerts || state.alerts);
      const res = Live.evaluate(ctx);
      if (serverAlerts) {
        // 服务器的告警级别为准;客户端只插值倒计时
        for (const id in serverAlerts) if (hasOwn(serverAlerts, id) && res.byId[id]) {
          res.byId[id].level = serverAlerts[id].level;
          res.byId[id].since = serverAlerts[id].since;
          res.alerts[id] = serverAlerts[id];
        }
      }
      state.live = res;
      state.alerts = res.alerts;
      return res;
    }

    function mergeDelta(data) {
      if (!data) return;
      if (isNum(data.seq)) state.seq = data.seq;
      if (isNum(data.serverNow)) { state.serverNow = data.serverNow; state.now = data.serverNow; }
      if (data.sheet) state.sheet = assign(state.sheet || {}, data.sheet);
      if (Array.isArray(data.bookings)) {
        const byId = {};
        state.bookings.forEach(function (b) { byId[b.id] = b; });
        data.bookings.forEach(function (b) { byId[b.id] = b; });
        state.bookings = Object.keys(byId).map(function (k) { return byId[k]; });
      }
      if (Array.isArray(data.events)) {
        const seen = {};
        state.events.forEach(function (e) { seen[eventKey(e)] = true; });
        data.events.forEach(function (e) { const k = eventKey(e); if (!seen[k]) { seen[k] = true; state.events.push(e); } });
      }
      if (Array.isArray(data.proposals)) {
        const byId = {};
        state.proposals.forEach(function (p) { byId[p.id] = p; });
        data.proposals.forEach(function (p) { byId[p.id] = p; });
        state.proposals = Object.keys(byId).map(function (k) { return byId[k]; });
      }
      if (data.alerts) serverAlerts = data.alerts;
      if (data.paceStats) state.paceStats = data.paceStats;
      if (Array.isArray(data.caddies)) state.caddies = data.caddies;
      if (data.players) state.players = data.players;
      if (data.friends) { state.friends = data.friends; computeFriendIds(); }
      if (Array.isArray(data.ratings)) state.ratings = data.ratings;
    }

    function load(d) {
      if (local) return local.load(d);
      if (d) state.date = d;
      return request('GET', '/me').then(function (me) {
        state.me = assign({}, state.me || {}, me || {});
        if (!cid) cid = me && me.defaultCourseId;
        if (isNum(me && me.serverTime)) { state.serverNow = me.serverTime; state.now = me.serverTime; }
        return request('GET', '/courses/' + cid + '/profile');
      }).then(function (profile) {
        const raw = (profile && profile.course) || profile || {};
        state.course = Course.normalizeCourse(raw, raw.config);
        return request('GET', '/courses/' + cid + '/sheets/' + state.date);
      }).then(function (data) {
        data = data || {};
        state.sheet = data.sheet || { courseId: cid, date: state.date, routingId: 'r18', openMin: 390, closeMin: 960, peakMode: false, fieldHoldMin: 0, seq: 0 };
        state.bookings = []; state.events = []; state.proposals = [];
        mergeDelta(data);
        if (!state.players || !Object.keys(state.players).length) {
          state.bookings.forEach(function (b) { (b.players || []).forEach(function (p) { if (p && p.id != null) state.players[p.id] = p; }); });
        }
        computeFriendIds();
        evaluate();
        state.mode = 'api';
        state.banner = BANNER.api;
        notify();
        return state;
      });
    }

    function poll(since) {
      if (local) return local.poll(since);
      const s = isNum(since) ? since : state.seq;
      return request('GET', '/courses/' + cid + '/sheets/' + state.date + '/live?since=' + encodeURIComponent(s), undefined, { etag: etag, trackEtag: true }).then(function (data) {
        if (data && data.notModified) return { seq: state.seq, events: [], bookings: [], proposals: [], serverNow: state.serverNow, alerts: state.alerts, notModified: true };
        mergeDelta(data);
        evaluate();
        notify();
        return { seq: state.seq, events: (data && data.events) || [], bookings: (data && data.bookings) || [], proposals: (data && data.proposals) || [], serverNow: state.serverNow, alerts: state.alerts };
      });
    }

    function firstHoleNo() {
      const hs = state.course ? Course.holesForRouting(state.course, state.sheet ? state.sheet.routingId : undefined) : [];
      return hs.length ? hs[0].no : 1;
    }
    function bookingVersion(id) {
      for (let i = 0; i < state.bookings.length; i++) if (state.bookings[i].id === id) return state.bookings[i].version;
      return undefined;
    }
    const sheetPath = function () { return '/courses/' + cid + '/sheets/' + state.date; };
    const groupPath = function (id) { return '/courses/' + cid + '/groups/' + encodeURIComponent(id); };
    const clientRole = function () { return state.me && (state.me.role === 'player' || state.me.role === 'caddie'); };

    const routes = {
      createBooking: function (p) { return request('POST', sheetPath() + '/groups', p, { creating: true }); },
      moveBooking: function (p) { return request('PATCH', groupPath(p.id), { teeMin: p.teeMin, force: !!p.force }, { version: bookingVersion(p.id) }); },
      patchBooking: function (p) { return request('PATCH', groupPath(p.id), p.patch, { version: p.version }); },
      checkIn: function (p) { return request('PATCH', groupPath(p.id), { status: 'checkedIn' }, { version: bookingVersion(p.id) }); },
      noShow: function (p) { return request('PATCH', groupPath(p.id), { status: 'noShow' }, { version: bookingVersion(p.id) }); },
      cancel: function (p) { return request('PATCH', groupPath(p.id), { status: 'cancelled' }, { version: bookingVersion(p.id) }); },
      finishManually: function (p) { return request('PATCH', groupPath(p.id), { status: 'finished', finishedManually: true }, { version: bookingVersion(p.id) }); },
      teeOff: function (p) { return request('POST', groupPath(p.id) + '/events', { holeNo: firstHoleNo(), type: 'teeOff', t: p.t, source: 'marshal' }, { creating: true }); },
      setSheet: function (p) { return request('PATCH', sheetPath(), p.patch, { version: state.sheet ? state.sheet.version : undefined }); },
      fieldHold: function (p) { return request('PATCH', sheetPath(), { fieldHoldMin: p.min }, { version: state.sheet ? state.sheet.version : undefined }); },
      postEvent: function (p) {
        const path = clientRole() ? '/groups/' + encodeURIComponent(p.bookingId) + '/events' : groupPath(p.bookingId) + '/events';
        return request('POST', path, { holeNo: p.holeNo, type: p.type, t: p.t, source: p.source, by: p.by }, { creating: true });
      },
      ackAlert: function (p) { return request('POST', '/courses/' + cid + '/alerts/' + encodeURIComponent(p.bookingId) + '/ack', { action: p.action }); },
      playThrough: function (p) { return request('POST', '/groups/' + encodeURIComponent(p.bookingId) + '/play-through', { behindId: p.behindId, decision: p.decision }); },
      proposeMerge: function (p) { return request('POST', '/courses/' + cid + '/merge-proposals', { proposalId: p.proposalId }, { creating: true }); },
      withdrawMerge: function (p) { return request('POST', '/courses/' + cid + '/merge-proposals/' + encodeURIComponent(p.proposalId) + '/cancel'); },
      applyMerge: function (p) { return request('POST', '/courses/' + cid + '/merge-proposals/' + encodeURIComponent(p.proposalId) + '/apply'); },
      respondMerge: function (p) { return request('POST', '/merge-proposals/' + encodeURIComponent(p.proposalId) + '/respond', { side: p.side, decision: p.decision }); },
      adoptCalibration: function (p) { return request('POST', '/courses/' + cid + '/calibration/adopt', { picks: p.picks }); },
      resetCalibration: function () { return request('POST', '/courses/' + cid + '/calibration/adopt', { reset: true }); },
      saveConfig: function (p) { return request('PUT', '/courses/' + cid + '/profile', { config: p.config }); },
      saveHoles: function (p) { return request('PUT', '/courses/' + cid + '/holes', { holes: p.holes }); },
      approveCaddie: function (p) { return request('PATCH', '/courses/' + cid + '/caddies/' + encodeURIComponent(p.id), { status: 'active' }); },
      rate: function (p) { return request('POST', '/ratings', p, { creating: true }); },
      registerClient: function (p) {
        if (p.role === 'caddie') {
          return request('POST', '/caddie/register', { name: p.name, caddieNo: p.caddieNo, bookingId: p.bookingId }, { creating: true }).then(function (me) {
            state.me = assign({ role: 'caddie' }, me || {}, { name: p.name, caddieNo: p.caddieNo });
            if (p.bookingId != null) state.me.bookingId = p.bookingId;
            return state.me;
          });
        }
        return request('GET', '/me/today').then(function (today) {
          state.me = assign({ role: 'player' }, state.me || {}, { name: p.name }, today || {});
          if (p.bookingId != null) state.me.bookingId = p.bookingId;
          return state.me;
        });
      }
    };
    const REFRESH_AFTER = { createBooking: 1, moveBooking: 1, patchBooking: 1, checkIn: 1, noShow: 1, cancel: 1, finishManually: 1, teeOff: 1, setSheet: 1, fieldHold: 1,
      postEvent: 1, ackAlert: 1, playThrough: 1, proposeMerge: 1, withdrawMerge: 1, applyMerge: 1, respondMerge: 1, approveCaddie: 1 };
    const COURSE_RESULT = { adoptCalibration: 1, resetCalibration: 1, saveConfig: 1, saveHoles: 1 };

    function command(name, payload) {
      if (local) return local.command(name, payload);
      if (!hasOwn(routes, name)) return Promise.reject(fail(40001, '未知命令：' + name));
      return routes[name](payload || {}).then(function (result) {
        if (COURSE_RESULT[name] && result) { state.course = Course.normalizeCourse(result, result.config); evaluate(); notify(); }
        else if (REFRESH_AFTER[name]) return poll(state.seq).then(function () { return result; }, function () { return result; });
        return result;
      });
    }
    function clientSnapshot() {
      if (local) return local.clientSnapshot();
      const me = state.me || {};
      if (me.bookingId == null) return Promise.resolve(null);
      return request('GET', '/groups/' + encodeURIComponent(me.bookingId) + '/live');
    }
    function clientProposals() {
      if (local) return local.clientProposals();
      return request('GET', '/merge-proposals').then(function (list) { return Array.isArray(list) ? list : ((list && list.items) || []); });
    }

    // ---------- 回退 / 重试 ----------
    function fallbackToLocal() {
      if (local) return;
      const lo = assign({}, localOpts, { date: state.date, banner: BANNER.fallback, me: state.me && state.me.role === 'operator' ? state.me : (localOpts.me || undefined) });
      local = createLocal(lo);
      state.mode = 'local';
      state.banner = BANNER.fallback;
      local.load(state.date).then(function () {
        subs.forEach(function (cb) { local.subscribe(cb); });
        notifyMode('local');
        notify();
      }, function () { notifyMode('local'); });
      scheduleRetry();
    }
    function scheduleRetry() {
      if (retryTimer != null || typeof G.setTimeout !== 'function') return;
      retryTimer = G.setTimeout(function () {
        retryTimer = null;
        probe().then(function () {
          const prev = local;
          local = null;
          failures = 0;
          return load(state.date).then(function () {
            if (prev && typeof prev.dispose === 'function') prev.dispose();
            else if (prev && prev.demo) prev.demo.stop();
            notifyMode('api');
          }, function () { local = prev; scheduleRetry(); });
        }, function () { scheduleRetry(); });
      }, retryMs);
    }
    function probe() {
      const saved = failures;
      return request('GET', '/me').then(function (me) { return me; }, function (e) { failures = saved; throw e; });
    }

    const api = {
      get mode() { return local ? 'local' : state.mode; },
      get me() { return getState().me; },
      getState: getState,
      subscribe: function (cb) {
        if (typeof cb !== 'function') return function () {};
        subs.push(cb);
        let un = null;
        if (local) un = local.subscribe(cb);
        return function () {
          const i = subs.indexOf(cb); if (i >= 0) subs.splice(i, 1);
          if (un) un();
          if (local) local.subscribe(cb)();                                  // 回退后新建的 Local 也要解除
        };
      },
      onModeChange: function (cb) {
        if (typeof cb === 'function') modeSubs.push(cb);
        return function () { const i = modeSubs.indexOf(cb); if (i >= 0) modeSubs.splice(i, 1); };
      },
      load: load,
      command: command,
      poll: poll,
      clientSnapshot: clientSnapshot,
      clientProposals: clientProposals,
      get demo() { return local ? local.demo : undefined; },
      get debug() { return local ? local.debug : { otherPlayerNames: function () { return []; } }; },
      _request: request,
      _fallback: fallbackToLocal
    };
    return api;
  }

  // ======================================================================
  // Store.auto:探测后端(3 s 超时)→ Api,否则 Local
  // ======================================================================
  function auto(opts) {
    opts = opts || {};
    const base = opts.base || '/tee-api/v1';
    const fetchImpl = opts.fetchImpl || (typeof G.fetch === 'function' ? G.fetch.bind(G) : null);
    const timeoutMs = isNum(opts.timeoutMs) ? opts.timeoutMs : 3000;
    const localOpts = assign({}, opts.localOpts || {}, { date: opts.date });
    ['storage', 'seed', 'startClock', 'tabId', 'me', 'client', 'leader', 'wallClock'].forEach(function (k) { if (hasOwn(opts, k) && !hasOwn(localOpts, k)) localOpts[k] = opts[k]; });

    function useLocal() {
      const l = createLocal(assign({}, localOpts, { banner: BANNER.fallback }));
      return l.load(opts.date).then(function () { return l; });
    }
    if (!fetchImpl) return useLocal();
    const probe = new Promise(function (resolve, reject) {
      let done = false;
      const timer = (typeof G.setTimeout === 'function') ? G.setTimeout(function () { if (!done) { done = true; reject(new Error('timeout')); } }, timeoutMs) : null;
      let p;
      try { p = Promise.resolve(fetchImpl(base + '/me', { method: 'GET', headers: { Accept: 'application/json' }, credentials: 'same-origin' })); }
      catch (e) { p = Promise.reject(e); }
      p.then(function (res) {
        if (!res || !res.ok) throw new Error('HTTP ' + (res ? res.status : 0));
        return res.text();
      }).then(function (text) {
        const json = JSON.parse(text);
        if (!json || json.code !== 0) throw new Error('bad envelope');
        if (!done) { done = true; if (timer != null) G.clearTimeout(timer); resolve(json.data); }
      }).catch(function (e) { if (!done) { done = true; if (timer != null) G.clearTimeout(timer); reject(e); } });
    });
    return probe.then(function () {
      const a = createApi({ base: base, fetchImpl: fetchImpl, tokenStorage: opts.tokenStorage, date: opts.date, localOpts: localOpts, me: opts.me });
      return a.load(opts.date).then(function () { return a; }, function () { return useLocal(); });
    }, function () { return useLocal(); });
  }

  return {
    PREFIX: PREFIX,
    BANNER: BANNER,
    DEMO_START_MIN: DEMO_START_MIN,
    DAY_END_MIN: DAY_END_MIN,
    LEASE_TTL_MS: LEASE_TTL_MS,
    wallClock: wallClock,
    setWallClock: setWallClock,
    todayDate: function () { return todayDate(wallClock); },
    addDays: addDays,
    demoSeed: demoSeed,
    createLocal: createLocal,
    createApi: createApi,
    auto: auto
  };
});
