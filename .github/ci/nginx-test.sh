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
echo "== www pages and landing routes"
expect https $W / 200 /index.html
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
[ "$(curl -sk -H 'Accept-Encoding: gzip' -o /dev/null -w '%{size_download}' --resolve "$W:443:127.0.0.1" "https://$W/")" -lt "$(wc -c < "$SITE/index.html")" ] \
  && ok "gzip" || bad "index.html not gzipped"

rm -rf /etc/nginx/private.d
echo
[ "$fails" = 0 ] && echo "nginx-test: all passed" || { echo "nginx-test: $fails FAILED"; exit 1; }
