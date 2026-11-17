#!/bin/bash
# nginx 1.14 加载 nginx/hiogolf-site.conf:nginx -t(private.d 不存在 / 为空 / 有文件三种),再起 nginx 用 curl
# 验证落地页路由、AASA、裸域 301、仓库文件 404、/public-api 反代、private.d、429 页面。先跑 sim-setup.sh。
set -euo pipefail
SRC=${SRC:-/src}
SITE=/opt/hio-website
CONF=/etc/nginx/conf.d/hiogolf-site.conf
fails=0
ok()  { echo "  ok   $*"; }
bad() { echo "  FAIL $*"; fails=$((fails + 1)); }

nginx -s stop 2> /dev/null && sleep 1 || true
rm -rf "$SITE" /etc/nginx/private.d
mkdir -p "$SITE"
# 服务器上站点根目录就是 checkout:拷工作区(不含 .git),再 init 一个 .git,好验证 /.git/ 404
# --no-same-owner:CI 里检出目录属 runner 的 uid,解成 root 的,和服务器一样
tar -C "$SRC" --exclude=./.git --exclude=./.claude -cf - . | tar -C "$SITE" --no-same-owner -xf -
git init -q "$SITE"
cp "$SITE/nginx/hiogolf-site.conf" "$CONF"

echo "== nginx -t"
nginx -t -q && ok "private.d missing" || bad "nginx -t, private.d missing"
mkdir -p /etc/nginx/private.d
nginx -t -q && ok "private.d empty" || bad "nginx -t, private.d empty"
echo 'location ^~ /ci-private/ { default_type text/plain; return 200 "private.d ok\n"; }' > /etc/nginx/private.d/ci.conf
nginx -t -q && ok "private.d with a location" || bad "nginx -t, private.d with a location"
mv /etc/nginx/conf.d/aigolf-ratelimit.conf /tmp/zones.conf
if nginx -t -q 2> /dev/null; then bad "nginx -t passes without the hio_ zones (stub not in use?)"; else ok "fails without the hio_ zones (deploy-site.sh skips in that case)"; fi
mv /tmp/zones.conf /etc/nginx/conf.d/aigolf-ratelimit.conf
[ "$fails" = 0 ] || { nginx -t; exit 1; }

nginx
trap 'nginx -s stop 2> /dev/null || true' EXIT
sleep 1

BODY=/tmp/ci-body
# get <scheme> <host> <path> -> "code|content-type|location";body 在 $BODY
get() {
  local port=443; [ "$1" = http ] && port=80
  curl -sk -o "$BODY" -w '%{http_code}|%{content_type}|%{redirect_url}' --resolve "$2:$port:127.0.0.1" "$1://$2$3" || true
}
expect() {   # <scheme> <host> <path> <code> [file 内容要等于 | 301 的跳转地址 | content-type]
  local r code ct loc; r=$(get "$1" "$2" "$3"); IFS='|' read -r code ct loc <<< "$r"
  local what="$1://$2$3 -> $4${5:+ $5}"
  [ "$code" = "$4" ] || { bad "$what (got $code)"; return; }
  case "${5:-}" in
    "") ;;
    /*) cmp -s "$BODY" "$SITE$5" || { bad "$what (body differs)"; return; } ;;
    https://*) [ "$loc" = "$5" ] || { bad "$what (location $loc)"; return; } ;;
    *) [ "${ct%%;*}" = "$5" ] || { bad "$what (content-type $ct)"; return; } ;;
  esac
  ok "$what"
}

W=www.hiogolf.cn; B=hiogolf.cn
ICP=/icp-site/dist/client
echo "== www pages and landing routes"
for p in privacy.html privacy-en.html terms.html robots.txt sitemap.xml favicon.svg img/miniprogram-qr.jpg; do
  expect https $W "/$p" 200 "/$p"
done
expect https $W /m/123 200 /meetup.html
expect https $W /m/123/ 200 /meetup.html
expect https $W /i/HIO1234 200 /invite.html
expect https $W /e/42 200 /event.html
expect https $W /e/42/Ab3x 200 /event.html
expect https $W /g/7/Xy9 200 /round.html
expect https $W /c/K2Z9 200 /caddie.html
expect https $W /m/abc 404
expect https $W /no-such-page 404

echo "== 临时 ICP 站(icp-site):首页 + 静态文件来自 $ICP,/api/ 反代到本机 Node 服务"
expect https $W / 200 "$ICP/index.html"
expect https $W /index.html 301
r=$(curl -sk -D /tmp/ci-hdr -o /dev/null --resolve "$W:443:127.0.0.1" "https://$W/")
grep -qi "^Content-Security-Policy: default-src 'self'" /tmp/ci-hdr && grep -qi '^X-Frame-Options: SAMEORIGIN' /tmp/ci-hdr \
  && ok "/ has CSP + X-Frame-Options" || bad "/ security headers missing: $(tr -d '\r' < /tmp/ci-hdr | grep -iE 'content-security|frame-options')"
JS=$(grep -o '/icp-assets/[^"]*\.js' "$SITE$ICP/index.html" | head -1)
CSS=$(grep -o '/icp-assets/[^"]*\.css' "$SITE$ICP/index.html" | head -1)
[ -n "$JS" ] && [ -n "$CSS" ] || bad "no /icp-assets/ js+css in $ICP/index.html"
for p in "$JS" "$CSS" /images/verified-golf-2026.jpg /images/playful-margin-doodles.svg /images/xbq-favicon.svg /image-sources.html; do
  expect https $W "$p" 200 "$ICP$p"
done
expect https $W /images/no-such.jpg 404
for h in $W $B; do
  for p in /icp-site/ /icp-site/README.md /icp-site/dist/server.mjs /icp-site/src/lib/site-user.ts /icp-site/dist/client/index.html \
           /icp-site/deploy/install.sh /icp-site/package.json; do
    expect https $h "$p" 404
  done
done
expect https $W /api/platform 503 application/json   # 服务没起:nginx 自己回 JSON(前端读 .error)
grep -q '"error":"服务暂时不可用' "$BODY" && ok "  ...with a JSON error the page can show" || bad "/api/ down page: $(head -c 200 "$BODY")"

API_DB=$(mktemp -d)
ICP_DB_PATH=$API_DB/site.db ICP_PAYMENT_QR=$API_DB/none.png /opt/hio-icp-node/bin/node --no-warnings "$SITE/icp-site/dist/server.mjs" > "$API_DB/log" 2>&1 &
API_PID=$!
trap 'kill $API_PID 2> /dev/null; nginx -s stop 2> /dev/null || true' EXIT
for _ in $(seq 1 40); do curl -s -o /dev/null http://127.0.0.1:3100/api/platform && break; sleep 0.25; done
post() {   # post <path> <origin> <json> -> "code";body 在 $BODY,响应头在 /tmp/ci-hdr
  curl -sk -D /tmp/ci-hdr -o "$BODY" -w '%{http_code}' --resolve "$W:443:127.0.0.1" -H 'Content-Type: application/json' \
    ${2:+-H "Origin: $2"} --data "$3" "https://$W$1" || true
}
expect https $W /api/platform 200 application/json
grep -q '"user":null' "$BODY" && ok "  ...served by the Node service" || bad "/api/platform body: $(head -c 200 "$BODY")"
r=$(post /api/account "https://$W" '{"action":"logout"}')
[ "$r" = 200 ] && grep -qi '^Set-Cookie: xbq_session=;.*Secure' /tmp/ci-hdr \
  && ok "same-origin POST through nginx accepted, cookie Secure (Host + X-Forwarded-Proto reach the service)" \
  || bad "same-origin POST via nginx (got $r: $(head -c 200 "$BODY"); $(grep -i set-cookie /tmp/ci-hdr))"
r=$(post /api/account https://evil.example '{"action":"logout"}')
[ "$r" = 403 ] && ok "cross-site POST -> 403" || bad "cross-site POST (got $r)"
r=$(curl -sk -o "$BODY" -w '%{http_code}' --resolve "$W:443:127.0.0.1" -H 'oai-authenticated-user-id: x' \
    -H 'oai-authenticated-user-email: admin@example.com' "https://$W/api/platform?action=admin" || true)
[ "$r" = 403 ] && ok "forged oai-authenticated-user-* headers are not admin" || bad "forged admin headers (got $r)"
r=$(post /api/information "https://$W" "$(head -c 70000 /dev/zero | tr '\0' x)")
[ "$r" = 413 ] && grep -q '"error"' "$BODY" && ok "70 KB body -> 413 JSON" || bad "oversized body (got $r: $(head -c 100 "$BODY"))"
expect https $W /api/member-payment-qr 401 application/json
got429=
for _ in $(seq 1 15); do
  r=$(curl -sk -D /tmp/ci-hdr -o "$BODY" -w '%{http_code}' --resolve "$W:443:127.0.0.1" "https://$W/api/account?action=captcha" || true)
  [ "$r" = 429 ] && { got429=1; break; }
done
if [ -n "$got429" ] && grep -q '"error":"请求过于频繁' "$BODY" && grep -qi '^Retry-After: 10' /tmp/ci-hdr; then
  ok "icp_auth limit on /api/account -> 429 JSON"
else bad "icp_auth 429 (got ${r}: $(head -c 200 "$BODY"))"; fi
expect https $W /api/platform 200 application/json   # 其余接口不受 icp_auth 影响
kill $API_PID 2> /dev/null; wait $API_PID 2> /dev/null
grep -iE 'error|exception' "$API_DB/log" | grep -v 'ExperimentalWarning' && bad "Node service logged errors (above)" || ok "Node service log clean"
rm -rf "$API_DB"

echo "== AASA (Apple fetches it without following redirects: direct 200 + JSON on both hosts)"
for h in $W $B; do
  expect https $h /.well-known/apple-app-site-association 200 application/json
  expect https $h /.well-known/apple-app-site-association 200 /.well-known/apple-app-site-association
done

echo "== bare domain and http"
expect https $B / 301 https://www.hiogolf.cn/
expect https $B '/privacy.html?x=1' 301 'https://www.hiogolf.cn/privacy.html?x=1'
expect https $B /m/123 301 https://www.hiogolf.cn/m/123
expect https $B /img/miniprogram-qr.jpg 200 /img/miniprogram-qr.jpg
expect http $B /terms.html 301 https://www.hiogolf.cn/terms.html
expect http $W /e/1 301 https://www.hiogolf.cn/e/1
expect http $B /.well-known/apple-app-site-association 301 https://hiogolf.cn/.well-known/apple-app-site-association

echo "== repo internals are 404 (the site root is a git checkout)"
for h in $W $B; do
  for p in /.git/HEAD /.git/config /.github/workflows/ci.yml /.github/ci/nginx-test.sh /.gitignore /.claude/x \
           /README.md /scripts/ /scripts/deploy-site.sh /nginx/hiogolf-site.conf /docs/x; do
    expect https $h "$p" 404
  done
done

echo "== /public-api proxy, private.d, 429 page"
r=$(get https $W /public-api/v1/public/course-coverage)
if [ "${r%%|*}" = 200 ] && grep -qx 'upstream /api/v1/public/course-coverage' "$BODY"; then ok "/public-api/v1/public/ -> aigolf_app /api/v1/public/"
else bad "/public-api proxy (got $r: $(head -c 200 "$BODY"))"; fi
expect https $W /public-api/v1/other 404
r=$(get https $W /ci-private/); grep -q 'private.d ok' "$BODY" && ok "include /etc/nginx/private.d/*.conf" || bad "private.d location not served ($r)"
got429=
for _ in $(seq 1 100); do
  r=$(curl -sk -D /tmp/ci-hdr -o "$BODY" -w '%{http_code}' --resolve "$W:443:127.0.0.1" "https://$W/public-api/v1/public/x" || true)
  [ "$r" = 429 ] && { got429=1; break; }
done
if [ -n "$got429" ] && grep -q '"code":42990' "$BODY" && grep -qi '^Retry-After: 10' /tmp/ci-hdr && grep -qi '^Content-Type: application/json' /tmp/ci-hdr; then
  ok "hio_public limit -> 429 JSON (42990, Retry-After)"
else bad "429 page (got ${r}: $(head -c 200 "$BODY"))"; fi
[ "$(curl -sk -H 'Accept-Encoding: gzip' -o /dev/null -w '%{size_download}' --resolve "$W:443:127.0.0.1" "https://$W/privacy.html")" -lt "$(wc -c < "$SITE/privacy.html")" ] \
  && ok "gzip" || bad "privacy.html not gzipped"

rm -rf /etc/nginx/private.d
echo
[ "$fails" = 0 ] && echo "nginx-test: all passed" || { echo "nginx-test: $fails FAILED"; exit 1; }
