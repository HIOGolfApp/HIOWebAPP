#!/usr/bin/env bash
# 官网 + 球场端 Tee Time 静态站部署脚本:在 CVM 上执行(与后端 deploy-server.sh 同一台机器)。
#   首次:  git clone https://github.com/HIOGolfApp/HIOWebAPP.git /opt/hio-website
#   之后:  bash /opt/hio-website/scripts/deploy-site.sh
# 做三件事:git pull main;nginx 站点配置有变化时拷贝并 reload;打印线上地址。幂等,可重复执行。
# 可选:让 main 一合并就自动上线 —— crontab -e 加一行(每 2 分钟拉一次,无变化时什么都不做):
#   */2 * * * * bash /opt/hio-website/scripts/deploy-site.sh >> /var/log/hio-site-deploy.log 2>&1
set -euo pipefail
SITE_DIR="${SITE_DIR:-/opt/hio-website}"
NGINX_SRC="$SITE_DIR/nginx/hiogolf-site.conf"
NGINX_DST="${NGINX_DST:-/etc/nginx/conf.d/hiogolf-site.conf}"

cd "$SITE_DIR"
before=$(git rev-parse HEAD)
git fetch -q origin main
# 只做快进:服务器上若有未提交的本地改动或分叉,这里会报错停下,由人来决定,绝不悄悄覆盖
git checkout -q main
git merge -q --ff-only origin/main
after=$(git rev-parse HEAD)

if [ "$before" != "$after" ]; then
  echo "[$(date '+%F %T')] site updated: ${before:0:7} -> ${after:0:7}"
  git --no-pager log --oneline "${before}..${after}" | sed 's/^/    /'
fi

# nginx 配置变化才拷贝 + reload(nginx -t 不通过则恢复线上原文件)
# 恢复用拷贝前的线上快照,不用 git show ${before}:重跑时 before 已经是新提交,会把坏配置写回去。
RATELIMIT_ZONES=/etc/nginx/conf.d/aigolf-ratelimit.conf
if ! cmp -s "$NGINX_SRC" "$NGINX_DST"; then
  if grep -q 'zone=hio_' "$NGINX_SRC" && [ ! -f "$RATELIMIT_ZONES" ]; then
    # 站点配置引用了按 IP 限流的 zone,但 zone 文件(后端仓库 scripts/install-nginx-limits.sh 装)还没装:
    # 这次先不动 nginx,静态文件照常上线;装好 zone 后重跑本脚本即可
    echo "[$(date '+%F %T')] WARN: $NGINX_SRC uses hio_ rate-limit zones but $RATELIMIT_ZONES is missing;" \
         "nginx conf NOT updated. Run the backend's scripts/install-nginx-limits.sh, then rerun this script." >&2
  else
    prev=$(mktemp)
    had_prev=0
    if [ -f "$NGINX_DST" ]; then cp -p "$NGINX_DST" "$prev"; had_prev=1; fi
    cp "$NGINX_SRC" "$NGINX_DST"
    if nginx -t; then
      systemctl reload nginx
      echo "[$(date '+%F %T')] nginx conf updated and reloaded"
      rm -f "$prev"
    else
      echo "[$(date '+%F %T')] ERROR: nginx -t failed with the new conf, restoring the live copy" >&2
      if [ "$had_prev" = 1 ]; then cp -p "$prev" "$NGINX_DST"; else rm -f "$NGINX_DST"; fi
      rm -f "$prev"
      nginx -t || true
      exit 1
    fi
  fi
fi

[ "$before" != "$after" ] && echo "online: https://www.hiogolf.cn/  ·  https://www.hiogolf.cn/tee/" || true
