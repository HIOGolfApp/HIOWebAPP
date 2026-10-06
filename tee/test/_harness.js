'use strict';
// 极简测试工具:零依赖,node:assert/strict。每个 *.test.js 调用 test(name, fn) 注册用例,run.js 统一执行。
const assert = require('node:assert/strict');

const registry = [];
function test(name, fn) { registry.push({ name, fn, file: currentFile }); }
let currentFile = '';
function setFile(f) { currentFile = f; }

function approx(actual, expected, tol, msg) {
  tol = tol == null ? 1e-6 : tol;
  if (!(Math.abs(actual - expected) <= tol)) {
    assert.fail((msg ? msg + ': ' : '') + 'expected ' + actual + ' ≈ ' + expected + ' (±' + tol + ')');
  }
}

async function runAll() {
  let pass = 0, fail = 0;
  const failures = [];
  for (const t of registry) {
    try {
      await t.fn();
      pass++;
    } catch (e) {
      fail++;
      failures.push({ t, e });
      console.log('  ✗ ' + t.file + ' › ' + t.name);
    }
  }
  for (const f of failures) {
    console.log('\n--- FAIL: ' + f.t.file + ' › ' + f.t.name + '\n' + (f.e && f.e.stack || f.e));
  }
  return { pass, fail };
}

module.exports = { test, assert, approx, runAll, setFile, registry };
