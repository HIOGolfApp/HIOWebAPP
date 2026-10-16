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
| `robots.txt` / `sitemap.xml` | 搜索引擎：sitemap 只收录首页与协议页；落地页等不收录 |
| `nginx/hiogolf-site.conf` | nginx 站点配置：静态服务、落地页路由、仓库文件封禁、裸域 301、数据接口同源反代（`/public-api/`） |
| `scripts/deploy-site.sh` / `scripts/deploy.sh` | 服务器端自动上线（cron）/ 运维机手动触发一轮，见「部署」 |
| `.github/workflows/ci.yml`、`.github/ci/` | CI：nginx 1.14 校验与路由冒烟、deploy-site.sh 场景测试、链接检查；通过后移动 `deploy/main` |

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
- 两个 server 块都对 `/.git` 等点文件、`/scripts/`、`/nginx/`、`/docs/`、`/README.md`、`/.gitignore` 返回 404；
- 服务器是 nginx 1.14：保持 1.14 语法（`listen 443 ssl http2`，不要用 `http2 on`）。

## 部署（服务器）：合并即上线

站点目录 `/opt/hio-website` 是本仓库的 checkout，nginx 的 root 直接指向它。和后端同一套拉取式部署：

1. PR 合并到 `main` → GitHub Actions 跑 CI（`.github/workflows/ci.yml`）：Rocky Linux 8 容器（与线上同版本的 nginx 1.14.1 / git 2.43）里 `nginx -t` 加载站点配置并用 curl 验路由、封禁与限流页面，跑 `scripts/deploy-site.sh` 的场景测试；另查页面链接 / 资源 / 锚点、AASA、sitemap、落地页 noindex，以及 shellcheck；
2. 全部通过 → `mark-deployable` 把分支 `deploy/main` 移到这个提交（只往前移，不 force）；
3. 服务器上 cron 每 2 分钟（偶数分钟的第 30 秒，和后端 `*/2`、CRM 奇数分钟错开）跑 `scripts/deploy-site.sh`：走 SSH 协议、带 timeout 拉 `deploy/main`，把 checkout 快进过去，静态文件即时生效；`nginx/hiogolf-site.conf` 有变化才拷贝 → `nginx -t` → reload，不通过就恢复线上原文件。

合并后约 2–4 分钟上线；没通过 CI 的提交不会上线。GitHub 里不存服务器密钥，也不用从 GitHub 往国内服务器推。

日常（服务器上，root）：

```bash
bash /opt/hio-website/scripts/deploy-site.sh --status          # 线上提交、deploy/main、暂停、nginx 配置、最近日志
tail -50 /var/log/hio-site-deploy.log                          # 每次上线 / 跳过的原因都在这里
bash /opt/hio-website/scripts/deploy-site.sh --pause "原因"    # 暂停；--resume 恢复，下一轮追上 deploy/main
```

- **在 GitHub 上暂停**：仓库 Settings → Secrets and variables → Actions → Variables 加 `AUTO_DEPLOY=false`（CI 照跑，只是不再移 `deploy/main`）。恢复后想立刻上线：Actions 里对 main 手动 Run workflow，或合并下一个 PR。
- **不想等 cron**：运维机上 `bash scripts/deploy.sh`（立刻跑一轮并打印 `--status`；它也只上线 `deploy/main`）。
- **回滚**：在 GitHub 上 revert 那个 PR 并合并（照样过 CI，2–4 分钟）。等不及时在服务器上 `git -C /opt/hio-website checkout -q --detach <好的提交>`：自动上线看到不在 main 上就停手（通知一次），修复上线前 `git -C /opt/hio-website checkout main` 即恢复。detached 不会自动回退 nginx 配置；坏的是 nginx 配置时要手动拷回并 `nginx -t && systemctl reload nginx`。
- **nginx 配置过不了 `nginx -t`**：自动恢复线上原文件并通知，静态文件照常上线；这份配置不再每轮重试，修好合并即可（或 `deploy-site.sh --retry`）。换配置那一下拿着后端的发布锁 `/var/lock/aigolf-deploy.lock`，不会和后端蓝绿切换的 `nginx -t` 撞车。
- **配置引用了新的 `hio_*` 限流 zone**：zone 定义在后端仓库 `nginx/aigolf-ratelimit.conf`，由后端 `scripts/install-nginx-limits.sh` 装。服务器上还没装时自动跳过 nginx、只上静态文件，装好后下一轮自动补上。
- **会停下来等人的情况**（日志里说一次，并通知）：服务器 checkout 有未提交改动、不在 main 上、有不在 GitHub 上的提交（不能快进）。服务器 main 比 `deploy/main` 新（有人手动拉了还没过 CI 的提交）时只是这轮不动，等 `deploy/main` 追上来。
- **通知**：fetch 连续失败约 30 分钟、锁被占约 30 分钟、nginx 配置更新失败、以及上面这些停下来的情况，经后端的 `/opt/ai-golf/scripts/lib-notify.sh` 发（`/opt/ai-golf/.env` 里配邮件或企业微信；没配就只写日志）。成功上线只写日志。
- 状态文件在 `/var/lib/hio-site-deploy/`（不在站点根目录里）。`deploy-site.sh` 本身就在这份 checkout 里，改了它不用另外拷，快进后下一轮就是新版。

### 一次性设置（接上自动上线时做一次）

服务器上原来的 `deploy-site.sh` 是旧版（走 HTTPS 的 origin、没有 timeout，会挂起），所以第一次要手动用 SSH 协议拉到新版：

```bash
# 0. 本仓库接上 CI 的 PR 合并后，等 Actions 里 mark-deployable 变绿（deploy/main 出现）
# 1. 用 SSH 协议把 checkout 快进到 deploy/main，确认 HEAD 真的到了合并提交
cd /opt/hio-website && timeout 60 git fetch git@github.com:HIOGolfApp/HIOWebAPP.git deploy/main && git merge --ff-only FETCH_HEAD && git log --oneline -1
# 2. origin 也改成 SSH：脚本不依赖 origin，但以后有人手动 git fetch / pull 就不会挂起
git -C /opt/hio-website remote set-url origin git@github.com:HIOGolfApp/HIOWebAPP.git
# 3. 手动跑一轮（应该什么都不输出：已是 deploy/main、nginx 配置未变），看状态，再装 cron
bash /opt/hio-website/scripts/deploy-site.sh && bash /opt/hio-website/scripts/deploy-site.sh --status
bash /opt/hio-website/scripts/deploy-site.sh --install
```

上线后用 curl 复验，例如：

```bash
curl -sI https://hiogolf.cn/.well-known/apple-app-site-association      # 200, application/json(无重定向)
curl -sI https://www.hiogolf.cn/.well-known/apple-app-site-association  # 200, application/json
curl -sI https://hiogolf.cn/                                            # 301 -> https://www.hiogolf.cn/
curl -sI https://www.hiogolf.cn/.git/HEAD                               # 404
curl -sI https://www.hiogolf.cn/e/1                                     # 200(event.html)
```

### 手动兜底（GitHub Actions 不可用时）

**不要在服务器上直接 `git pull`**：从这台机器到 GitHub 的 HTTPS 时通时断，挂住时没有任何输出；走 SSH 协议一直可靠。手动拉 `main`（跳过 CI）：

```bash
cd /opt/hio-website \
  && timeout 60 git fetch git@github.com:HIOGolfApp/HIOWebAPP.git main \
  && git merge --ff-only FETCH_HEAD \
  && git log --oneline -1          # 确认 HEAD 真的到了新提交(fetch 失败时 merge 会显示 Already up to date)
```

这之后服务器比 `deploy/main` 新，自动上线这几轮不动，CI 把 `deploy/main` 标到它（或更新的提交）后自动恢复。`nginx/hiogolf-site.conf` 有变化时手动拷贝并校验：

```bash
cp /opt/hio-website/nginx/hiogolf-site.conf /etc/nginx/conf.d/hiogolf-site.conf
nginx -t && systemctl reload nginx
```

全新服务器首次部署：

```bash
git clone git@github.com:HIOGolfApp/HIOWebAPP.git /opt/hio-website
cp /opt/hio-website/nginx/hiogolf-site.conf /etc/nginx/conf.d/hiogolf-site.conf
nginx -t && systemctl reload nginx
bash /opt/hio-website/scripts/deploy-site.sh --install
```

## 相关

- 后端：`HIOGolfApp/HIO-backend`（Spring Boot，提供 `/api/v1/public/*` 免登录数据接口与 `api.hiogolf.cn` 上的分享链接兜底跳转）
- iOS App：`HIOGolfApp/HIO-ios`（SwiftUI）
- 微信小程序：`HIOGolfApp/HIO-miniprogram`

---

© 2026 佛山小白球科技有限责任公司 · 一杆高尔夫 HIO Golf · 粤ICP备2026097752号-1
