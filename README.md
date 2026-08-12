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
| `nginx/hiogolf-site.conf` | nginx 站点配置：静态服务 + 数据接口同源反代 |

### 实时数据

球场覆盖列表与统计不写死在页面里，而是加载时 fetch `/public-api/v1/public/course-coverage`，由 nginx 同源反代到后端的免登录聚合接口（服务端缓存 10 分钟）。球场目录每次清洗、测绘每次扩展，官网数字自动跟上，无需改版发布。

## 部署（服务器）

首次：

```bash
git clone https://github.com/HIOGolfApp/HIOWebAPP.git /opt/hio-website
cp /opt/hio-website/nginx/hiogolf-site.conf /etc/nginx/conf.d/hiogolf-site.conf
nginx -t && systemctl reload nginx
```

日常更新（纯静态，push 后在服务器上执行即可，无需 reload）：

```bash
cd /opt/hio-website && git pull
```

改动涉及 `nginx/hiogolf-site.conf` 时需额外重新拷贝配置并 `nginx -t && systemctl reload nginx`。

## 相关

- 后端：`HIOGolfApp/HIO-backend`（Spring Boot，提供 `/api/v1/public/*` 免登录数据接口）
- iOS App：`HIOGolfApp/HIO-ios`（SwiftUI）

---

© 2026 HIO Golf · 粤ICP备2026097752号-1
