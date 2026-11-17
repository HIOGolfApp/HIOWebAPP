// End-to-end API test for dist/server.mjs: starts the real server on a throwaway database, talks to it the way
// nginx does (Host + X-Forwarded-Proto: https, browser Origin), and writes captcha / quota fixtures straight into
// SQLite. Adapted from the agency's tests/guangdong-icp.mjs, plus checks for the fixes made for self-hosting.
// Usage: node test/api-test.mjs        (needs `npm run build` first; never point it at the production DB)
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const SERVER = fileURLToPath(new URL('../dist/server.mjs', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'icp-test-'));
const env = { ...process.env, ICP_DB_PATH: join(dir, 'site.db'), ICP_PAYMENT_QR: join(dir, 'qr.png'), PORT: String(31000 + Math.floor(Math.random() * 2000)) };
const HOST = 'www.hiogolf.cn', ORIGIN = 'https://' + HOST, base = `http://127.0.0.1:${env.PORT}`;
let passed = 0;
const step = (name) => { passed++; console.log('  ok  ' + name); };

const cli = (args, input) => spawnSync(process.execPath, ['--no-warnings', SERVER, ...args], { env, input, encoding: 'utf8' });
assert.equal(cli(['migrate']).status, 0);
const server = spawn(process.execPath, ['--no-warnings', SERVER], { env, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((ok, fail) => { server.stdout.on('data', (d) => String(d).includes('listening') && ok()); server.on('exit', fail); });
process.on('exit', () => { server.kill(); rmSync(dir, { recursive: true, force: true }); });

const fixture = new DatabaseSync(env.ICP_DB_PATH);
fixture.exec('PRAGMA busy_timeout=5000');
const sha = (s) => createHash('sha256').update(s).digest('hex');
function captcha(scope, expires = Date.now() + 300000) { const id = randomUUID(); fixture.prepare('INSERT INTO captchas(id,digest,expires,scope) VALUES (?,?,?,?)').run(id, sha(id + ':2468'), expires, scope); return id; }
// node:http rather than fetch: fetch will not send a custom Host header, and nginx always does.
function request(method, path, headers = {}, body) {
  return new Promise((ok, fail) => {
    const req = http.request(base + path, { method, headers: { host: HOST, 'x-forwarded-proto': 'https', ...headers } }, (res) => {
      const chunks = []; res.on('data', (d) => chunks.push(d));
      res.on('end', () => ok({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', fail); req.end(body);
  });
}
async function call(path, body = null, cookie = '', extra = {}) {
  const headers = { ...(body ? { 'content-type': 'application/json', origin: ORIGIN } : {}), ...(cookie ? { cookie } : {}), ...extra };
  const r = await request(body ? 'POST' : 'GET', path, headers, body ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined);
  const t = r.body.toString('utf8'); let data; try { data = JSON.parse(t); } catch { data = { error: t }; }
  const setCookie = (r.headers['set-cookie'] || []).join('\n');
  return { status: r.status, data, setCookie, cookie: setCookie ? setCookie.split(';')[0] : undefined };
}
const register = (email, extra = {}) => call('/api/account', { email, password: 'LocalFixture-2468-safe', name: '本地测试用户', consent: true, action: 'register', captchaId: captcha('register'), code: '2468', ...extra });

console.log('accounts and captcha');
const email = 'gd-' + randomUUID() + '@example.test', password = 'LocalFixture-2468-safe';
const bad = captcha('register');
assert.equal((await register(email, { captchaId: bad, code: '0000' })).status, 400);
assert.equal((await register(email, { captchaId: bad })).status, 400); // one-time: the wrong guess burned it
assert.equal((await register(email, { captchaId: captcha('register', Date.now() - 1000) })).status, 400);
assert.equal((await register(email, { captchaId: captcha('login') })).status, 400); // scope
step('captcha: wrong code burns it, expired and wrong-scope rejected');
let r = await register(email);
assert.equal(r.status, 200);
assert.match(r.setCookie, /HttpOnly/); assert.match(r.setCookie, /SameSite=Lax/);
assert.match(r.setCookie, /Secure/, 'behind nginx (X-Forwarded-Proto: https) the session cookie must be Secure');
const cookie = r.cookie;
const account = fixture.prepare('SELECT * FROM accounts WHERE email=?').get(email);
assert.notEqual(account.password, password); assert.ok(account.salt); assert.equal(account.is_admin, 0);
step('register: hashed password, Secure HttpOnly cookie, not admin');
assert.equal((await register(email)).status, 409);
assert.equal((await call('/api/account', { action: 'login', email, password: 'wrong-password-1', captchaId: captcha('login'), code: '2468' })).status, 401);
step('duplicate e-mail 409, wrong password 401');

console.log('origin check (CSRF) behind the proxy');
assert.equal((await call('/api/account', { action: 'logout' }, cookie, { origin: 'https://evil.example' })).status, 403);
assert.equal((await call('/api/account', { action: 'logout' }, cookie, { origin: 'http://' + HOST })).status, 403);
const noOrigin = await request('POST', '/api/platform', { 'content-type': 'application/json', cookie }, '{"action":"apply"}');
assert.equal(noOrigin.status, 403);
step('cross-site / http / missing Origin rejected; same-origin https accepted (all other POSTs)');

console.log('information quota');
let quota = (await call('/api/information', null, cookie)).data.quota;
assert.equal(quota.limit, 2); assert.equal(quota.remaining, 2);
const userId = account.id;
const input = { action: 'submit', title: '广东本地测试体育服务', category: '体育服务', provider: '本地测试主体', contactName: '测试联系人', phone: '13800000000', source: 'https://example.test/contacts', summary: '此为本地夹具资料，不在正式环境发布。', body: '本条仅供本地数据库测试联系人审核、会员发布额度、退回和撤回释放规则，没有真实服务。', consent: true };
assert.equal((await call('/api/information', { ...input, contactName: '' }, cookie)).status, 400);
assert.equal((await call('/api/information', { ...input, source: 'javascript:alert(1)' }, cookie)).status, 400);
assert.equal((await call('/api/information', input, cookie)).status, 200);
assert.equal((await call('/api/information', { ...input, title: input.title + '二' }, cookie)).status, 200);
assert.equal((await call('/api/information', { ...input, title: input.title + '三' }, cookie)).status, 403);
let mine = (await call('/api/information?action=mine', null, cookie)).data;
assert.equal(mine.quota.used, 2); assert.equal(mine.quota.remaining, 0);
assert.ok(!(await call('/api/information')).data.rows.some((x) => x.title.startsWith(input.title)), 'pending items must not be public');
step('free tier: 2 items, third refused, pending not public, javascript: source refused');

console.log('admin');
assert.equal((await call('/api/information', { action: 'review', id: mine.rows[0].id, status: 'published', reason: '用户不能审核', checked: true }, cookie)).status, 403);
const spoof = { 'oai-authenticated-user-id': 'x', 'oai-authenticated-user-email': 'admin@example.com', 'oai-authenticated-user-full-name': 'x', 'oai-authenticated-user-full-name-encoding': 'percent-encoded-utf-8' };
assert.equal((await call('/api/platform?action=admin', null, '', spoof)).status, 403);
assert.equal((await call('/api/platform?action=admin', null, cookie, spoof)).status, 403);
assert.equal((await call('/api/information', { action: 'review', id: mine.rows[0].id, status: 'published', reason: '伪造身份头', checked: true }, '', spoof)).status, 401);
step('forged oai-authenticated-user-* headers give nothing (the original code made this admin)');

// An attacker registers the admin's address first (registration has no e-mail verification)...
const adminEmail = 'admin-' + randomUUID() + '@example.test';
const squatter = (await register(adminEmail)).cookie;
assert.equal((await call('/api/platform?action=admin', null, squatter)).status, 403);
// ...then the operator runs create-admin for that address: password reset, squatter signed out.
const adminPassword = 'Admin-Fixture-9753-safe';
let c = cli(['create-admin', adminEmail], adminPassword + '\n');
assert.equal(c.status, 0, c.stderr);
assert.equal((await call('/api/platform', null, squatter)).data.user, null);
assert.equal((await call('/api/account', { action: 'login', email: adminEmail, password, captchaId: captcha('login'), code: '2468' })).status, 401);
r = await call('/api/account', { action: 'login', email: adminEmail, password: adminPassword, captchaId: captcha('login'), code: '2468' });
assert.equal(r.status, 200);
const admin = r.cookie;
assert.equal((await call('/api/platform', null, admin)).data.admin, true);
assert.equal((await call('/api/platform?action=admin', null, admin)).status, 200);
assert.match(cli(['list-admins']).stdout, new RegExp(adminEmail));
assert.equal(cli(['create-admin', 'not-an-email'], 'x\n').status, 1);
assert.equal(cli(['create-admin', 'short@example.test'], 'short\n').status, 1);
step('create-admin on a pre-registered address resets the password and signs the squatter out');

assert.equal((await call('/api/information', { action: 'review', id: mine.rows[0].id, status: 'rejected', reason: '本地退回，释放额度' }, admin)).status, 200);
assert.equal((await call('/api/information', null, cookie)).data.quota.remaining, 1);
assert.equal((await call('/api/information', { action: 'withdraw', id: mine.rows[1].id }, cookie)).status, 200);
assert.equal((await call('/api/information', null, cookie)).data.quota.remaining, 2);
const concurrent = await Promise.all([1, 2, 3, 4].map((n) => call('/api/information', { ...input, title: input.title + n }, cookie)));
assert.equal(concurrent.filter((x) => x.status === 200).length, 2);
assert.equal(concurrent.filter((x) => x.status === 403).length, 2);
step('reject / withdraw release quota; 4 concurrent submits -> exactly 2 accepted');

console.log('membership');
assert.equal((await call('/api/platform', { action: 'apply', name: '本地测试用户', phone: '13800000000', tier: 'vip', consent: true }, cookie)).status, 200);
assert.equal((await call('/api/platform', { action: 'apply', name: '本地测试用户', phone: '13800000000', tier: 'vip', consent: true }, cookie)).status, 409);
const app = fixture.prepare("SELECT * FROM applications WHERE user_id=? AND status='pending'").get(userId);
assert.equal((await call('/api/information', null, cookie)).data.quota.limit, 2);
assert.equal((await call('/api/platform', { action: 'review', id: app.id, status: 'approved', reason: '用户不能开通', confirmed: true, evidence: '用户自己开通' }, cookie)).status, 403);
assert.equal((await call('/api/platform', { action: 'review', id: app.id, status: 'approved', reason: '无凭证不应开通', confirmed: true }, admin)).status, 400);
assert.equal((await call('/api/platform', { action: 'review', id: app.id, status: 'approved', reason: '仅本地自动验收', confirmed: true, evidence: '本地夹具凭证，不涉及真实收款' }, admin)).status, 200);
assert.equal((await call('/api/information', null, cookie)).data.quota.limit, 50);
function fillTo(limit) {
  const n = fixture.prepare("SELECT COUNT(*) AS n FROM submissions WHERE user_id=? AND status IN ('pending','published')").get(userId).n;
  for (let i = Number(n); i < limit; i++) fixture.prepare("INSERT INTO submissions(id,user_id,email,title,category,provider,contact_name,phone,summary,body,source,status,reason,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?,?,'pending','',?,?)").run(randomUUID(), userId, email, '本地额度夹具' + i, input.category, input.provider, input.contactName, input.phone, input.summary, input.body, input.source, new Date().toISOString(), new Date().toISOString());
}
fillTo(50); assert.equal((await call('/api/information', input, cookie)).status, 403);
fixture.prepare('UPDATE applications SET expires=? WHERE id=?').run(new Date(Date.now() - 1000).toISOString(), app.id);
assert.equal((await call('/api/information', null, cookie)).data.quota.limit, 2);
fixture.prepare("UPDATE applications SET tier='svip',expires=? WHERE id=?").run(new Date(Date.now() + 86400000).toISOString(), app.id);
assert.equal((await call('/api/information', null, cookie)).data.quota.limit, 100);
fillTo(100); assert.equal((await call('/api/information', input, cookie)).status, 403);
step('apply once; only admin + evidence opens VIP 50; expiry -> 2; SVIP 100');

console.log('publishing');
const row = (await call('/api/information?action=mine', null, cookie)).data.rows.find((x) => x.status === 'pending');
fixture.prepare("UPDATE submissions SET contact_name='' WHERE id=?").run(row.id);
assert.equal((await call('/api/information', { action: 'review', id: row.id, status: 'published', reason: '不应公开无姓名资料', checked: true }, admin)).status, 400);
fixture.prepare('UPDATE submissions SET contact_name=? WHERE id=?').run(input.contactName, row.id);
assert.equal((await call('/api/information', { action: 'review', id: row.id, status: 'published', reason: '本地联系人审核夹具', checked: true }, admin)).status, 200);
const pub = (await call('/api/information?action=detail&id=' + row.id)).data;
assert.equal(pub.contactName, input.contactName); assert.equal(pub.phone, input.phone); assert.ok(!('email' in pub) && !('userId' in pub));
const other = (await register('gd-' + randomUUID() + '@example.test')).cookie;
assert.equal((await call('/api/information', { ...input, id: row.id }, other)).status, 403);
assert.equal((await call('/api/information', { action: 'withdraw', id: row.id }, other)).status, 404);
assert.equal((await call('/api/information?action=admin', null, other)).status, 403);
step('publish needs contact name; public row hides submitter e-mail; other users cannot edit / withdraw');

console.log('payment QR, limits, logout');
assert.equal((await call('/api/member-payment-qr')).status, 401);
assert.equal((await call('/api/member-payment-qr', null, cookie)).status, 503); // file not installed yet
writeFileSync(env.ICP_PAYMENT_QR, Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'));
const qr = await request('GET', '/api/member-payment-qr', { cookie });
assert.equal(qr.status, 200); assert.equal(qr.headers['content-type'], 'image/png'); assert.match(qr.headers['cache-control'], /no-store/);
step('QR: anonymous 401, missing file 503, signed in 200 image/png no-store');
assert.equal((await call('/api/information', 'x'.repeat(70 * 1024), cookie)).status, 413);
assert.equal((await call('/api/nope')).status, 404);
assert.equal((await request('DELETE', '/api/platform')).status, 405);
step('oversized body 413, unknown path 404, bad method 405');
r = await call('/api/account', { action: 'logout' }, cookie);
assert.equal(r.status, 200); assert.match(r.setCookie, /Max-Age=0/);
assert.equal((await call('/api/information?action=mine', null, cookie)).status, 401);
assert.equal((await call('/api/account', { action: 'login', email, password, captchaId: captcha('login'), code: '2468' })).status, 200);
fixture.prepare('INSERT INTO sessions(token,user_id,expires) VALUES(?,?,?)').run(sha('stale'), userId, Date.now() - 1);
assert.equal((await call('/api/platform', null, 'xbq_session=stale')).data.user, null);
step('logout kills the session; expired session ignored; login works again');

c = cli(['revoke-admin', adminEmail]);
assert.equal(c.status, 0, c.stderr);
assert.equal((await call('/api/platform', null, admin)).data.user, null);
step('revoke-admin removes rights and signs out');

fixture.close();
console.log(`\napi-test: all ${passed} checks passed`);
process.exit(0);
