#!/usr/bin/env node
'use strict';
/*
 * 浏览器冒烟测试(不属于 node tee/test/run.js,需要本机有 playwright 包):
 *   node tee/test/smoke/smoke.js
 * 做什么:起一个只读静态服务器(API 路径一律 502,模拟后端未上线),用 Chromium 打开
 *   /tee/index.html 与 /tee/live.html(桌面 1280×860 + 手机 390×844),
 *   任何 console.error / pageerror / 非 API 404 / 横向溢出都算失败,截图到 tee/test/smoke/out/,
 *   并断言演示模式横幅、发球表行数、×60 加速后出现「场上」球组、客户端我的球组卡片与位置条、且不泄露其他球组姓名。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

function loadPlaywright() {
  const candidates = ['playwright', '/opt/node22/lib/node_modules/playwright', '/usr/lib/node_modules/playwright', '/usr/local/lib/node_modules/playwright'];
  for (const c of candidates) { try { return require(c); } catch (e) { /* try next */ } }
  console.error('未找到 playwright 包。安装:npm i -g playwright && npx playwright install chromium');
  process.exit(2);
}
const { chromium } = loadPlaywright();

const ROOT = path.resolve(__dirname, '..', '..', '..');
const OUT = path.join(__dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (/^\/(tee-api|public-api)\//.test(p)) { res.writeHead(502); return res.end('no backend'); }
  if (p.endsWith('/')) p += 'index.html';
  const f = path.join(ROOT, p);
  if (!f.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  fs.readFile(f, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('404'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
    res.end(buf);
  });
});

const failures = [];
function fail(where, msg) { failures.push(where + ': ' + msg); console.log('  ✗ ' + where + ': ' + msg); }
function ok(where, msg) { console.log('  ✓ ' + where + ': ' + msg); }

async function openPage(browser, base, pathname, vp, tag) {
  const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h }, deviceScaleFactor: 1, locale: 'zh-CN' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', m => {
    if (m.type() !== 'error') return;
    const loc = (m.location() && m.location().url) || '';
    if (/\/(tee-api|public-api)\//.test(loc)) return;
    errors.push('[console.error] ' + m.text() + (loc ? ' @' + loc : ''));
  });
  page.on('pageerror', e => errors.push('[pageerror] ' + e.message));
  page.on('response', r => { if (r.status() >= 400 && !/\/(tee-api|public-api)\//.test(r.url())) errors.push('[http ' + r.status() + '] ' + r.url()); });
  await page.goto(base + pathname, { waitUntil: 'load', timeout: 30000 });
  await page.waitForTimeout(1200);
  const shot = async (suffix) => {
    const name = pathname.replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '') + '-' + tag + (suffix ? '-' + suffix : '') + '.png';
    await page.screenshot({ path: path.join(OUT, name), fullPage: true });
  };
  const checkOverflow = async (where) => {
    const sw = await page.evaluate(() => document.documentElement.scrollWidth);
    if (sw > vp.w + 1) fail(where, 'horizontal overflow: scrollWidth ' + sw + ' > viewport ' + vp.w);
  };
  return { ctx, page, errors, shot, checkOverflow };
}

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch();
  const VIEWPORTS = [{ w: 1280, h: 860, tag: 'desktop' }, { w: 390, h: 844, tag: 'mobile' }];

  // ---------- 球场端控制台 ----------
  let firstBookingId = null;
  for (const vp of VIEWPORTS) {
    const where = '/tee/index.html@' + vp.tag;
    const { ctx, page, errors, shot, checkOverflow } = await openPage(browser, base, '/tee/index.html', vp, vp.tag);
    try {
      const banner = await page.locator('[data-testid="mode-banner"]').first();
      const bannerText = (await banner.count()) ? await banner.innerText() : '';
      if (/演示模式/.test(bannerText)) ok(where, 'mode-banner 显示演示模式'); else fail(where, 'mode-banner 未显示演示模式: ' + JSON.stringify(bannerText));
      const rows = await page.locator('[data-testid="sheet-row"]').count();
      if (rows >= 20) ok(where, 'sheet-row 数量 ' + rows); else fail(where, 'sheet-row 数量不足: ' + rows);
      if (!firstBookingId) {
        firstBookingId = await page.locator('[data-testid="sheet-row"]').first().getAttribute('data-id');
      }
      await shot('sheet');
      await checkOverflow(where);
      // ×60 加速,等待 4 秒,应出现「场上」
      const speed = page.locator('[data-testid="demo-speed"]');
      if (await speed.count()) {
        await speed.selectOption('60').catch(() => speed.selectOption({ label: '×60' }));
        await page.waitForTimeout(4200);
        const bodyText = await page.locator('body').innerText();
        if (/场上/.test(bodyText)) ok(where, '×60 后出现场上球组'); else fail(where, '×60 后没有出现「场上」');
      } else fail(where, '缺少 demo-speed 选择器');
      // 实时场况页签
      const tabLive = page.locator('[data-testid="tab-live"]');
      if (await tabLive.count()) {
        await tabLive.click(); await page.waitForTimeout(600);
        if (await page.locator('[data-testid="marshal-list"]').count()) ok(where, '实时场况/巡查建议可见'); else fail(where, '缺少 marshal-list');
        await shot('live');
        await checkOverflow(where + '/live');
      } else fail(where, '缺少 tab-live');
      for (const t of ['tab-merge', 'tab-params']) {
        const tab = page.locator('[data-testid="' + t + '"]');
        if (await tab.count()) { await tab.click(); await page.waitForTimeout(400); await shot(t); await checkOverflow(where + '/' + t); }
        else fail(where, '缺少 ' + t);
      }
      const nb = page.locator('[data-testid="btn-new-booking"]');
      if (await nb.count()) ok(where, 'btn-new-booking 存在'); else fail(where, '缺少 btn-new-booking');
    } catch (e) { fail(where, e.message); }
    if (errors.length) fail(where, '\n    ' + errors.join('\n    ')); else ok(where, '无控制台报错');
    await ctx.close();
  }

  // ---------- 客户端 ----------
  for (const vp of VIEWPORTS) {
    const q = '/tee/live.html?role=player' + (firstBookingId ? '&group=' + encodeURIComponent(firstBookingId) : '');
    const where = '/tee/live.html@' + vp.tag;
    const { ctx, page, errors, shot, checkOverflow } = await openPage(browser, base, q, vp, vp.tag);
    try {
      const card = page.locator('[data-testid="my-group-card"]');
      if (await card.count()) ok(where, 'my-group-card 可见'); else fail(where, '缺少 my-group-card');
      if (await page.locator('[data-testid="position-strip"]').count()) ok(where, 'position-strip 可见'); else fail(where, '缺少 position-strip');
      // 隐私:页面上不应出现其它球组的球员姓名(由页面以 data-privacy-check 暴露一个 JSON:{ otherNames: [...] })
      const leak = await page.evaluate(() => {
        const el = document.querySelector('[data-privacy-check]');
        if (!el) return null;
        try { return JSON.parse(el.getAttribute('data-privacy-check')); } catch (e) { return null; }
      });
      if (leak && Array.isArray(leak.otherNames)) {
        const text = await page.locator('body').innerText();
        const leaked = leak.otherNames.filter(n => n && text.indexOf(n) >= 0);
        if (leaked.length) fail(where, '泄露其他球组姓名: ' + leaked.join(', ')); else ok(where, '其他球组姓名未泄露(检查 ' + leak.otherNames.length + ' 个)');
      } else ok(where, '(页面未提供 data-privacy-check,跳过姓名泄露检查)');
      await shot();
      await checkOverflow(where);
    } catch (e) { fail(where, e.message); }
    if (errors.length) fail(where, '\n    ' + errors.join('\n    ')); else ok(where, '无控制台报错');
    await ctx.close();
  }

  await browser.close();
  server.close();
  console.log('\n' + (failures.length ? failures.length + ' 项失败' : '冒烟测试全部通过') + ',截图在 ' + path.relative(ROOT, OUT) + '/');
  process.exit(failures.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
