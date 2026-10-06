/*
 * HIOTee.UI — 两个页面(index.html 控制台 / live.html 客户端)共用的渲染小工具:
 * HTML 转义、时间/超时文案、芯片(会员黑 / 普通白)、预警点(黄 / 红 / 空心 = 被前组阻挡)、
 * 状态芯片、局部重绘(setRegion)、事件委托(delegate)、toast。
 * 规则:预警状态从不只靠颜色表达(文字 + aria-label);界面无绿色;所有函数对 null 安全。
 * 仅浏览器使用,但 Node 下可 require():加载时不碰 DOM,document 只在函数内部访问。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./course.js'));
  } else {
    root.HIOTee = root.HIOTee || {};
    root.HIOTee.UI = factory(root.HIOTee.Course);
  }
})(typeof self !== 'undefined' ? self : this, function (Course) {
  'use strict';

  // 全局对象:浏览器 self / Node global。加载时只取引用,不访问 document。
  var root = typeof self !== 'undefined' ? self : (typeof global !== 'undefined' ? global : {});
  function doc() { return typeof document !== 'undefined' ? document : null; }

  // ---------- 文本 ----------
  var ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function esc(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, function (ch) { return ESC_MAP[ch]; });
  }

  var hm = Course.fmtHM;
  function fmtClock(min) { return Course.fmtHM(min); }

  // 超时文案:'超时 12′';不足 1 分钟或无效 → ''
  function fmtLag(min) {
    if (min == null || !isFinite(min)) return '';
    var n = Math.round(min);
    if (n <= 0) return '';
    return '超时 ' + n + '′';
  }

  // '约 6 分钟'(四舍五入,至少 1 分钟);无效 → '—'
  function fmtMinutes(min) {
    if (min == null || !isFinite(min)) return '—';
    var n = Math.max(1, Math.round(Math.abs(min)));
    return '约 ' + n + ' 分钟';
  }

  // 本洞剩余 / 已超时:overMin ≥ 0.5 → '已超时 3 分钟',否则 '约 6 分钟';剩余不足半分钟 → '即将完成'
  function fmtRemaining(remainingMin, overMin) {
    if (overMin != null && isFinite(overMin) && overMin >= 0.5) {
      return '已超时 ' + Math.max(1, Math.round(overMin)) + ' 分钟';
    }
    if (remainingMin == null || !isFinite(remainingMin)) return '—';
    if (remainingMin < 0.5) return '即将完成';
    return fmtMinutes(remainingMin);
  }

  // ---------- 芯片 ----------
  function chipPlayer(player) {
    if (!player) return '';
    var cls = player.isMember ? 'member' : 'regular';
    var title = player.isMember ? '会员' : '普通';
    return '<span class="chip ' + cls + '" title="' + title + '">' + esc(player.name || '') + '</span>';
  }

  function chipGroup(booking) {
    if (!booking) return '';
    var players = Array.isArray(booking.players) ? booking.players : [];
    var member = players.some(function (p) { return p && p.isMember; });
    var size = booking.size != null ? booking.size : players.length;
    var label = (member ? '会员球组' : '普通球组') + ' ' + size + ' 人';
    return '<span class="chip ' + (member ? 'member' : 'regular') + '" aria-label="' + label + '">' + size + ' 人</span>';
  }

  var STATUS_TEXT = {
    booked: '已预订', checkedIn: '已签到', onCourse: '场上', finished: '已完成',
    noShow: '未到', cancelled: '已取消', merged: '已合并'
  };
  var STATUS_CLASS = { onCourse: ' on-course', finished: ' done', noShow: ' bad', cancelled: ' done', merged: ' done' };
  function statusChip(status) {
    var text = STATUS_TEXT[status];
    if (!text) return '';
    return '<span class="chip status' + (STATUS_CLASS[status] || '') + '" data-status="' + status + '">' + text + '</span>';
  }

  // ---------- 预警点 ----------
  // 黄 / 红 带文字与 aria-label;cause AHEAD 且未预警 → 空心点「被前组阻挡」;绿且 NONE → ''
  function dot(level, cause, lagMin) {
    // 向下取整:黄点永远不会读作「已超时 10 分钟」(红的阈值)
    var lagText = (lagMin != null && isFinite(lagMin) && lagMin >= 1) ? ' ' + Math.floor(lagMin + 1e-9) + ' 分钟' : '';
    if (level === 'red' || level === 'yellow') {
      var zh = level === 'red' ? '红' : '黄';
      return '<span class="dot ' + level + '" role="img" aria-label="' + zh + '：已超时' + lagText + '">● ' + zh + '</span>';
    }
    if (cause === 'AHEAD') {
      return '<span class="dot hollow" role="img" aria-label="被前组阻挡">○ 被阻</span>';
    }
    return '';
  }

  // 18 洞位置条里的小圆点:会员黑 / 普通白,黄红光环,被阻挡虚线,我的球组加外框
  function pin(level, cause, isMember, isMine) {
    var cls = 'pin';
    var parts = [isMember ? '会员球组' : '普通球组'];
    if (isMember) cls += ' member';
    if (isMine) { cls += ' mine'; parts.push('我的球组'); }
    if (level === 'red') { cls += ' red'; parts.push('红：严重超时'); }     // 红有滞回(≥ redOn 触发、≤ redOff 解除),不写死分钟数
    else if (level === 'yellow') { cls += ' yellow'; parts.push('黄：已超时'); }
    else if (cause === 'AHEAD') { cls += ' hollow'; parts.push('被前组阻挡'); }
    var label = parts.join('，');
    return '<span class="' + cls + '" role="img" aria-label="' + label + '" title="' + label + '"></span>';
  }

  // ---------- DOM ----------
  function qs(sel, scope) {
    var d = doc();
    var base = scope || d;
    if (!sel || !base || typeof base.querySelector !== 'function') return null;
    return base.querySelector(sel);
  }

  function on(el, type, fn) {
    if (!el || !type || typeof fn !== 'function' || typeof el.addEventListener !== 'function') return function () {};
    el.addEventListener(type, fn);
    return function () { el.removeEventListener(type, fn); };
  }

  function resolve(idOrEl) {
    if (!idOrEl) return null;
    if (typeof idOrEl === 'string') { var d = doc(); return d ? d.getElementById(idOrEl) : null; }
    return idOrEl;
  }

  // 局部重绘:内容未变不写 innerHTML。区域内正在输入文字(input/textarea/select/contenteditable)时跳过,避免打断输入;
  // 焦点落在按钮上(键盘 Tab 到 签到 / 催促)不阻止刷新,重绘后按 data-act + data-id(或 id)把焦点还回去。返回是否写入。
  var TEXT_ENTRY = 'input:not([type=button]):not([type=submit]):not([type=checkbox]):not([type=radio]), textarea, select, [contenteditable=""], [contenteditable="true"]';
  function isTextEntry(el) {
    if (!el || typeof el.matches !== 'function') return false;
    try { return el.matches(TEXT_ENTRY); } catch (e) { return false; }
  }
  function focusKey(el) {
    if (!el || !el.getAttribute) return null;
    var act = el.getAttribute('data-act'), id = el.getAttribute('data-id');
    if (act) return '[data-act="' + act + '"]' + (id ? '[data-id="' + id + '"]' : '');
    if (el.id) return '#' + el.id;
    return null;
  }
  function setRegion(idOrEl, html) {
    var el = resolve(idOrEl);
    if (!el) return false;
    var str = html == null ? '' : String(html);
    if (el.__hioHtml === str) return false;
    var d = doc();
    var active = d ? d.activeElement : null;
    var inside = !!(active && active !== el && active !== d.body && typeof el.contains === 'function' && el.contains(active));
    if (inside && isTextEntry(active)) return false;
    var key = inside ? focusKey(active) : null;
    el.innerHTML = str;
    el.__hioHtml = str;
    if (key) {
      try { var again = el.querySelector(key); if (again && typeof again.focus === 'function') again.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
    }
    return true;
  }

  // 事件委托:handler(ev, el, data = el.dataset)。返回解绑函数。
  function delegate(rootEl, eventType, selector, handler) {
    if (!rootEl || !eventType || !selector || typeof handler !== 'function') return function () {};
    function listener(ev) {
      var t = ev.target;
      if (!t) return;
      if (t.nodeType !== 1) t = t.parentElement;
      if (!t || typeof t.closest !== 'function') return;
      var el = t.closest(selector);
      if (!el || !rootEl.contains(el)) return;
      handler(ev, el, el.dataset || {});
    }
    return on(rootEl, eventType, listener);
  }

  // toast:复用单个 .toast 元素
  var toastEl = null, toastTimer = null;
  function toast(msg, ms) {
    var d = doc();
    if (!d || !d.body) return;
    if (!toastEl || !toastEl.parentNode) {
      toastEl = d.createElement('div');
      toastEl.className = 'toast';
      toastEl.setAttribute('role', 'status');
      toastEl.setAttribute('aria-live', 'polite');
      d.body.appendChild(toastEl);
    }
    toastEl.textContent = msg == null ? '' : String(msg);
    // 强制回流后再加 show,保证重复调用也有过渡
    toastEl.classList.remove('show');
    void toastEl.offsetWidth;
    toastEl.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { if (toastEl) toastEl.classList.remove('show'); toastTimer = null; }, ms == null ? 2500 : ms);
  }

  // 确认框:非交互环境(无 confirm)返回 false,避免未经确认执行操作
  function confirm(msg) {
    if (typeof root.confirm !== 'function') return false;
    try { return !!root.confirm(msg == null ? '' : String(msg)); } catch (e) { return false; }
  }

  return {
    esc: esc,
    hm: hm,
    fmtClock: fmtClock,
    fmtLag: fmtLag,
    fmtMinutes: fmtMinutes,
    fmtRemaining: fmtRemaining,
    chipPlayer: chipPlayer,
    chipGroup: chipGroup,
    statusChip: statusChip,
    dot: dot,
    pin: pin,
    qs: qs,
    on: on,
    setRegion: setRegion,
    delegate: delegate,
    toast: toast,
    confirm: confirm
  };
});
