# HIO Golf 官网

`https://hiogolf.cn` / `https://www.hiogolf.cn` 的静态官网。纯静态单页（`index.html`，无构建链），球场覆盖数据通过后端免登录接口实时拉取。

## 架构

- **静态页**：nginx 直接服务本仓库根目录（`/opt/hio-website`）。
- **实时数据**：页面 fetch `/public-api/v1/public/course-coverage`，由 nginx 同源反代到后端
  `127.0.0.1:8080/api/v1/public/course-coverage`（免登录、服务端缓存 10 分钟），无 CORS 问题。
  后端实现见 HIO-backend `PublicSiteController` / `PublicSiteServiceImpl`。
- **证书**：复用 `/etc/nginx/ssl/hiogolf.cn_bundle.crt`（覆盖根域名 + www）。

## 部署（Tencent CVM）

首次：

```bash
git clone git@github.com:HIOGolfApp/HIO-website.git /opt/hio-website
cp /opt/hio-website/nginx/hiogolf-site.conf /etc/nginx/conf.d/hiogolf-site.conf
rm -f /etc/nginx/conf.d/aigolf-root.conf   # 旧的根域名 API 反代，被本站取代
nginx -t && systemctl reload nginx
```

更新（纯静态，改完 push 后在服务器上）：

```bash
cd /opt/hio-website && git pull
```

## 待填占位符（index.html）

- `TESTFLIGHT_URL_PLACEHOLDER` — TestFlight 公开邀请链接
- `ICP_PLACEHOLDER` — ICP 备案号（页脚，法定要求，链接指向 beian.miit.gov.cn）

## 注意

- DNS 需有 `hiogolf.cn` 与 `www.hiogolf.cn` 两条 A 记录指向 CVM。
- App 全部走 `api.hiogolf.cn`，本站接管根域名不影响任何客户端。
