#!/bin/bash
# 临时 ICP 站的管理员账号(网站后台:会员申请审核、第三方信息审核)。root 跑,以服务用户 hio-icp 身份操作数据库。
#   bash /opt/hio-website/icp-site/deploy/icp-admin.sh create-admin 邮箱 [称呼]   # 新建,或把已有账号设为管理员;
#                                                                               # 总会重设密码并踢掉该账号所有登录
#   bash /opt/hio-website/icp-site/deploy/icp-admin.sh revoke-admin 邮箱
#   bash /opt/hio-website/icp-site/deploy/icp-admin.sh list-admins
# 注册不验证邮箱,别人可能抢先用你的邮箱注册:create-admin 会重设密码、踢掉已有登录,所以照样安全。
set -euo pipefail
SITE_DIR=${SITE_DIR:-/opt/hio-website}
NODE_DIR=${ICP_NODE_DIR:-/opt/hio-icp-node}
NODE=$NODE_DIR/bin/node
[ -x "$NODE" ] || NODE=$(command -v node) || { echo "找不到 node,先跑 icp-site/deploy/install.sh" >&2; exit 1; }
[ "$(id -u)" = 0 ] || { echo "请用 root 跑" >&2; exit 1; }
exec runuser -u hio-icp -- env ICP_DB_PATH=/var/lib/hio-icp-site/site.db \
  "$NODE" --no-warnings "$SITE_DIR/icp-site/dist/server.mjs" "$@"
