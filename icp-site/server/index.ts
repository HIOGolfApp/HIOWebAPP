// Node entry for the temporary ICP site. Bundled by build-server.mjs into dist/server.mjs (single file,
// no node_modules at runtime; needs Node >= 22.13 for node:sqlite).
//
//   node dist/server.mjs                      serve the JSON API on 127.0.0.1:3100 (nginx proxies /api/ here)
//   node dist/server.mjs migrate              create / upgrade the SQLite database and exit
//   node dist/server.mjs create-admin <email> [称呼]
//                                             create an admin account, or turn an existing account into one;
//                                             always sets a new password (asked on the terminal, or the first
//                                             line of stdin) and signs out that account's existing sessions
//   node dist/server.mjs revoke-admin <email> remove admin rights and sign the account out
//   node dist/server.mjs list-admins
//
// Environment: PORT (3100), HOST (127.0.0.1), ICP_DB_PATH (/var/lib/hio-icp-site/site.db),
//              ICP_PAYMENT_QR (/etc/hio-icp-site/member-payment-qr.png)
import http from 'node:http';
import { createInterface } from 'node:readline';
import { requestContext, getD1, closeD1, DB_PATH } from './runtime';
import { passwordHash } from '../src/lib/site-user';
import * as account from '../src/app/api/account/route';
import * as platform from '../src/app/api/platform/route';
import * as information from '../src/app/api/information/route';
import * as memberPaymentQr from '../src/app/api/member-payment-qr/route';

type Handler = (req: Request) => Promise<Response>;
type RouteModule = { GET?: Handler; POST?: Handler };

const ROUTES: Record<string, RouteModule> = {
  '/api/account': account,
  '/api/platform': platform,
  '/api/information': information,
  '/api/member-payment-qr': memberPaymentQr,
};
const MAX_BODY = 64 * 1024; // the largest legitimate request (a 10k-character post) is well below this

function sendJson(res: http.ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extra,
  });
  res.end(JSON.stringify(body));
}

async function readBody(req: http.IncomingMessage): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) return null;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
  const path = (req.url || '/').split('?')[0].replace(/\/+$/, '');
  const route = ROUTES[path];
  if (!route) return sendJson(res, 404, { error: '接口不存在' });
  const method = req.method === 'HEAD' ? 'GET' : req.method || 'GET';
  const fn = method === 'GET' || method === 'POST' ? route[method] : undefined;
  if (!fn) return sendJson(res, 405, { error: '不支持的请求方法' }, { Allow: Object.keys(route).join(', ') });

  let body: Uint8Array<ArrayBuffer> | undefined;
  if (method === 'POST') {
    const b = await readBody(req);
    if (b === null) return sendJson(res, 413, { error: '提交内容过大' });
    body = new Uint8Array(b);
  }

  // Only nginx on this machine can reach us (we listen on 127.0.0.1), so X-Forwarded-Proto is trustworthy.
  // The routes compare the browser's Origin with new URL(req.url).origin and set the cookie's Secure flag
  // from its protocol, so the URL must be the public https://www.hiogolf.cn/... one, not 127.0.0.1:3100.
  const proto = req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
  const host = req.headers.host || 'localhost';
  const headers = new Headers();
  for (let i = 0; i < req.rawHeaders.length; i += 2) headers.append(req.rawHeaders[i], req.rawHeaders[i + 1]);
  const request = new Request(`${proto}://${host}${req.url}`, { method, headers, body });

  const response = await requestContext.run({ headers: request.headers }, () => fn(request));
  const out: Record<string, string | string[]> = { 'X-Content-Type-Options': 'nosniff' };
  response.headers.forEach((value, key) => {
    if (key !== 'set-cookie') out[key] = value;
  });
  const cookies = response.headers.getSetCookie();
  if (cookies.length) out['set-cookie'] = cookies;
  const payload = Buffer.from(await response.arrayBuffer());
  out['content-length'] = String(payload.length);
  res.writeHead(response.status, out);
  res.end(req.method === 'HEAD' ? undefined : payload);
}

function serve() {
  getD1(); // open + migrate before accepting traffic, so a broken database fails the start, not a request
  const port = Number(process.env.PORT || 3100);
  const host = process.env.HOST || '127.0.0.1';
  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      console.error(e);
      if (!res.headersSent) sendJson(res, 500, { error: '服务暂时不可用，请稍后重试' });
      else res.destroy();
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 20_000;
  server.listen(port, host, () => console.log(`hio-icp-site listening on http://${host}:${port} (db ${DB_PATH})`));
  const stop = () => {
    server.close(() => {
      closeD1();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

async function askPassword(): Promise<string> {
  if (!process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin });
    for await (const line of rl) {
      rl.close();
      return line;
    }
    return '';
  }
  const ask = (prompt: string) =>
    new Promise<string>((resolve) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
      // hide what is typed
      (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s: string) => {
        if (s.includes(prompt)) process.stdout.write(prompt);
      };
      rl.question(prompt, (answer) => {
        rl.close();
        process.stdout.write('\n');
        resolve(answer);
      });
    });
  const first = await ask('新密码(10—100 位): ');
  const second = await ask('再输入一次: ');
  if (first !== second) throw new Error('两次输入的密码不一致');
  return first;
}

async function cli(command: string, args: string[]) {
  const { db } = getD1();
  if (command === 'migrate') {
    console.log(`database ready: ${DB_PATH}`);
    return;
  }
  if (command === 'list-admins') {
    const rows = db.prepare('SELECT email, name, created FROM accounts WHERE is_admin = 1 ORDER BY created').all();
    if (!rows.length) console.log('(no admin accounts)');
    for (const r of rows as { email: string; name: string; created: string }[]) console.log(`${r.email}\t${r.name}\t${r.created}`);
    return;
  }
  const email = (args[0] || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error(`用法: node dist/server.mjs ${command} <邮箱>`);
  const existing = db.prepare('SELECT id FROM accounts WHERE email = ?').get(email) as { id: string } | undefined;

  if (command === 'revoke-admin') {
    if (!existing) throw new Error(`没有这个账号: ${email}`);
    db.prepare('UPDATE accounts SET is_admin = 0 WHERE id = ?').run(existing.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(existing.id);
    console.log(`已取消管理员并退出登录: ${email}`);
    return;
  }
  if (command === 'create-admin') {
    const password = await askPassword();
    if (password.length < 10 || password.length > 100) throw new Error('密码需 10—100 位');
    const salt = crypto.randomUUID();
    const hash = await passwordHash(password, salt);
    if (existing) {
      // Registration has no e-mail verification, so whoever registered this address first may not be us:
      // always reset the password and drop every session, never just flip the flag.
      db.prepare('UPDATE accounts SET password = ?, salt = ?, is_admin = 1 WHERE id = ?').run(hash, salt, existing.id);
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(existing.id);
      console.log(`已有账号已设为管理员,密码已重置,原有登录已全部退出: ${email}`);
    } else {
      const name = (args[1] || '管理员').trim().slice(0, 40);
      db.prepare('INSERT INTO accounts (id, email, name, password, salt, created, is_admin) VALUES (?, ?, ?, ?, ?, ?, 1)').run(
        crypto.randomUUID(), email, name, hash, salt, new Date().toISOString(),
      );
      console.log(`已创建管理员账号: ${email}(在网站「登录 / 注册」用这个邮箱和密码登录)`);
    }
    return;
  }
  throw new Error(`unknown command: ${command}`);
}

const [command, ...args] = process.argv.slice(2);
if (!command || command === 'serve') {
  serve();
} else {
  cli(command, args)
    .then(() => closeD1())
    .catch((e) => {
      console.error(`错误: ${(e as Error).message}`);
      closeD1();
      process.exit(1);
    });
}
