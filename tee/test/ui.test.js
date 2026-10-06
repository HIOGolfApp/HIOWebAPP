'use strict';
// HIOTee.UI 纯函数部分:转义、文案、芯片 / 预警点 / 状态芯片的 markup(含 aria-label 与「无绿色」规则)。Node 下无 DOM。
const { test, assert } = require('./_harness.js');
const UI = require('../js/ui.js');

const GREEN = /green|#0f0\b|#00ff00|rgb\(\s*0\s*,\s*(128|255)/i;

test('ui: 在 Node 中加载且不触碰 DOM,导出完整', () => {
  for (const k of ['esc', 'hm', 'fmtClock', 'fmtLag', 'fmtMinutes', 'fmtRemaining', 'chipPlayer', 'chipGroup', 'statusChip',
    'dot', 'pin', 'qs', 'on', 'setRegion', 'delegate', 'toast', 'confirm']) {
    assert.equal(typeof UI[k], 'function', k);
  }
});

test('ui: esc 转义五个字符且 null 安全', () => {
  assert.equal(UI.esc('<a href="x">张 & \'伟\'</a>'), '&lt;a href=&quot;x&quot;&gt;张 &amp; &#39;伟&#39;&lt;/a&gt;');
  assert.equal(UI.esc(null), '');
  assert.equal(UI.esc(undefined), '');
  assert.equal(UI.esc(12), '12');
});

test('ui: hm / fmtClock 为 HH:MM', () => {
  assert.equal(UI.hm(488), '08:08');
  assert.equal(UI.fmtClock(488.7), '08:08');
  assert.equal(UI.fmtClock(null), '--:--');
});

test('ui: fmtLag', () => {
  assert.equal(UI.fmtLag(12), '超时 12′');
  assert.equal(UI.fmtLag(11.6), '超时 12′');
  assert.equal(UI.fmtLag(0.2), '');
  assert.equal(UI.fmtLag(-3), '');
  assert.equal(UI.fmtLag(null), '');
  assert.equal(UI.fmtLag(NaN), '');
});

test('ui: fmtMinutes / fmtRemaining', () => {
  assert.equal(UI.fmtMinutes(6.2), '约 6 分钟');
  assert.equal(UI.fmtMinutes(0.1), '约 1 分钟');
  assert.equal(UI.fmtMinutes(null), '—');
  assert.equal(UI.fmtRemaining(6.4, 0), '约 6 分钟');
  assert.equal(UI.fmtRemaining(0, 3.2), '已超时 3 分钟');
  assert.equal(UI.fmtRemaining(0, 0.6), '已超时 1 分钟');
  assert.equal(UI.fmtRemaining(0.2, 0), '即将完成');
  assert.equal(UI.fmtRemaining(5, undefined), '约 5 分钟');
  assert.equal(UI.fmtRemaining(null, null), '—');
});

test('ui: chipPlayer 会员黑 / 普通白,姓名转义', () => {
  const m = UI.chipPlayer({ name: '张伟', isMember: true });
  assert.match(m, /^<span class="chip member"/);
  assert.ok(m.indexOf('>张伟<') >= 0);
  const r = UI.chipPlayer({ name: '<b>', isMember: false });
  assert.match(r, /class="chip regular"/);
  assert.ok(r.indexOf('&lt;b&gt;') >= 0 && r.indexOf('<b>') < 0);
  assert.equal(UI.chipPlayer(null), '');
  assert.match(UI.chipPlayer({}), /chip regular/);
});

test('ui: chipGroup 任一会员即黑,文字 N 人(CJK–ASCII 空格)', () => {
  const b = { size: 4, players: [{ isMember: false }, { isMember: true }] };
  const html = UI.chipGroup(b);
  assert.match(html, /class="chip member"/);
  assert.ok(html.indexOf('>4 人<') >= 0);
  assert.match(UI.chipGroup({ size: 2, players: [{}, {}] }), /class="chip regular"[^>]*>2 人</);
  assert.ok(UI.chipGroup({ players: [{}, {}, {}] }).indexOf('>3 人<') >= 0);
  assert.equal(UI.chipGroup(null), '');
});

test('ui: statusChip 七种状态与修饰类', () => {
  const expect = {
    booked: ['已预订', 'chip status"'], checkedIn: ['已签到', 'chip status"'], onCourse: ['场上', 'chip status on-course"'],
    finished: ['已完成', 'chip status done"'], noShow: ['未到', 'chip status bad"'], cancelled: ['已取消', 'chip status done"'],
    merged: ['已合并', 'chip status done"']
  };
  for (const s of Object.keys(expect)) {
    const html = UI.statusChip(s);
    assert.ok(html.indexOf('>' + expect[s][0] + '<') >= 0, s + ' text');
    assert.ok(html.indexOf('class="' + expect[s][1]) >= 0, s + ' class: ' + html);
  }
  assert.equal(UI.statusChip('whatever'), '');
  assert.equal(UI.statusChip(null), '');
});

test('ui: dot 红 / 黄 / 空心 / 无,aria-label 精确', () => {
  assert.equal(UI.dot('red', 'OWN', 12), '<span class="dot red" role="img" aria-label="红：已超时 12 分钟">● 红</span>');
  assert.equal(UI.dot('yellow', 'OWN', 2.4), '<span class="dot yellow" role="img" aria-label="黄：已超时 2 分钟">● 黄</span>');
  assert.equal(UI.dot('red', 'OWN', null), '<span class="dot red" role="img" aria-label="红：已超时">● 红</span>');
  const hollow = UI.dot('green', 'AHEAD', 5);
  assert.match(hollow, /class="dot hollow"/);
  assert.match(hollow, /aria-label="被前组阻挡"/);
  assert.equal(UI.dot('green', 'NONE', 0), '');
  assert.equal(UI.dot(null, null, null), '');
  assert.equal(UI.dot(undefined, undefined), '');
  // 预警级别优先于 cause
  assert.match(UI.dot('yellow', 'AHEAD', 3), /dot yellow/);
});

test('ui: pin 会员 / 我的 / 预警 / 被阻挡', () => {
  const p = UI.pin('red', 'OWN', true, true);
  assert.match(p, /^<span class="pin member mine red" role="img" aria-label="[^"]*会员球组[^"]*我的球组[^"]*红[^"]*"/);
  assert.match(UI.pin('yellow', 'OWN', false, false), /class="pin yellow"[^>]*aria-label="普通球组，黄：已超时"/);
  assert.match(UI.pin('green', 'AHEAD', false, false), /class="pin hollow"[^>]*被前组阻挡/);
  assert.equal(UI.pin('green', 'NONE', false, false).indexOf('class="pin"') > 0, true);
  assert.match(UI.pin(null, null, null, null), /class="pin"/);
});

test('ui: 任何 markup 不含绿色', () => {
  const samples = [
    UI.dot('red', 'OWN', 12), UI.dot('yellow', 'OWN', 1), UI.dot('green', 'AHEAD', 1), UI.dot('green', 'NONE', 0),
    UI.pin('green', 'NONE', true, false), UI.pin('red', 'OWN', false, true),
    UI.chipPlayer({ name: 'a', isMember: true }), UI.chipGroup({ size: 1, players: [] })
  ].concat(['booked', 'checkedIn', 'onCourse', 'finished', 'noShow', 'cancelled', 'merged'].map(UI.statusChip));
  for (const s of samples) assert.ok(!GREEN.test(s), 'green in ' + s);
});

test('ui: DOM 相关函数在 Node 下 null 安全', () => {
  assert.equal(UI.qs('#x'), null);
  assert.equal(UI.setRegion('nope', '<b>x</b>'), false);
  assert.equal(UI.setRegion(null, ''), false);
  assert.equal(typeof UI.on(null, 'click', () => {}), 'function');
  assert.equal(typeof UI.delegate(null, 'click', '.x', () => {}), 'function');
  assert.doesNotThrow(() => UI.toast('hi'));
  assert.equal(UI.confirm('ok?'), false);
  // 伪元素:setRegion 只在变化时写入
  const fake = { innerHTML: '', writes: 0, contains() { return false; } };
  Object.defineProperty(fake, 'innerHTML', { set(v) { this._h = v; this.writes++; }, get() { return this._h; } });
  assert.equal(UI.setRegion(fake, '<i>a</i>'), true);
  assert.equal(UI.setRegion(fake, '<i>a</i>'), false);
  assert.equal(UI.setRegion(fake, '<i>b</i>'), true);
  assert.equal(fake.writes, 2);
});

// 评审修正:焦点在按钮上(键盘 Tab 到 签到 / 催促)不得阻止区域刷新,只有文字输入中才跳过;重绘后焦点按 data-act/data-id 还回
test('ui: setRegion skips only while a text field inside has focus; a focused button is restored after re-render', () => {
  function fakeEl(tag, attrs) {
    const a = Object.assign({}, attrs || {});
    return {
      tagName: tag, focused: 0,
      getAttribute: k => (a[k] == null ? null : a[k]),
      get id() { return a.id || ''; },
      matches: sel => (tag === 'INPUT' && a.type !== 'button' && a.type !== 'checkbox' && /input:not/.test(sel)) || (tag === 'TEXTAREA' && /textarea/.test(sel)) || (tag === 'SELECT' && /select/.test(sel)),
      focus() { this.focused++; }
    };
  }
  const btn = fakeEl('BUTTON', { 'data-act': 'checkIn', 'data-id': 'b0800' });
  const again = fakeEl('BUTTON', { 'data-act': 'checkIn', 'data-id': 'b0800' });
  const region = {
    _h: '', writes: 0, contains: () => true,
    querySelector: sel => (sel === '[data-act="checkIn"][data-id="b0800"]' ? again : null)
  };
  Object.defineProperty(region, 'innerHTML', { set(v) { this._h = v; this.writes++; }, get() { return this._h; } });
  const hadDoc = typeof global.document !== 'undefined';
  const prevDoc = global.document;
  global.document = { activeElement: btn, body: {} };
  try {
    assert.equal(UI.setRegion(region, '<b>1</b>'), true, 'button focus does not block the re-render');
    assert.equal(again.focused, 1, 'focus restored to the matching button');
    global.document.activeElement = fakeEl('INPUT', { type: 'text' });
    assert.equal(UI.setRegion(region, '<b>2</b>'), false, 'typing in a text field blocks the re-render');
    global.document.activeElement = fakeEl('INPUT', { type: 'checkbox' });
    assert.equal(UI.setRegion(region, '<b>3</b>'), true, 'a focused checkbox does not block');
    global.document.activeElement = fakeEl('SELECT', {});
    assert.equal(UI.setRegion(region, '<b>4</b>'), false, 'an open select blocks');
  } finally {
    if (hadDoc) global.document = prevDoc; else delete global.document;
  }
});

test('ui: dot floors the minutes so a yellow dot never reads as 10 分钟, pin red label has no hard-coded minutes', () => {
  assert.match(UI.dot('yellow', 'OWN', 9.96), /已超时 9 分钟/);
  assert.equal(UI.dot('yellow', 'OWN', 0.9), '<span class="dot yellow" role="img" aria-label="黄：已超时">● 黄</span>');
  assert.match(UI.pin('red', 'OWN', false, false), /红：严重超时/);
  assert.ok(!/10 分钟/.test(UI.pin('red', 'OWN', false, false)));
});
