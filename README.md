# HIO Golf 官网

**线上地址：[www.hiogolf.cn](https://www.hiogolf.cn)**（裸域 hiogolf.cn 301 到 www）

「一杆高尔夫」（HIO Golf）是面向国内球友的高尔夫记分与社交产品，由佛山小白球科技有限责任公司开发与运营：

- **iPhone**：一杆高尔夫 App（[App Store](https://apps.apple.com/cn/app/id6789452083)，需 iOS 18.0 或更高）
- **安卓 / 微信**：微信小程序「1杆高尔夫」（阿拉伯数字 1），免下载；用同一手机号登录即为同一账号

主要功能：

- ⛳ **GPS 果岭测距**：果岭前沿 / 中点 / 后缘距离，逐洞卫星洞图
- 📋 **智能记分卡**：杆数、推杆、上球道、GIR 一键录入，完赛自动生成数据总结与分享卡片
- 🏌️ **多人球局**：好友同组记分、成绩实时同步，比杆 / 比洞赛 / 拿骚 / 8421
- 💬 **球友社区**：完赛动态、逐洞成绩、配文与照片，约球与比赛

官网用于介绍产品功能与**球场数据覆盖**：哪些球场支持 GPS 测距、哪些具备逐洞逐 Tee 台的距离数据。全国数百家经人工清洗核实的球场，目录持续扩充；具体数字由接口实时提供，页面上不写死。

## 本仓库

官网本体是**纯静态页面**（零构建链、零外部 CDN，国内加载友好），配套 nginx 站点配置。服务器上的站点根目录就是本仓库的 checkout，所以 nginx 对仓库内部文件一律返回 404（见下文）。

| 文件 | 说明 |
|---|---|
| `index.html` | 首页（内联 CSS/JS），响应式 + 入场动画 |
| `privacy.html` / `privacy-en.html` / `terms.html` | 隐私政策（中 / 英）、用户协议 |
| `meetup.html` / `invite.html` / `event.html` / `round.html` / `caddie.html` | 分享链接落地页（noindex，见「分享落地页与路由」） |
| `img/miniprogram-qr.jpg` | 小程序「1杆高尔夫」正式版小程序码（落地页引用） |
| `.well-known/apple-app-site-association` | iOS Universal Links 声明，与 `api.hiogolf.cn` 上的同名文件内容一致 |
| `robots.txt` / `sitemap.xml` | 搜索引擎：sitemap 只收录首页与协议页；落地页、`/tee/` 等不收录 |
| `tee/` | 球场端 Tee Time 演示（见下节；未上线，不对外宣传，robots 已屏蔽） |
| `docs/tee-time.md` | Tee Time 模块产品/算法/后端接口合同 |
| `nginx/hiogolf-site.conf` | nginx 站点配置：静态服务、落地页路由、仓库文件封禁、裸域 301、数据接口同源反代（`/public-api/`、`/tee-api/`） |

### 实时数据

球场覆盖列表与统计不写死在页面里，而是加载时 fetch `/public-api/v1/public/course-coverage`，由 nginx 同源反代到后端的免登录聚合接口（服务端缓存 10 分钟）。球场目录每次清洗、测绘每次扩展，官网数字自动跟上，无需改版发布。

## 分享落地页与路由

App 与小程序生成的分享链接是 `https://api.hiogolf.cn/{m,i,e,g,c}/...`（小程序复制的邀请链接是 `https://hiogolf.cn/i/{HIO号}`）。装了 App 的 iPhone 点开由系统直接进 App（Universal Links，AASA 同时部署在 `api.`、`www.` 和裸域）；其他情况落到这里的网页。每张落地页都给两条路：

- **iPhone**：「打开 App」（跳 `api.hiogolf.cn` 上的同名链接，已装 App 时唤起）/「去 App Store 下载」
- **安卓或微信**：微信搜索「1杆高尔夫」小程序，或识别小程序码；在微信内打开时小程序卡片排在前面

| 路径 | 页面 | 数据来源（经 `/public-api/v1/public/` 反代） |
|---|---|---|
| `/m/{postId}` | `meetup.html` 约球 | `GET meetups/{postId}` |
| `/i/{HIO号}` | `invite.html` 好友邀请 | `GET invite/{code}`（昵称头像）+ `POST invite/click`（点击指纹，App 归因用） |
| `/e/{eventId}`、`/e/{eventId}/{邀请码}` | `event.html` 比赛 | `GET events/{id}`（只有公开赛；私密赛 / 不存在为 40400，页面显示通用文案和邀请码） |
| `/g/{groupId}/{分享码}` | `round.html` 记分球局 | `GET group-rounds/{id}/preview?code=`（球场、发起人、人数、可选 Tee） |
| `/c/{报到码}` | `caddie.html` 球童报到 | 无公开接口，只做通用引导 |

其他 nginx 规则：

- `hiogolf.cn`（裸域）：只直接提供 `/.well-known/`（Apple 抓 AASA 不跟随重定向），其余 301 到 `https://www.hiogolf.cn$request_uri`；
- `/.well-known/apple-app-site-association` 以 `application/json` 返回；
- 两个 server 块都对 `/.git` 等点文件、`/scripts/`、`/nginx/`、`/docs/`、`/tee/test/`、`/README.md`、`/.gitignore` 返回 404；
- 服务器是 nginx 1.14：保持 1.14 语法（`listen 443 ssl http2`，不要用 `http2 on`）。

## 球场端 Tee Time 管理（`tee/`）

> 内部演示，后端尚未实现，不在官网对外宣传；首页没有入口，robots 已屏蔽。

面向球场运营方的开球时间（tee time）管理与打球节奏（pace of play）监控，同一仓库内的纯静态子应用，**零构建、零 CDN**，
后端未上线时自动进入「演示模式」（本地模拟一整天球场运转），可直接打开体验：

- `tee/index.html` **球场端控制台**：发球表与开球派发（默认 8 分钟间隔，有可靠历史数据的快组 6–7 分钟、置信慢组最多放宽到 10 分钟，派发前校验「不影响后面任何一组」）、
  实时场况与巡查建议（黄点 = 已超时，红点 = 超时 10 分钟以上；会员黑、普通白）、旺季并组建议、球场参数与标准时间校准（3 杆 7 / 4 杆 11 / 5 杆 15 分钟 + 转场时间，可现场调整）。
- `tee/live.html` **客户端原型（球员 / 球童）**：各洞当前球组位置（不显示姓名，好友除外）、本洞剩余时间、红色预警下的「让后组先过」建议、球童与客人互评（仅本人可见）。正式客户端规划在一杆高尔夫 App / 小程序内实现（球童即带球童角色的 HIO 账号，无需单独版本），原型用于演示与验收接口合同。
- 引擎 `tee/js/*.js`：纯函数、可在 Node 中单测（`node tee/test/run.js`），既驱动演示模式，也作为后端 Java 移植的参考实现与黄金用例。
- 后端：规划为 `HIO-backend` 的一个新模块（`/api/v1/tee/**`），网站侧经 nginx 同源反代 `/tee-api/v1/`。详见 [`docs/tee-time.md`](docs/tee-time.md)。

```bash
node tee/test/run.js              # 单元测试 + 引擎纯净性 lint(零依赖)
node tee/test/smoke/smoke.js      # 浏览器冒烟测试(需本机有 playwright 包)
```

## 部署（服务器）

站点目录 `/opt/hio-website` 是本仓库的 checkout。**不要在服务器上直接 `git pull`**：服务器的 origin 是 HTTPS，从这台机器到 GitHub 的 HTTPS 时通时断，挂住时没有任何输出；走 SSH 协议一直可靠。

日常更新（静态文件拉下来即生效）：

```bash
cd /opt/hio-website \
  && timeout 60 git fetch git@github.com:HIOGolfApp/HIOWebAPP.git main \
  && git merge --ff-only FETCH_HEAD \
  && git log --oneline -1          # 确认 HEAD 真的到了新提交(fetch 失败时 merge 会显示 Already up to date)
```

`nginx/hiogolf-site.conf` 有变化时，再复制配置、校验并 reload：

```bash
cp /opt/hio-website/nginx/hiogolf-site.conf /etc/nginx/conf.d/hiogolf-site.conf
nginx -t && systemctl reload nginx
```

上线后用 curl 复验，例如：

```bash
curl -sI https://hiogolf.cn/.well-known/apple-app-site-association      # 200, application/json(无重定向)
curl -sI https://www.hiogolf.cn/.well-known/apple-app-site-association  # 200, application/json
curl -sI https://hiogolf.cn/                                            # 301 -> https://www.hiogolf.cn/
curl -sI https://www.hiogolf.cn/.git/HEAD                               # 404
curl -sI https://www.hiogolf.cn/e/1                                     # 200(event.html)
```

首次部署：

```bash
git clone git@github.com:HIOGolfApp/HIOWebAPP.git /opt/hio-website
cp /opt/hio-website/nginx/hiogolf-site.conf /etc/nginx/conf.d/hiogolf-site.conf
nginx -t && systemctl reload nginx
```

`scripts/deploy.sh`（运维机一键发布）与 `scripts/deploy-site.sh`（服务器端 fetch + ff-only + 配置有变化时 cp / `nginx -t` / reload，失败回滚）也能用，但 `deploy-site.sh` 里的 `git fetch origin main` 走的是服务器上的 HTTPS origin，会撞上面的挂起问题；把服务器 origin 改成 SSH 地址之前，优先用上面的手动命令，也不要挂 cron。

## 相关

- 后端：`HIOGolfApp/HIO-backend`（Spring Boot，提供 `/api/v1/public/*` 免登录数据接口与 `api.hiogolf.cn` 上的分享链接兜底跳转）
- iOS App：`HIOGolfApp/HIO-ios`（SwiftUI）
- 微信小程序：`HIOGolfApp/HIO-miniprogram`

---

© 2026 佛山小白球科技有限责任公司 · 一杆高尔夫 HIO Golf · 粤ICP备2026097752号-1
