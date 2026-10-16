#!/bin/bash
# 官网合并即上线(服务器端),照搬 HIO-backend 的 scripts/auto-deploy.sh。cron 每 2 分钟跑一次:
#   CI(.github/workflows/ci.yml)在 main 的某个提交上检查全部通过后,把分支 deploy/main 移到这个提交
#   (mark-deployable job;仓库变量 AUTO_DEPLOY=false 时不移,等于在 GitHub 上暂停)。
#   这里拉 deploy/main,比线上新就把 /opt/hio-website 的 main 快进过去。站点根目录就是这份 checkout,
#   静态文件快进完即生效,不用 reload。只跟 deploy/main、不跟 main:没通过 CI 的提交不会上线。
#   拉取只走 SSH 协议、包 timeout:这台国内服务器走 HTTPS 连 GitHub 会无输出挂起,所以不用 origin
#   (服务器上 origin 是不是 HTTPS 都不影响这里)。root 的 ~/.ssh/config 给 github.com 配了密钥,
#   仓库是公开的,任何在 GitHub 注册过的 key 都能读。
#   nginx/hiogolf-site.conf 和线上 /etc/nginx/conf.d/ 里的不一样时:拷过去 → nginx -t → reload;
#   nginx -t 不过就恢复线上原文件并通知,这份配置不再每轮重试(等下一个提交改它,或 --retry)。
#   配置引用了 hio_* 限流 zone 而 zone 文件(后端仓库 scripts/install-nginx-limits.sh 装)还没装时,
#   这轮不动 nginx,静态文件照常上线,装好后下一轮自动补上。换配置那一下拿着后端的发布锁
#   (/var/lock/aigolf-deploy.lock),后端蓝绿切换的 nginx -t 不会撞上换到一半的配置。
#
# 用法(root,在服务器上):
#   bash /opt/hio-website/scripts/deploy-site.sh                 # 检查一次,有新的就上线(cron 调的就是这个)
#   bash /opt/hio-website/scripts/deploy-site.sh --status        # 线上提交、deploy/main、暂停、nginx 配置、最近日志
#   bash /opt/hio-website/scripts/deploy-site.sh --pause "原因"  # 暂停自动上线
#   bash /opt/hio-website/scripts/deploy-site.sh --resume        # 恢复,下一轮(2 分钟内)追上 deploy/main
#   bash /opt/hio-website/scripts/deploy-site.sh --retry         # 上次 nginx -t 没过的配置再试一次,并跑一轮
#   bash /opt/hio-website/scripts/deploy-site.sh --install       # 装 cron(每 2 分钟,在偶数分钟的第 30 秒跑,
#                                                                #   和后端 */2、CRM 奇数分钟错开)
#   bash /opt/hio-website/scripts/deploy-site.sh --uninstall     # 卸 cron(暂停只需 --pause)
#
# 不会自动上线的情况(写日志,同一件事只说一次,需要人处理的发通知):暂停中;不在 main 分支上(手动
# git checkout 了旧提交救急:不会被顶掉,git checkout main 即恢复);工作区有未提交改动;本地 main 比
# deploy/main 新(有人手动拉了还没过 CI 的提交,等 deploy/main 追上来);本地 main 不能快进到 deploy/main。
# fetch 连续失败约 30 分钟、锁被占约 30 分钟、nginx -t 失败,通过后端的 /opt/ai-golf/scripts/lib-notify.sh
# 发通知(/opt/ai-golf/.env 里配的邮件 / 企业微信;没配就只写日志)。成功上线只写日志。
# 状态在 /var/lib/hio-site-deploy/(不在站点根目录里),日志是 cron 重定向的 /var/log/hio-site-deploy.log。
# 一次性设置见 README「部署」。改了本脚本不用另外拷:它就在这份 checkout 里,快进后下一轮就是新版。
set -u
umask 022
# cron 的 PATH 很短:补上常用目录(加在后面,调用方已有的 PATH 优先)
export PATH="$PATH:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

SITE_DIR="${SITE_DIR:-/opt/hio-website}"
NGINX_DST="${NGINX_DST:-/etc/nginx/conf.d/hiogolf-site.conf}"
RATELIMIT_ZONES="${RATELIMIT_ZONES:-/etc/nginx/conf.d/aigolf-ratelimit.conf}"
REPO_URL="${SITE_REPO_URL:-git@github.com:HIOGolfApp/HIOWebAPP.git}"
STATE="${SITE_STATE_DIR:-/var/lib/hio-site-deploy}"
NOTIFY_LIB="${SITE_NOTIFY_LIB:-/opt/ai-golf/scripts/lib-notify.sh}"
NGINX_LOCK="${SITE_NGINX_LOCK:-/var/lock/aigolf-deploy.lock}"   # 后端 deploy-server.sh 的发布锁
NGINX_LOCK_WAIT="${SITE_NGINX_LOCK_WAIT:-30}"
LOCK_WAIT="${SITE_LOCK_WAIT:-0}"            # cron 不等;scripts/deploy.sh 手动触发时等 120 秒
FETCH_TIMEOUT="${SITE_FETCH_TIMEOUT:-90}"
STREAK_ALERT="${SITE_STREAK_ALERT:-15}"     # 连续 15 轮(约 30 分钟)fetch 失败 / 锁被占才通知
LOG=/var/log/hio-site-deploy.log
REF=deploy/main
NGINX_SRC="$SITE_DIR/nginx/hiogolf-site.conf"
CRON_TAG='# hio-site-deploy'

ts()  { date '+%F %T'; }
log() { echo "[$(ts)] $*"; }
g()   { git -C "$SITE_DIR" "$@"; }
short()   { g rev-parse --short "$1" 2>/dev/null || echo "${1:0:7}"; }
subject() { g log -1 --format=%s "$1" 2>/dev/null; }
is_ancestor() { g merge-base --is-ancestor "$1" "$2" 2>/dev/null; }
target()  { g rev-parse -q --verify "refs/remotes/origin/$REF^{commit}" 2>/dev/null; }

notify() {
  [ -r "$NOTIFY_LIB" ] || return 0
  # shellcheck source=/dev/null
  ( . "$NOTIFY_LIB" && send_notice "$1" ) || log "通知发送失败(不影响上线)"
}
# 同一件事只说一次(日志 + 可选通知):每类问题(lock / fetch / sync / nginx)记着上次说过的 key,
# key 变了才再说;问题消失时 clear_notice,以后再出现会重新说
say_once() {   # $1 类别  $2 key  $3 日志  [$4 通知]
  local f="$STATE/notice-$1"
  [ "$(cat "$f" 2>/dev/null)" = "$2" ] && return 0
  echo "$2" > "$f"
  log "$3"
  [ -n "${4:-}" ] && notify "$4"
  return 0
}
clear_notice() { rm -f "$STATE/notice-$1"; }
# 连续第几轮出某种问题,成功一次就清零
streak() { local n; n=$(( $(cat "$STATE/$1" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$STATE/$1"; echo "$n"; }

lock() {   # $1 = 最多等几秒(0 = 不等)
  exec 9> "$STATE/lock"
  if [ "$1" = 0 ]; then flock -n 9; else flock -w "$1" 9; fi
}

# BatchMode:密钥不对立刻失败,不会卡在密码提示上;timeout 连 ssh 子进程一起杀,挂住也不会一直占着锁
fetch_ref() {
  GIT_SSH_COMMAND="${GIT_SSH_COMMAND:-ssh -o BatchMode=yes -o ConnectTimeout=20}" \
    timeout -k 10 "$FETCH_TIMEOUT" git -C "$SITE_DIR" fetch -q --no-tags "$REPO_URL" \
      "+refs/heads/$REF:refs/remotes/origin/$REF" 2>&1 < /dev/null | tail -3
  return "${PIPESTATUS[0]}"
}

# 把 checkout 快进到 deploy/main。返回 0 = 已和 deploy/main 一致(本来就是,或刚快进完),接着看 nginx 配置;
# 1 = 这轮不动(原因已说过)
sync_checkout() {
  local T="$1" t head branch out
  t=$(short "$T")
  head=$(g rev-parse -q --verify HEAD) || { log "$SITE_DIR 不是 git checkout?"; return 1; }
  branch=$(g symbolic-ref -q --short HEAD)
  if [ -z "$branch" ]; then
    say_once sync "detached-$T" "不在 main 分支上(detached HEAD $(short "$head")),不自动上线 $t;确认后 git -C $SITE_DIR checkout main 即恢复" \
      "**官网自动上线跳过** $t
> $(subject "$T")
服务器 $SITE_DIR 不在 main 分支上(detached HEAD $(short "$head"),手动切到旧提交救急?)。确认可以上线后在服务器上 \`git -C $SITE_DIR checkout main\`。"
    return 1
  fi
  if [ "$branch" != main ]; then
    say_once sync "branch-$branch-$T" "当前分支是 $branch 不是 main,不自动上线 $t" \
      "**官网自动上线跳过** $t
服务器 $SITE_DIR 当前分支是 $branch,不是 main。"
    return 1
  fi
  if [ -n "$(g status --porcelain --untracked-files=no)" ]; then
    say_once sync "dirty-$T" "工作区有未提交改动,不自动上线 $t(git -C $SITE_DIR status)" \
      "**官网自动上线跳过** $t
> $(subject "$T")
服务器 $SITE_DIR 有未提交的改动,先处理掉(\`git -C $SITE_DIR status\`)。"
    return 1
  fi
  if [ "$head" = "$T" ]; then
    clear_notice sync
    return 0
  fi
  if is_ancestor "$T" "$head"; then
    # 有人手动拉了 main(里面可能有还没过 CI 的提交):不往回退,也不动 nginx,等 deploy/main 追上来
    say_once sync "ahead-$T" "本地 main($(short "$head"))比 $REF($t)新,这轮不动,等 $REF 追上来"
    return 1
  fi
  # 只做快进:分叉了(服务器上有不在 GitHub 上的提交)或会覆盖未跟踪文件时 git 会拒绝,由人来决定,绝不悄悄覆盖
  if ! out=$(g merge -q --ff-only "$T" 2>&1); then
    say_once sync "noff-$T" "main 不能快进到 $t,不自动上线:$(tail -2 <<< "$out")" \
      "**官网自动上线跳过** $t
> $(subject "$T")
服务器上的 main($(short "$head"))不能快进到它(本地有不在 GitHub 上的提交,或有未跟踪文件挡路),需要手动处理:
$(tail -3 <<< "$out")"
    return 1
  fi
  clear_notice sync
  log "已上线 $(short "$head") -> $t  https://www.hiogolf.cn/"
  g --no-pager log --oneline "$head..$T" | head -20 | sed 's/^/    /'
  return 0
}

# 仓库里的 nginx 站点配置和线上不一样时才动 nginx(都在这一个函数里,返回值不影响静态文件上线)
apply_nginx_conf() {
  local h prev out had_prev=0
  [ -f "$NGINX_SRC" ] || return 0
  if cmp -s "$NGINX_SRC" "$NGINX_DST"; then
    rm -f "$STATE/nginx-failed"; clear_notice nginx
    return 0
  fi
  h=$(sha256sum < "$NGINX_SRC" | cut -c1-12)
  # 这份配置已经 nginx -t 失败过:不每轮重试(每次都要把它放进 conf.d 一下),等新提交或 --retry
  [ "$(cat "$STATE/nginx-failed" 2>/dev/null)" = "$h" ] && return 0
  if grep -q 'zone=hio_' "$NGINX_SRC" && [ ! -f "$RATELIMIT_ZONES" ]; then
    say_once nginx "nozones-$h" "WARN: $NGINX_SRC 用了 hio_ 限流 zone,但 $RATELIMIT_ZONES 不存在,nginx 配置没更新。装好后端的 scripts/install-nginx-limits.sh 后下一轮自动补上" \
      "**官网 nginx 配置没更新** 新配置用了 hio_ 限流 zone,但服务器上没有 $RATELIMIT_ZONES(后端 scripts/install-nginx-limits.sh 装)。静态文件已照常上线;装好 zone 后 2 分钟内自动补上。"
    return 0
  fi
  # 后端 deploy-server.sh 切蓝绿时也 nginx -t + reload,拿同一把锁,谁都不会撞上对方换到一半的配置
  exec 8> "$NGINX_LOCK" || return 0
  if ! flock -w "$NGINX_LOCK_WAIT" 8; then
    say_once nginx "lock-$h" "后端正在发布(锁 $NGINX_LOCK),nginx 配置下一轮再更新"
    exec 8>&-
    return 0
  fi
  # 盘上的配置本来就不过 nginx -t(不是官网这份的问题):不换,也不记失败,别处修好后下一轮自动更新
  if ! out=$(nginx -t 2>&1); then
    say_once nginx "broken-$h" "ERROR: 换配置之前 nginx -t 就不过(问题不在官网配置),这轮不动 nginx:$(grep -m1 'emerg' <<< "$out" || tail -1 <<< "$out")" \
      "**官网 nginx 配置没更新** 服务器上现有的 nginx 配置本来就过不了 nginx -t(问题不在官网这份),官网新配置先不换,修好后 2 分钟内自动补上:
$(tail -4 <<< "$out")"
    exec 8>&-
    return 0
  fi
  # 恢复用拷贝前的线上快照,不用 git show:重跑时 HEAD 已经是新提交,会把坏配置写回去
  prev=$(mktemp)
  if [ -f "$NGINX_DST" ]; then cp -p "$NGINX_DST" "$prev"; had_prev=1; fi
  cp "$NGINX_SRC" "$NGINX_DST"
  if out=$(nginx -t 2>&1); then
    if systemctl reload nginx; then
      rm -f "$STATE/nginx-failed"; clear_notice nginx
      log "nginx 配置已更新并 reload"
    else
      say_once nginx "reload-$h" "ERROR: 新 nginx 配置已就位(nginx -t 通过),但 systemctl reload nginx 失败" \
        "**官网 nginx reload 失败** 新配置已就位、nginx -t 通过,但 systemctl reload nginx 失败,在服务器上看 \`systemctl status nginx\`。"
    fi
  else
    if [ "$had_prev" = 1 ]; then cp -p "$prev" "$NGINX_DST"; else rm -f "$NGINX_DST"; fi
    echo "$h" > "$STATE/nginx-failed"
    log "ERROR: 新 nginx 配置过不了 nginx -t,已恢复线上原文件;静态文件照常上线,这份配置不再自动重试(修好后合并新提交,或 --retry):"
    sed 's/^/    /' <<< "$out"
    nginx -t > /dev/null 2>&1 || log "ERROR: 恢复后 nginx -t 仍然不过,需要人工处理"
    notify "**官网 nginx 配置 nginx -t 失败** $(short HEAD)
> $(subject HEAD)
已恢复线上原文件,静态文件照常上线;这份配置不再自动重试(修好后合并新提交,或在服务器上 \`bash $SITE_DIR/scripts/deploy-site.sh --retry\`)。
$(tail -4 <<< "$out")"
  fi
  rm -f "$prev"
  exec 8>&-
  return 0
}

cron_line() { echo "*/2 * * * * sleep 30; bash $SITE_DIR/scripts/deploy-site.sh >> $LOG 2>&1 $CRON_TAG"; }

status() {
  local T H B
  if lock 10; then
    fetch_ref > /dev/null || echo "(fetch $REF 失败,下面是本地缓存)"
    exec 9>&-
  else
    echo "(另一轮正在跑,下面是本地缓存)"
  fi
  T=$(target); H=$(g rev-parse -q --verify HEAD); B=$(g symbolic-ref -q --short HEAD)
  echo "cron:         $(crontab -l 2>/dev/null | grep -qF "$CRON_TAG" && echo 已安装 || echo 未安装)"
  echo "暂停:         $(cat "$STATE/paused" 2>/dev/null || echo 否)"
  echo "线上:         $(short "$H") $(subject "$H")  [${B:-detached HEAD}]"
  if [ -z "$T" ]; then
    echo "$REF:  (本地还没有;CI 标记过、fetch 成功一次后才有)"
  else
    echo "$REF:  $(short "$T") $(subject "$T")"
    if [ "$H" = "$T" ]; then echo "              = 线上"
    elif is_ancestor "$H" "$T"; then echo "              比线上新 $(g rev-list --count "$H..$T") 个提交(下一轮上线)"
    elif is_ancestor "$T" "$H"; then echo "              比线上旧(线上有还没过 CI 的提交,等它追上来)"
    else echo "              和线上分叉(需要人工处理)"; fi
  fi
  [ -n "$(g status --porcelain --untracked-files=no)" ] && echo "工作区:       有未提交改动(git -C $SITE_DIR status)"
  if cmp -s "$NGINX_SRC" "$NGINX_DST"; then
    echo "nginx 配置:   与仓库一致"
  else
    echo "nginx 配置:   与仓库不一致$( [ -f "$STATE/nginx-failed" ] && echo "(这份 nginx -t 失败过,不自动重试;--retry)")"
  fi
  [ -f "$STATE/fetch-fail" ] && echo "fetch 失败:   连续 $(cat "$STATE/fetch-fail") 轮"
  echo "最近日志($LOG):"
  tail -5 "$LOG" 2>/dev/null | sed 's/^/  /'
  return 0
}

main() {
  local RETRY=0 N T ERR RC
  mkdir -p "$STATE" || return 1
  case "${1:-}" in
    --install)
      ( crontab -l 2>/dev/null | grep -vF "$CRON_TAG" | grep -vF "$SITE_DIR/scripts/deploy-site.sh"; cron_line ) | crontab - || return 1
      log "已安装 cron:$(cron_line)"
      return 0 ;;
    --uninstall)
      crontab -l 2>/dev/null | grep -vF "$CRON_TAG" | crontab -
      log "已卸载 cron(暂停只需 --pause,不用卸)"
      return 0 ;;
    --pause)
      echo "${2:-手动暂停} ($(ts))" > "$STATE/paused"
      log "自动上线已暂停:$(cat "$STATE/paused")"
      return 0 ;;
    --resume)
      rm -f "$STATE/paused" "$STATE"/notice-*
      log "自动上线已恢复,下一轮(2 分钟内)追上 $REF"
      return 0 ;;
    --status)
      status
      return 0 ;;
    --retry)
      RETRY=1
      rm -f "$STATE/nginx-failed" "$STATE/notice-nginx" ;;
    "") ;;
    *) echo "用法: $0 [--status | --pause 原因 | --resume | --retry | --install | --uninstall](见脚本开头注释)"; return 2 ;;
  esac

  if [ "$RETRY" != 1 ] && [ -f "$STATE/paused" ]; then return 0; fi

  # 上一轮还没完(或 deploy.sh 手动触发的正在跑)就这轮不动;一直拿不到锁(约 30 分钟)要说出来
  if ! lock "$LOCK_WAIT"; then
    N=$(streak lock-busy)
    [ "$N" -ge "$STREAK_ALERT" ] && say_once lock "lock-busy-$(date +%F)" "锁 $STATE/lock 已被占 $N 轮,这轮跳过" \
      "**官网自动上线卡住** 锁已被占约 $((N * 2)) 分钟,新合并的提交不会上线。在服务器上看谁占着:\`ps -ef | grep -E 'deploy-site|git' | grep -v grep\`"
    return 0
  fi
  rm -f "$STATE/lock-busy"; clear_notice lock

  ERR=$(fetch_ref); RC=$?
  if [ "$RC" != 0 ]; then
    case "$RC" in 124|137) ERR="超时 ${FETCH_TIMEOUT}s${ERR:+:$ERR}" ;; esac
    N=$(streak fetch-fail)
    log "fetch $REF 失败(第 $N 轮;网络?GitHub 密钥?或 CI 还从没标记过 $REF),下轮再试:${ERR:-git fetch 退出码 $RC}"
    [ "$N" -ge "$STREAK_ALERT" ] && say_once fetch "fetch-fail-$(date +%F)" "fetch 已连续失败 $N 轮,发通知" \
      "**官网自动上线卡住** 已经约 $((N * 2)) 分钟拉不到 GitHub 的 $REF,新合并的提交不会上线。最后一次的错误:
${ERR:-git fetch 退出码 $RC}
在服务器上试:\`bash $SITE_DIR/scripts/deploy-site.sh --status\`(网络 / ~/.ssh/config 里 github.com 的密钥)"
    return 0
  fi
  rm -f "$STATE/fetch-fail"; clear_notice fetch

  T=$(target) || return 0
  sync_checkout "$T" || return 0
  apply_nginx_conf
  return 0
}

# 必须是最后一行、写在同一行:快进会改写本文件,bash 在 main 返回后就不再往下读它
main "$@"; exit $?
