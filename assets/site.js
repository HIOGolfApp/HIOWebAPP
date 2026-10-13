/* 栏目页共用:顶部栏目导航 + 页脚 + 公开接口小工具。
 * 办理 ICP 许可期间的临时栏目;撤回时删掉 assets/ 与各栏目页、还原首页导航即可。 */
(function () {
  var COLS = [
    ['/', '首页', 'home'],
    ['/courses.html', '球场', 'courses'],
    ['/feed.html', '动态', 'feed'],
    ['/events.html', '赛事活动', 'events'],
    ['/about.html', '关于我们', 'about'],
    ['/review.html', '信息发布审核机制', 'review'],
  ];
  var LOGO = '<svg width="15" height="26" viewBox="0 0 31.7613 56" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">'
    + '<ellipse cx="15.8806" cy="51.8209" rx="15.8806" ry="4.1791" fill="#111"/>'
    + '<path d="M11.7 4.83433C11.7 4.64968 11.8497 4.5 12.0343 4.5H19.7657C19.9503 4.5 20.1 4.64968 20.1 4.83433V49H11.7V4.83433Z" fill="#111"/>'
    + '<path d="M16.3758 7.79297C16.207 8.44227 15.9892 9.07951 15.7215 9.69824C15.0113 11.3393 13.9722 12.8179 12.6687 14.042C11.3653 15.266 9.82471 16.2098 8.14238 16.8154C7.50783 17.0439 6.85788 17.2209 6.19902 17.3486L6.31523 15.5127C6.72993 15.4145 7.14013 15.2953 7.54277 15.1504C8.9978 14.6265 10.3305 13.8106 11.4578 12.752C12.585 11.6934 13.4833 10.4152 14.0975 8.99609C14.2674 8.60329 14.4119 8.20075 14.5359 7.79297H16.3758Z" stroke="#CB0018" stroke-width="6.58576"/>'
    + '<circle cx="9.44478" cy="48.4776" r="4.1791" fill="#EAEAEA"/></svg>';

  function navHtml(active) {
    var cols = COLS.map(function (c) {
      return '<a href="' + c[0] + '"' + (c[2] === active ? ' class="on" aria-current="page"' : '') + '>' + c[1] + '</a>';
    }).join('');
    return '<div class="bar">'
      + '<a class="brand" href="/">' + LOGO + '一杆高尔夫</a>'
      + '<div class="cols">' + cols + '</div>'
      + '<div class="acts"><a class="btn btn-secondary" href="/publish.html">发布信息</a>'
      + '<a class="btn btn-primary" href="/#download">下载</a></div>'
      + '</div>';
  }

  function footerHtml() {
    return '<div class="wrap">'
      + '<div>© 2026 佛山小白球科技有限责任公司 · 一杆高尔夫 HIO Golf · <a href="mailto:contact@hiogolf.cn">contact@hiogolf.cn</a></div>'
      + '<div><a href="/about.html">关于我们</a> · <a href="/terms.html">用户协议</a> · <a href="/privacy.html">隐私政策</a> · <a href="/review.html">信息发布审核机制</a></div>'
      + '<div>违法和不良信息举报：<a href="mailto:contact@hiogolf.cn">contact@hiogolf.cn</a> · '
      + '<a href="https://www.12377.cn" target="_blank" rel="noopener">中央网信办违法和不良信息举报中心 12377</a></div>'
      + '<div><a href="https://beian.miit.gov.cn" target="_blank" rel="noopener">粤ICP备2026097752号-1</a></div>'
      + '</div>';
  }

  var nav = document.getElementById('site-nav');
  if (nav) { nav.className = 'site-nav'; nav.innerHTML = navHtml(nav.getAttribute('data-active') || ''); }
  var foot = document.getElementById('site-footer');
  if (foot) { foot.className = 'site-footer'; foot.innerHTML = footerHtml(); }

  // ---------- 小工具(栏目页脚本共用) ----------
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  // 只放行 https 图片地址,其它一律不渲染
  function safeImg(u) { return typeof u === 'string' && /^https:\/\//i.test(u) ? esc(u) : ''; }
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  // 后端时间是北京时间、不带时区的 ISO 串:按字面显示,不做时区换算
  function fmtTime(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(s || '');
    return m ? m[1] + '-' + m[2] + '-' + m[3] + ' ' + m[4] + ':' + m[5] : '';
  }
  function fmtDate(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s || '');
    return m ? m[1] + '年' + Number(m[2]) + '月' + Number(m[3]) + '日' : '';
  }
  function api(path) {
    return fetch('/public-api/v1/public' + path, { headers: { Accept: 'application/json' } })
      .then(function (r) { return r.json(); })
      .then(function (j) { if (!j || j.code !== 0) throw new Error((j && j.message) || '加载失败'); return j.data; });
  }
  window.HIO = { esc: esc, safeImg: safeImg, fmtTime: fmtTime, fmtDate: fmtDate, api: api, pad: pad };
})();
