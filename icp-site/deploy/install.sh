#!/bin/bash
# 临时 ICP 站(icp-site)在服务器上的一次性安装 / 更新。root 跑,幂等,可以重复执行。
#
#   bash /opt/hio-website/icp-site/deploy/install.sh --qr /root/会员微信收款码.png   # 第一次:装好并启动
#   bash /opt/hio-website/icp-site/deploy/install.sh                                # 以后:重装服务 / 重启
#   bash /opt/hio-website/icp-site/deploy/install.sh --status
#   bash /opt/hio-website/icp-site/deploy/install.sh --uninstall   # ICP 办完回滚后:停服务、删 unit(数据保留)
#   bash /opt/hio-website/icp-site/deploy/install.sh --node-only   # 只准备 Node(CI 用)
#
# 做的事:
#   1. 找一个 >= 22.13 的 node(要内置的 node:sqlite)。系统里有就用;没有就把官方二进制解到 /opt/hio-icp-node,
#      不动系统的 node / dnf 模块(服务器上别的服务可能在用系统 node)。先试国内镜像 npmmirror,再试 nodejs.org,
#      都按 SHASUMS256.txt 校验。
#   2. 建系统用户 hio-icp;数据目录 /var/lib/hio-icp-site(700,SQLite 库 site.db 在这里);配置目录 /etc/hio-icp-site。
#   3. --qr <png>:把会员微信收款码装到 /etc/hio-icp-site/member-payment-qr.png(收款码不进公开仓库)。
#   4. 建库 / 跑迁移,装 systemd 服务 hio-icp-site(只听 127.0.0.1:3100,nginx 把 /api/ 反代过来)并(重)启动,
#      然后用 curl 验一下。
# 装完创建管理员(网站后台用这个邮箱 + 密码登录):
#   bash /opt/hio-website/icp-site/deploy/icp-admin.sh create-admin 你的邮箱
# 以后代码更新不用再跑本脚本:合并后 scripts/deploy-site.sh 看到 dist/server.mjs 变了会自动重启服务。
set -euo pipefail
umask 022

SITE_DIR=${SITE_DIR:-/opt/hio-website}
APP=$SITE_DIR/icp-site
UNIT=hio-icp-site
USER_NAME=hio-icp
DATA_DIR=/var/lib/hio-icp-site
CONF_DIR=/etc/hio-icp-site
QR_DST=$CONF_DIR/member-payment-qr.png
NODE_DIR=${ICP_NODE_DIR:-/opt/hio-icp-node}
NODE_VERSION=22.23.4   # 只在系统没有合适的 node 时下载这个版本
PORT=3100

say()  { printf '\n\033[1;36m== %s ==\033[0m\n' "$*"; }
die()  { printf '\033[1;31mFAIL\033[0m %s\n' "$*" >&2; exit 1; }

node_ok() {   # $1 = node 可执行文件:>= 22.13 且 node:sqlite 能用
  [ -x "$1" ] || return 1
  "$1" --no-warnings -e '
    const [a, b] = process.versions.node.split(".").map(Number);
    if (!(a > 22 || (a === 22 && b >= 13))) process.exit(1);
    require("node:sqlite");' 2> /dev/null
}

find_node() {
  local c
  for c in "$NODE_DIR/bin/node" "$(command -v node 2> /dev/null || true)"; do
    [ -n "$c" ] && node_ok "$c" && { echo "$c"; return 0; }
  done
  return 1
}

download_node() {
  local arch tarball tmp base ok=
  case "$(uname -m)" in
    x86_64) arch=x64 ;;
    aarch64) arch=arm64 ;;
    *) die "不认识的 CPU 架构 $(uname -m)" ;;
  esac
  tarball=node-v$NODE_VERSION-linux-$arch.tar.xz
  command -v xz > /dev/null || die "解 $tarball 要 xz:dnf -y install xz"
  tmp=$(mktemp -d)
  for base in "https://registry.npmmirror.com/-/binary/node/v$NODE_VERSION" "https://nodejs.org/dist/v$NODE_VERSION"; do
    echo "下载 $base/$tarball"
    if curl -fsSL --connect-timeout 15 --max-time 600 -o "$tmp/$tarball" "$base/$tarball" \
       && curl -fsSL --connect-timeout 15 --max-time 60 -o "$tmp/SHASUMS256.txt" "$base/SHASUMS256.txt" \
       && (cd "$tmp" && grep " $tarball\$" SHASUMS256.txt | sha256sum -c --quiet -); then
      ok=1; break
    fi
    echo "  这个源不行,换下一个"
  done
  [ -n "$ok" ] || { rm -rf "$tmp"; die "下载 / 校验 Node $NODE_VERSION 失败"; }
  rm -rf "$NODE_DIR.new" && mkdir -p "$NODE_DIR.new"
  tar -xJf "$tmp/$tarball" -C "$NODE_DIR.new" --strip-components=1 --no-same-owner
  rm -rf "$tmp"
  node_ok "$NODE_DIR.new/bin/node" || die "解出来的 node 跑不起来(glibc 太旧?$(ldd --version | head -1))"
  rm -rf "$NODE_DIR" && mv "$NODE_DIR.new" "$NODE_DIR"
}

ensure_node() {
  say "1/4 Node"
  if NODE=$(find_node); then
    echo "用现有的 $NODE ($("$NODE" --version))"
  else
    echo "系统里没有 >= 22.13 的 node(要 node:sqlite),装官方二进制到 $NODE_DIR(不影响系统 node)"
    download_node
    NODE=$NODE_DIR/bin/node
    echo "已装 $NODE ($("$NODE" --version))"
  fi
}

status() {
  systemctl --no-pager status "$UNIT" 2> /dev/null | head -12 || echo "$UNIT 没装"
  echo
  echo "数据库: $(ls -l "$DATA_DIR/site.db" 2> /dev/null || echo 无)"
  echo "收款码: $(ls -l "$QR_DST" 2> /dev/null || echo "无(会员页会显示「收款码暂时不可用」;用 --qr 装)")"
  echo -n "接口:   "; curl -s -m 5 -o /dev/null -w '%{http_code}\n' "http://127.0.0.1:$PORT/api/platform" || echo 不通
  echo "管理员:"; bash "$APP/deploy/icp-admin.sh" list-admins 2> /dev/null | sed 's/^/  /' || true
}

[ "$(id -u)" = 0 ] || die "请用 root 跑"
QR_SRC=
case "${1:-}" in
  --node-only) ensure_node; exit 0 ;;
  --status) status; exit 0 ;;
  --uninstall)
    systemctl disable --now "$UNIT" 2> /dev/null || true
    rm -f "/etc/systemd/system/$UNIT.service" && systemctl daemon-reload
    echo "已停止并删除 $UNIT 服务。数据保留在 $DATA_DIR、$CONF_DIR,确认不要了再手动删(以及 $NODE_DIR、用户 $USER_NAME)。"
    exit 0 ;;
  --qr) QR_SRC=${2:-}; [ -f "$QR_SRC" ] || die "--qr 后面要跟收款码 PNG 文件路径" ;;
  "") ;;
  *) die "用法见脚本开头注释" ;;
esac
[ -f "$APP/dist/server.mjs" ] || die "$APP/dist/server.mjs 不存在:icp-site 的 PR 合并并上线(2–4 分钟)了吗?"

ensure_node

say "2/4 用户和目录"
id "$USER_NAME" > /dev/null 2>&1 || useradd --system --no-create-home --home-dir "$DATA_DIR" --shell /sbin/nologin "$USER_NAME"
install -d -m 700 -o "$USER_NAME" -g "$USER_NAME" "$DATA_DIR"
install -d -m 755 -o root -g root "$CONF_DIR"
echo "$DATA_DIR(数据,700 $USER_NAME)  $CONF_DIR(配置,root)"

say "3/4 会员收款码"
if [ -n "$QR_SRC" ]; then
  head -c 8 "$QR_SRC" | od -An -tx1 | tr -d ' \n' | grep -qx 89504e470d0a1a0a || die "$QR_SRC 不是 PNG"
  install -m 644 -o root -g root "$QR_SRC" "$QR_DST"
  echo "已装 $QR_DST (sha256 $(sha256sum < "$QR_DST" | cut -c1-16)…)"
elif [ -f "$QR_DST" ]; then
  echo "沿用已有的 $QR_DST"
else
  echo "WARN: 没有收款码($QR_DST)。登录后会员页会显示「收款码暂时不可用」;补装:重跑本脚本加 --qr <png>"
fi

say "4/4 数据库和服务"
runuser -u "$USER_NAME" -- env ICP_DB_PATH="$DATA_DIR/site.db" "$NODE" --no-warnings "$APP/dist/server.mjs" migrate
sed -e "s#@NODE@#$NODE#g" -e "s#@APP@#$APP#g" "$APP/deploy/$UNIT.service" > "/etc/systemd/system/$UNIT.service"
systemctl daemon-reload
systemctl enable -q "$UNIT"
systemctl restart "$UNIT"
for _ in $(seq 1 20); do
  curl -s -m 2 -o /dev/null "http://127.0.0.1:$PORT/api/platform" && break
  sleep 0.5
done
code=$(curl -s -m 5 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/platform" || true)
[ "$code" = 200 ] || { journalctl -u "$UNIT" -n 20 --no-pager; die "服务没起来(127.0.0.1:$PORT 返回 ${code:-无响应})"; }
echo "$UNIT 已运行,127.0.0.1:$PORT/api/platform -> 200"
code=$(curl -sk -m 5 -o /dev/null -w '%{http_code}' --resolve www.hiogolf.cn:443:127.0.0.1 https://www.hiogolf.cn/api/platform || true)
echo "经 nginx:https://www.hiogolf.cn/api/platform -> ${code:-无响应}$( [ "$code" = 200 ] || echo "(nginx 配置还没更新?bash $SITE_DIR/scripts/deploy-site.sh --status)")"

if ! bash "$APP/deploy/icp-admin.sh" list-admins | grep -q @; then
  echo
  echo "下一步:创建网站后台管理员(会提示输入密码):"
  echo "  bash $APP/deploy/icp-admin.sh create-admin 你的邮箱"
fi
