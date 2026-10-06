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
git checkout -q main
git reset -q --hard origin/main
after=$(git rev-parse HEAD)

if [ "$before" != "$after" ]; then
  echo "[$(date '+%F %T')] site updated: ${before:0:7} -> ${after:0:7}"
  git --no-pager log --oneline "${before}..${after}" | sed 's/^/    /'
fi

# nginx 配置变化才拷贝 + reload(nginx -t 不通过则不动线上配置)
if ! cmp -s "$NGINX_SRC" "$NGINX_DST"; then
  cp "$NGINX_SRC" "$NGINX_DST"
  if nginx -t 2>/dev/null; then
    systemctl reload nginx
    echo "[$(date '+%F %T')] nginx conf updated and reloaded"
  else
    echo "[$(date '+%F %T')] ERROR: nginx -t failed with the new conf, restoring previous" >&2
    git show "${before}:nginx/hiogolf-site.conf" > "$NGINX_DST" 2>/dev/null || true
    nginx -t
    exit 1
  fi
fi

[ "$before" != "$after" ] && echo "online: https://www.hiogolf.cn/  ·  https://www.hiogolf.cn/tee/" || true
