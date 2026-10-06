# HIO Golf 官网

**线上地址：[hiogolf.cn](https://hiogolf.cn)** · [www.hiogolf.cn](https://www.hiogolf.cn)

[HIO Golf](https://apps.apple.com/cn/app/id6789452083) 是一款面向国内球友的智能高尔夫 iOS App：

- ⛳ **GPS 果岭测距** — 实测果岭前沿 / 中点 / 后缘距离，逐洞地图导航
- 📋 **智能记分卡** — 杆数、推杆、上球道、GIR 一键录入，完赛自动生成数据总结与分享卡片
- 🏌️ **多人球局对战** — 好友同组开球、实时排行榜、四人四球比洞赛，单人回合中途也能升级组局
- 💬 **好友动态圈** — 完赛动态、逐洞成绩、配文与照片，只对好友可见

官网用于介绍产品功能与**球场数据覆盖**：哪些球场支持 GPS 测距、哪些具备逐洞逐 Tee 台的真实距离数据。目前已覆盖全国 200+ 家经人工清洗核实的球场，目录持续扩充。

## 本仓库

官网本体：**纯静态单页**（`index.html`，零构建链、零外部 CDN，国内加载友好），配套 nginx 站点配置。

| 文件 | 说明 |
|---|---|
| `index.html` | 全站页面（内联 CSS/JS），响应式 + 入场动画 |
| `meetup.html` / `invite.html` | 约球分享、邀请落地页（`/m/{id}`、`/i/{code}`） |
| `tee/` | **球场端 Tee Time 管理**（见下节）：`index.html` 球场端控制台、`live.html` 客户端原型（正式客户端在 App / 小程序内）、`js/` 零构建引擎与数据层、`test/` 单元测试与冒烟测试 |
| `docs/tee-time.md` | Tee Time 模块产品/算法/后端接口合同/共用后端方案 |
| `nginx/hiogolf-site.conf` | nginx 站点配置：静态服务 + 数据接口同源反代（`/public-api/`、`/tee-api/`） |

### 实时数据

球场覆盖列表与统计不写死在页面里，而是加载时 fetch `/public-api/v1/public/course-coverage`，由 nginx 同源反代到后端的免登录聚合接口（服务端缓存 10 分钟）。球场目录每次清洗、测绘每次扩展，官网数字自动跟上，无需改版发布。

## 球场端 Tee Time 管理（`tee/`）

面向球场运营方的开球时间（tee time）管理与打球节奏（pace of play）监控，同一仓库内的纯静态子应用，**零构建、零 CDN**，
后端未上线时自动进入「演示模式」（本地模拟一整天球场运转），可直接打开体验：

- `tee/index.html` **球场端控制台**：发球表与开球派发（默认 8 分钟间隔，有可靠历史数据的快组 6–7 分钟、置信慢组最多放宽到 10 分钟，派发前校验「不影响后面任何一组」）、
  实时场况与巡查建议（黄点 = 已超时，红点 = 超时 10 分钟以上；会员黑、普通白）、旺季并组建议、球场参数与标准时间校准（3 杆 7 / 4 杆 11 / 5 杆 15 分钟 + 转场时间，可现场调、可按实测建议）。
- `tee/live.html` **客户端原型（球员 / 球童）**：各洞当前球组位置（不显示姓名，好友除外）、本洞剩余时间、红色预警下的「让后组先过」建议、球童与客人互评（仅本人可见）。正式客户端在一杆高尔夫 App / 小程序内实现（球童即带球童角色的 HIO 账号，无需单独版本），原型用于演示与验收接口合同。
- 引擎 `tee/js/*.js`：纯函数、可在 Node 中单测（`node tee/test/run.js`），既驱动演示模式，也作为后端 Java 移植的参考实现与黄金用例。
- 后端：推荐作为 `HIO-backend` 的一个新模块（`/api/v1/tee/**`）共用现有用户、好友、球场、记分卡数据，网站侧经 nginx 同源反代 `/tee-api/v1/`。详见 [`docs/tee-time.md`](docs/tee-time.md)。

```bash
node tee/test/run.js              # 单元测试 + 引擎纯净性 lint(零依赖)
node tee/test/smoke/smoke.js      # 浏览器冒烟测试(需本机有 playwright 包)
```

## 部署（服务器）

首次：

```bash
git clone https://github.com/HIOGolfApp/HIOWebAPP.git /opt/hio-website
cp /opt/hio-website/nginx/hiogolf-site.conf /etc/nginx/conf.d/hiogolf-site.conf
nginx -t && systemctl reload nginx
```

日常更新，两种方式任选：

```bash
# A. 在有部署密钥的电脑上(与后端 HIO-backend/scripts/deploy.sh 同一把密钥 ~/.ssh/aigolf_deploy):
bash scripts/deploy.sh              # 预检已推送到 main -> 服务器拉取 + 按需 reload nginx
bash scripts/deploy.sh --cron       # 同上,并在服务器装 cron,以后 main 一合并自动上线

# B. 直接在服务器上:
bash /opt/hio-website/scripts/deploy-site.sh
```

想让 main 一合并就自动上线，加一条 cron（每 2 分钟检查一次，无变化时什么都不做）：

```bash
echo '*/2 * * * * bash /opt/hio-website/scripts/deploy-site.sh >> /var/log/hio-site-deploy.log 2>&1' | crontab -
```

## 相关

- 后端：`HIOGolfApp/HIO-backend`（Spring Boot，提供 `/api/v1/public/*` 免登录数据接口；Tee Time 模块规划为其中的 `/api/v1/tee/*`）
- iOS App：`HIOGolfApp/HIO-ios`（SwiftUI）

---

© 2026 HIO Golf · 粤ICP备2026097752号-1
