# icp-site:办 ICP 经营许可证期间的临时官网(办完回滚)

代办做的「小白球科技 · 佛山本地服务信息平台」(交接包「佛山小白球-老板部署交接-20261116」,源提交 `91127578`),
改造成能在我们自己的腾讯云服务器上跑的版本。审核期间 **www.hiogolf.cn 首页** 换成它;落地页(`/m/ /i/ /e/ /g/ /c/`)、
AASA(Universal Links)、`privacy.html` / `terms.html`、`/img/`、`/public-api/` 一律不变,App 和小程序不受影响。

## 结构

原版跑在 ChatGPT Sites(Cloudflare Workers + D1),管理员身份靠平台注入的请求头,不能直接搬到普通服务器。改成:

| 部分 | 做法 |
|---|---|
| 前端 | 原版页面组件不改,`web/main.tsx` 挂成静态单页,`vite build` 出 `dist/client/`,nginx 直接提供(`/`、`/icp-assets/`、`/images/`、`/image-sources.html`) |
| 接口 | 原版 `src/app/api/*/route.ts` 基本不改,`build-server.mjs`(esbuild)打成**一个文件** `dist/server.mjs`;`cloudflare:workers` / `next/headers` 换成 `server/shims/*`,D1 换成 Node 内置 `node:sqlite` 上的兼容层(`server/d1.ts`)。运行时**不需要 node_modules**,只要 Node ≥ 22.13 |
| 服务 | systemd 服务 `hio-icp-site`,用户 `hio-icp`,只听 `127.0.0.1:3100`,文件系统隔离 + 资源上限(见下节);nginx 把 `/api/` 反代过来,并限流(`icp_auth` 管登录 / 注册 / 验证码) |
| 数据 | SQLite `/var/lib/hio-icp-site/site.db`(启动时自动跑 `src/drizzle/*.sql` 迁移);会员收款码 `/etc/hio-icp-site/member-payment-qr.png` |

## 对现有系统和数据的影响

- **不碰现有数据**:临时站只调用它自己的 `/api/`,不调用后端接口,代码里没有后端数据库的连接信息;它的数据是单独一个 SQLite 文件。
  App / 小程序用户、球场、成绩等数据和它完全无关。
- **被攻破也碰不到别的**(`deploy/hio-icp-site.service`,已在 systemd 239 = TencentOS 3 同版本上实测):以无登录权限的 `hio-icp`
  用户运行,整个文件系统只读(只能写 `/var/lib/hio-icp-site`);看不见 `/opt` 下的其它服务(后端 `/opt/ai-golf` 及其 `.env`、CRM 等)、
  `/var/lib` 下其它服务的数据、`/var/log`、`/etc/nginx`(证书私钥)、`/root`。实测:不加隔离时这个用户能读到权限宽松的 `.env`
  和证书私钥,加了之后全部读不到。
- **不抢后端资源**:最多半个 CPU、300 MB 内存、64 个线程;接口在 nginx 层按 IP 限流,用的是自己的限流 zone,不影响 App 接口的限流。
- **共用的只有 nginx**:新配置只在 www.hiogolf.cn 里加 location,`api.hiogolf.cn` 的配置文件不动;上线时 `deploy-site.sh` 先
  `nginx -t`,不过就恢复原文件,CI 也在 nginx 1.14 上跑全套路由测试。
- **新增的责任**:网站上注册 / 申请的人留下的邮箱、称呼、手机(会员申请)是新的个人信息,存在服务器 `/var/lib/hio-icp-site/site.db`
  (目录 700),归我们保管;ICP 办完回滚时决定删还是留存。

服务器上没有构建链,所以 `dist/` 随仓库提交;CI 的 `icp-site` job 每次从源码重新构建,和提交的 `dist/` 不一致就失败。

## 相对代办原版的改动

只改了自托管必须改的和安全问题,页面、文案、套餐、12 条信息原样保留。逐行对比:`git diff <导入提交> -- icp-site/src`
(导入提交是「原样导入代办交接包源码」那个)。

1. **管理员身份(严重)**:原版没有本站会话时会读 `oai-authenticated-user-email` 等请求头,和 `ADMIN_EMAIL` 一致就是管理员。
   这些头只有在 Sites 平台后面才可信,部署到我们服务器上任何人都能自己带上:知道或猜中管理员邮箱就直接进后台(看全部申请人姓名 / 手机、开通会员、审核发布信息)。
   改为本站账号上的 `is_admin` 标记(新迁移 `0004_local_admin.sql`),只能在服务器上用命令设置;去掉了 `chatgpt-auth.ts` 和 Sites 登出入口。
2. **反代后 POST 全部 403、Cookie 没有 Secure**:原版用 `new URL(req.url)` 做同源校验和判断 https,反代后那是 `http://127.0.0.1:3100`。
   服务端按 nginx 传来的 `Host` + `X-Forwarded-Proto` 还原公网地址(只听本机,所以这两个头可信)。
3. **收款码不进公开仓库**:原版把微信收款码 Base64 写在源码里;本仓库是公开的,收款码又只给登录用户看,改为读服务器本地文件。
4. 隐私政策「身份与基础设施」一节原来写的是「当前预览由 Sites 托管」,改成实际情况(境内云服务器);删掉「管理员另可使用平台身份」。
5. 小修:登录时清理过期会话;请求体上限 64 KB;nginx 层的 429 / 413 / 502 返回页面能显示的 JSON。

没改、但要知道的:

- **验证码挡不住程序**:四位数字画成 SVG 七段数码,路径固定,程序能 100% 读出(测试里就是这么读的)。真正限制暴力尝试 / 批量注册的是 nginx 限流(每 IP 每分钟约 20 次)。
- 注册不验证邮箱,任何人都能注册后看到收款码(「登录后可见」只是一道手续)。
- 5 张配图是从机构官网下载的,交接说明自己写着「未取得明确开放商用转载许可」;12 家第三方公司的名称电话是公开收录,未签约。`/image-sources.html` 也还自称「所有者私有核对页面」。
- 页面上的联系邮箱、手机是代办在 `src/lib/content.ts` 里填的。

## 上线(第一次)

1. 合并本 PR → CI 通过 → 服务器 2–4 分钟内自动拉取(`scripts/deploy-site.sh`),首页换成临时站,nginx 配置随之更新。
   这时接口服务还没装,页面会提示「服务暂时不可用」,做完第 2 步就好。
2. 把交接包里的收款码 `部署资料/会员微信收款码.png` 传到服务器,root 跑一次安装:

   ```bash
   bash /opt/hio-website/icp-site/deploy/install.sh --qr /root/会员微信收款码.png
   ```

   找 Node ≥ 22.13(系统没有就把官方二进制解到 `/opt/hio-icp-node`,不动系统 node),建用户和目录、装收款码、建库、装并启动 `hio-icp-site`,最后用 curl 验证。可重复执行。
3. (建议)创建后台管理员。不建也能正常浏览、注册、发布,只是没人能审核:用户发的信息一直「待审核」、会员申请没法开通,
   审核人员如果要看「信息发布审核机制」就演示不了。用一个只用于这里的强密码(提示输入;网站「登录 / 注册」用这个邮箱密码登录,
   会员中心出现「进入管理后台」):

   ```bash
   bash /opt/hio-website/icp-site/deploy/icp-admin.sh create-admin 你的邮箱
   ```

   注册不验证邮箱,就算有人抢先用这个邮箱注册过,`create-admin` 也会重设密码并踢掉他的登录。`revoke-admin 邮箱` / `list-admins` 同理。
4. 验收:`bash /opt/hio-website/icp-site/deploy/install.sh --status`;浏览器打开 https://www.hiogolf.cn/ 注册一个号、发一条信息、用管理员审核通过。

以后改代码:改 `src/` 或 `server/` → `npm run build` → 连 `dist/` 一起提交。合并后 `deploy-site.sh` 看到 `dist/server.mjs` 变了会自动重启服务。

## 本地开发

```bash
cd icp-site && npm ci
npm run build && npm test                 # 构建 + 接口端到端测试(临时库,不碰线上)
ICP_DB_PATH=./data/site.db ICP_PAYMENT_QR=./data/qr.png node dist/server.mjs &   # 接口
npx vite                                  # 前端,/api 代理到 3100
```

## 回滚(ICP 办完)

1. GitHub 上 revert 本 PR 并合并:首页回到官网,`icp-site/` 删除,nginx 配置恢复;服务器那一轮 `deploy-site.sh` 看到
   `dist/server.mjs` 没了会自动停止并禁用 `hio-icp-site`。
2. 确认不要数据后在服务器上清理:`rm -rf /var/lib/hio-icp-site /etc/hio-icp-site /opt/hio-icp-node /etc/systemd/system/hio-icp-site.service && systemctl daemon-reload && userdel hio-icp`
   (想留一份注册 / 申请记录就先备份 `site.db`)。
