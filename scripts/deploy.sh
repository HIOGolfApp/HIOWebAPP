#!/usr/bin/env bash
# 官网静态站:从运维机(有部署密钥的那台电脑)手动触发一次上线,不等 cron。
# 平时不用它:合并到 main、CI 通过后,服务器上的 cron(scripts/deploy-site.sh)2 分钟内自动上线。
# 与后端仓库 HIO-backend/scripts/deploy.sh 用同一台服务器、同一把密钥、同样的环境变量名:
#   DEPLOY_SERVER   默认 root@114.132.175.46
#   DEPLOY_SSH_KEY  默认 ~/.ssh/aigolf_deploy
#
#   bash scripts/deploy.sh          # 预检(本地干净且已推送到 origin/main)-> 服务器立刻跑一轮 deploy-site.sh + 打印 --status
#   bash scripts/deploy.sh --cron   # 在服务器上装 cron(deploy-site.sh --install),以后 main 一合并、CI 通过即自动上线
# 服务器只会上线 deploy/main(CI 通过后由 GitHub Actions 移动),不会上线没过 CI 的 main。
# 前提:服务器上已做过 README「部署」里的一次性设置(否则跑的还是旧版 deploy-site.sh,会撞上 HTTPS 挂起)。
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
echo "main:        $(git log --oneline -1)"
DM=$(git ls-remote origin refs/heads/deploy/main | cut -f1)
if [ "$DM" = "$(git rev-parse HEAD)" ]; then
  echo "deploy/main: 同上(CI 已通过)"
else
  echo "deploy/main: ${DM:0:7}${DM:+ }(CI 还没跑完 / 没通过 / AUTO_DEPLOY=false;服务器只会上线 deploy/main,CI 通过后自动跟上)"
fi

say "2/2 deploy-site.sh on $SERVER"
ssh -i "$SSH_KEY" -o BatchMode=yes "$SERVER" \
  "SITE_LOCK_WAIT=120 bash $REMOTE_DIR/scripts/deploy-site.sh && bash $REMOTE_DIR/scripts/deploy-site.sh --status" < /dev/null

if [ "${1:-}" = "--cron" ]; then
  say "installing cron on $SERVER"
  ssh -i "$SSH_KEY" -o BatchMode=yes "$SERVER" "bash $REMOTE_DIR/scripts/deploy-site.sh --install" < /dev/null
fi
echo "done: https://www.hiogolf.cn/"
