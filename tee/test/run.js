#!/usr/bin/env node
'use strict';
// 用法: node tee/test/run.js   —— 运行 tee/test/*.test.js + 引擎纯净性 lint,失败则非零退出。
const fs = require('fs');
const path = require('path');
const h = require('./_harness.js');

const TEST_DIR = __dirname;
const JS_DIR = path.join(__dirname, '..', 'js');

// 1) 引擎文件必须是纯函数库:不碰时钟、随机、DOM、网络、存储(sim.js 通过注入的 rng 获得随机性)。
const ENGINE_FILES = ['course.js', 'pace.js', 'learn.js', 'live.js', 'merge.js', 'sim.js'];
const FORBIDDEN = /\b(Date\.now|new Date|Math\.random|document|window|fetch|localStorage|sessionStorage|setTimeout|setInterval|performance)\b/;
let lintErrors = 0;
for (const f of ENGINE_FILES) {
  const p = path.join(JS_DIR, f);
  if (!fs.existsSync(p)) { console.log('lint: missing ' + f); lintErrors++; continue; }
  const src = fs.readFileSync(p, 'utf8');
  // 去掉注释与字符串字面量后再检查,避免误伤文档文字
  const stripped = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:\\])\/\/.*$/gm, '$1')
    .replace(/'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`/g, '""');
  const m = stripped.match(FORBIDDEN);
  if (m) { console.log('lint: ' + f + ' uses forbidden API: ' + m[0]); lintErrors++; }
}

// 2) 运行所有测试文件
const files = fs.readdirSync(TEST_DIR).filter(function (f) { return /\.test\.js$/.test(f); }).sort();
for (const f of files) {
  h.setFile(f);
  try { require(path.join(TEST_DIR, f)); }
  catch (e) { console.log('load error in ' + f + ': ' + (e && e.stack || e)); lintErrors++; }
}

h.runAll().then(function (r) {
  console.log('\n' + r.pass + ' passed, ' + r.fail + ' failed, ' + lintErrors + ' lint/load errors (' + files.length + ' files)');
  process.exit(r.fail || lintErrors ? 1 : 0);
});
