#!/usr/bin/env bash
# 官网 + 球场端静态站:从运维机(有部署密钥的那台电脑)一条命令发布到 CVM。
# 与后端仓库 HIO-backend/scripts/deploy.sh 用同一台服务器、同一把密钥、同样的环境变量名:
#   DEPLOY_SERVER   默认 root@114.132.175.46
#   DEPLOY_SSH_KEY  默认 ~/.ssh/aigolf_deploy
#
#   bash scripts/deploy.sh          # 预检(本地干净且已推送到 origin/main) -> 服务器拉取 main + 按需 reload nginx
#   bash scripts/deploy.sh --cron   # 额外在服务器上装一条 cron:以后 main 一合并,两分钟内自动上线
set -euo pipefail
SERVER="${DEPLOY_SERVER:-root@114.132.175.46}"
SSH_KEY="${DEPLOY_SSH_KEY:-$HOME/.ssh/aigolf_deploy}"
REMOTE_DIR="${DEPLOY_REMOTE_DIR:-/opt/hio-website}"

cd "$(dirname "$0")/.."
say() { printf '\n\033[1;36m== %s ==\033[0m\n' "$*"; }
die() { printf '\033[1;31mFAIL\033[0m %s\n' "$*"; exit 1; }

say "1/2 pre-flight"
[ -z "$(git status --porcelain)" ] || die "有未提交的改动,先提交"
git fetch -q origin main
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || die "本地 HEAD 不是 origin/main,先合并并推送到 main"
[ -f "$SSH_KEY" ] || die "找不到部署密钥 $SSH_KEY(设置 DEPLOY_SSH_KEY 指向密钥文件)"
echo "deploying $(git log --oneline -1)"

say "2/2 pull on $SERVER"
ssh -i "$SSH_KEY" -o BatchMode=yes "$SERVER" "bash $REMOTE_DIR/scripts/deploy-site.sh" < /dev/null

if [ "${1:-}" = "--cron" ]; then
  say "installing cron on $SERVER (every 2 min: deploy-site.sh)"
  ssh -i "$SSH_KEY" -o BatchMode=yes "$SERVER" \
    "( crontab -l 2>/dev/null | grep -v deploy-site.sh; echo '*/2 * * * * bash $REMOTE_DIR/scripts/deploy-site.sh >> /var/log/hio-site-deploy.log 2>&1' ) | crontab -" < /dev/null
  echo "cron installed: main 一合并即自动上线"
fi
echo "done: https://www.hiogolf.cn/  ·  https://www.hiogolf.cn/tee/"
