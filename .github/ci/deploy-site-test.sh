#!/bin/bash
# scripts/deploy-site.sh 的各种情况,在 sim-setup.sh 搭好的假服务器上跑:
#   本地裸仓库当 GitHub(SITE_REPO_URL 指过去),DEV 是开发者的 clone(推 main;mark 模拟 CI 移动 deploy/main),
#   /opt/hio-website 是服务器 checkout(origin 故意设成连不上的 HTTPS 地址:脚本不能用 origin)。
#   跑的是被测提交里的 scripts/deploy-site.sh 本身(从服务器 checkout 里跑,和线上一样)。
# check 的条件大多是 eval 的单引号字符串,shellcheck 看不到里面用到的变量
# shellcheck disable=SC2034
set -uo pipefail
SRC=${SRC:-/src}
SITE=/opt/hio-website
GH=/tmp/ci-gh/HIOWebAPP.git
DEV=/tmp/ci-dev
STATE=/var/lib/hio-site-deploy
CONF=/etc/nginx/conf.d/hiogolf-site.conf
CONF_REL=nginx/hiogolf-site.conf
W=www.hiogolf.cn
export SITE_REPO_URL=$GH SITE_NOTIFY_LIB=/opt/ci/notify-stub.sh SITE_STREAK_ALERT=3 SITE_NGINX_LOCK_WAIT=1
export GIT_AUTHOR_NAME=ci GIT_AUTHOR_EMAIL=ci@example.com GIT_COMMITTER_NAME=ci GIT_COMMITTER_EMAIL=ci@example.com
fails=0

# ---- helpers ---------------------------------------------------------------------------------
run() {   # 像 cron 那样跑一次;输出在 $OUT,退出码在 $RC
  OUT=$(bash "$SITE/scripts/deploy-site.sh" "$@" 2>&1); RC=$?
  [ -n "$OUT" ] && printf '%s\n' "$OUT" | sed 's/^/        | /'
  return 0
}
check() {   # <描述> <命令...>
  if "${@:2}"; then echo "  ok   $1"; else echo "  FAIL $1"; fails=$((fails + 1)); fi
}
has()      { grep -qF -- "$1" <<< "$OUT"; }
silent()   { [ -z "$OUT" ] && [ "$RC" = 0 ]; }
head_at()  { [ "$(git -C "$SITE" rev-parse HEAD)" = "$(git -C "$DEV" rev-parse "$1")" ]; }
conf_at()  { git -C "$DEV" show "$1:$CONF_REL" | cmp -s - "$CONF"; }
notices()  { local n; n=$(grep -c '^@@@$' /tmp/ci-notices 2> /dev/null); echo "${n:-0}"; }
reloads()  { cat /tmp/ci-reloads 2> /dev/null | wc -l; }
header()   { curl -sk -I --resolve "$W:443:127.0.0.1" "https://$W/" | tr -d '\r' | sed -n "s/^$1: //Ip"; }
served()   { curl -sk --resolve "$W:443:127.0.0.1" "https://$W/" | grep -qF -- "$1"; }
eq()       { [ "$1" = "$2" ]; }
# DEV 上改点东西、提交、推 main(CI 还没跑:deploy/main 不动)
commit()   { local msg=$1; shift; ( cd "$DEV" && "$@" ) && git -C "$DEV" commit -qam "$msg" && git -C "$DEV" tag "$msg" && git -C "$DEV" push -q "$GH" main; }
mark()     { git -C "$DEV" push -q "$GH" HEAD:refs/heads/deploy/main; }   # = CI 的 mark-deployable
page()     { echo "<!-- ci $1 -->" >> index.html; }
hdr()      { sed -i "s/^\(    add_header X-CI-Rev\).*/\1 $1;/" "$CONF_REL"; }   # www 块里的测试响应头,验证真 reload 了
title()    { echo; echo "== $*"; }

# ---- 假 GitHub + 服务器 ----------------------------------------------------------------------
nginx -s stop 2> /dev/null && sleep 1
set -e
rm -rf "$SITE" "$GH" "$DEV" "$STATE" /tmp/ci-notices /tmp/ci-reloads /etc/nginx/private.d /etc/nginx/conf.d/zz-broken.conf
cp /opt/ci/aigolf-ratelimit.conf /etc/nginx/conf.d/aigolf-ratelimit.conf
crontab -r 2> /dev/null || true
mkdir -p "$DEV"
# --no-same-owner:CI 里检出目录属 runner 的 uid,root 解包默认保留属主,git 会报 dubious ownership;服务器上也是 root 的
tar -C "$SRC" --exclude=./.git --exclude=./.claude -cf - . | tar -C "$DEV" --no-same-owner -xf -
sed -i "s/^\(    server_name www\.hiogolf\.cn;\)$/\1\n    add_header X-CI-Rev c1;/" "$DEV/$CONF_REL"
grep -q 'X-CI-Rev c1' "$DEV/$CONF_REL" || { echo "could not add the test header to $CONF_REL"; exit 1; }
git -C "$DEV" init -q -b main && git -C "$DEV" add -A && git -C "$DEV" commit -qm c1 && git -C "$DEV" tag c1
git init -q --bare -b main "$GH" && git -C "$DEV" push -q "$GH" main
git clone -q "$GH" "$SITE"
git -C "$SITE" remote set-url origin https://github.invalid/HIOGolfApp/HIOWebAPP.git
cp "$SITE/$CONF_REL" "$CONF"
nginx -t -q || exit 1
nginx
trap 'nginx -s stop 2> /dev/null' EXIT
sleep 1
set +e

# ---- scenarios ---------------------------------------------------------------------------------
title "CI has never marked deploy/main yet"
run
check "fetch failure is logged, exit 0" eval 'has "fetch deploy/main 失败" && [ "$RC" = 0 ]'
check "nothing changed" head_at c1

title "deploy/main = what is live"
mark; run
check "silent no-op" silent
check "fetch-fail streak cleared" test ! -e "$STATE/fetch-fail"
check "no reload" eq "$(reloads)" 0

title "main moves, CI not done: not deployed; CI marks it: deployed"
commit c2 page c2; run
check "silent, still on c1" eval 'silent && head_at c1'
mark; run
check "deployed c1 -> c2" eval 'has "已上线" && head_at c2'
check "new page served without reload" eval 'served "ci c2" && [ "$(reloads)" = 0 ]'

title "nginx conf changes (valid): copied, nginx -t, reload"
commit c3 hdr c3; mark; run
check "conf updated and reloaded" eval 'has "nginx 配置已更新并 reload" && conf_at c3 && [ "$(reloads)" = 1 ]'
sleep 1
check "running nginx uses it (X-CI-Rev c3)" eq "$(header X-CI-Rev)" c3

title "nginx conf fails nginx -t: live copy restored, static files still deployed, not retried every round"
N0=$(notices)
commit c4 eval 'page c4; hdr c4; sed -i "s/^\(    add_header X-CI-Rev c4;\)$/\1\n    ci_bogus_directive on;/" nginx/hiogolf-site.conf'
mark; run
check "static files deployed" eval 'head_at c4 && served "ci c4"'
check "error logged, live conf restored to c3" eval 'has "过不了 nginx -t" && conf_at c3'
check "nginx still serving c3, no reload" eval '[ "$(header X-CI-Rev)" = c3 ] && [ "$(reloads)" = 1 ]'
check "one notice" eq "$(notices)" $((N0 + 1))
check "nginx -t on disk is fine" nginx -t -q
run
check "next round: silent, no retry" eval 'silent && [ "$(notices)" = $((N0 + 1)) ] && [ "$(reloads)" = 1 ]'
run --status
check "--status says it failed" has "nginx -t 失败过"
run --retry
check "--retry tries again (and notifies again)" eval 'has "过不了 nginx -t" && [ "$(notices)" = $((N0 + 2)) ] && conf_at c3'
commit c5 eval 'hdr c5; sed -i "/ci_bogus_directive/d" nginx/hiogolf-site.conf'; mark; run
check "fixed conf goes live" eval 'has "nginx 配置已更新" && conf_at c5 && [ ! -e "$STATE/nginx-failed" ]'
sleep 1
check "X-CI-Rev c5" eq "$(header X-CI-Rev)" c5

title "hio_ rate-limit zones not installed: nginx untouched, picked up once they are"
N0=$(notices)
rm /etc/nginx/conf.d/aigolf-ratelimit.conf
commit c6 eval 'page c6; hdr c6'; mark; run
check "static deployed, conf not, WARN" eval 'head_at c6 && served "ci c6" && has "WARN" && conf_at c5'
check "one notice" eq "$(notices)" $((N0 + 1))
run
check "next round silent" eval 'silent && [ "$(notices)" = $((N0 + 1)) ]'
cp /opt/ci/aigolf-ratelimit.conf /etc/nginx/conf.d/aigolf-ratelimit.conf
run
check "zones installed -> conf applied next round" eval 'has "nginx 配置已更新" && conf_at c6'

title "nginx config on disk already broken by something else: don't swap, don't mark failed"
N0=$(notices)
echo 'this is not nginx syntax' > /etc/nginx/conf.d/zz-broken.conf
commit c7 eval 'page c7; hdr c7'; mark; run
check "static deployed, conf untouched" eval 'head_at c7 && has "换配置之前 nginx -t 就不过" && conf_at c6'
check "not marked failed, one notice" eval '[ ! -e "$STATE/nginx-failed" ] && [ "$(notices)" = $((N0 + 1)) ]'
run
check "next round silent" silent
rm /etc/nginx/conf.d/zz-broken.conf
run
check "fixed elsewhere -> applied" eval 'has "nginx 配置已更新" && conf_at c7'

title "backend deploy holds /var/lock/aigolf-deploy.lock: static now, conf next round"
flock /var/lock/aigolf-deploy.lock sleep 4 & BG=$!
sleep 0.5
commit c8 eval 'page c8; hdr c8'; mark; run
check "static deployed, conf waits" eval 'head_at c8 && has "后端正在发布" && conf_at c7'
wait $BG
run
check "lock free -> conf applied" eval 'has "nginx 配置已更新" && conf_at c8'

title "--pause / --resume"
run --pause "ci 测试"
commit c9 page c9; mark; run
check "paused: silent, not deployed" eval 'silent && head_at c8'
run --status
check "--status shows the pause and the pending commit" eval 'has "ci 测试" && has "比线上新 1 个提交"'
run --resume; run
check "resumed: deployed" head_at c9

title "detached HEAD (someone checked out an old commit by hand): left alone until git checkout main"
N0=$(notices)
git -C "$SITE" checkout -q --detach "$(git -C "$DEV" rev-parse c8)"
commit c10 page c10; mark; run
check "not deployed, one notice" eval 'has "detached HEAD" && head_at c8 && [ "$(notices)" = $((N0 + 1)) ]'
run
check "said only once" eval 'silent && [ "$(notices)" = $((N0 + 1)) ]'
git -C "$SITE" checkout -q main; run
check "git checkout main -> deployed" head_at c10

title "uncommitted change in the checkout"
N0=$(notices)
echo tampered >> "$SITE/privacy.html"
commit c11 page c11; mark; run
check "not deployed, one notice" eval 'has "未提交改动" && head_at c10 && [ "$(notices)" = $((N0 + 1)) ]'
git -C "$SITE" checkout -q -- privacy.html; run
check "cleaned up -> deployed" head_at c11

title "server main ahead of deploy/main (someone pulled main by hand): never moved back"
N0=$(notices)
commit c12 page c12
git -C "$SITE" fetch -q "$GH" main && git -C "$SITE" merge -q --ff-only FETCH_HEAD
run
check "left on c12, logged, no notice" eval 'has "比 deploy/main" && head_at c12 && [ "$(notices)" = $N0 ]'
run
check "said only once" silent
mark; run
check "deploy/main catches up: silent" eval 'silent && head_at c12'

title "diverged (a commit made on the server): not fast-forwardable"
N0=$(notices)
git -C "$SITE" commit -q --allow-empty -m "local commit on the server"
commit c13 page c13; mark; run
check "not deployed, one notice" eval 'has "不能快进" && [ "$(notices)" = $((N0 + 1)) ]'
git -C "$SITE" reset -q --hard "$(git -C "$DEV" rev-parse c12)"; run
check "after reset -> deployed" head_at c13

title "fetch keeps failing: logged every round, one notice after SITE_STREAK_ALERT rounds"
N0=$(notices)
for _ in 1 2 3 4; do SITE_REPO_URL=/nonexistent/repo.git run; done
check "4 rounds -> streak 4, one notice" eval '[ "$(cat "$STATE/fetch-fail")" = 4 ] && [ "$(notices)" = $((N0 + 1)) ]'
run
check "fetch ok again -> streak cleared" test ! -e "$STATE/fetch-fail"

title "fetch hangs (HTTPS-style silent hang): killed by timeout"
T0=$(date +%s)
GIT_SSH_VARIANT=simple GIT_SSH_COMMAND='sleep 60; true' SITE_REPO_URL=git@github.invalid:HIOGolfApp/HIOWebAPP.git SITE_FETCH_TIMEOUT=2 run
check "returns in < 15 s with a timeout message" eval '[ $(( $(date +%s) - T0 )) -lt 15 ] && has "超时 2s"'
check "no sleep left behind" eval '! pgrep -f "sleep 60" > /dev/null'
run
check "recovers" test ! -e "$STATE/fetch-fail"

title "previous round still running (lock busy): skip quietly, notice after SITE_STREAK_ALERT rounds"
N0=$(notices)
flock "$STATE/lock" sleep 5 & BG=$!
sleep 0.5
T0=$(date +%s)
for _ in 1 2 3; do run; done
check "3 rounds return at once, one notice" eval '[ $(( $(date +%s) - T0 )) -lt 3 ] && [ "$(notices)" = $((N0 + 1)) ] && has "已被占 3 轮"'
SITE_LOCK_WAIT=10 run
check "SITE_LOCK_WAIT (deploy.sh) waits for it instead" eval '[ "$RC" = 0 ] && [ ! -e "$STATE/lock-busy" ]'
wait $BG

title "the deployed commit rewrites deploy-site.sh itself"
commit c14 eval 'page c14; { head -1 scripts/deploy-site.sh; for i in $(seq 1 400); do echo "# padding $i: the running copy must not read the new file half-way"; done; tail -n +2 scripts/deploy-site.sh; } > /tmp/new.sh && cat /tmp/new.sh > scripts/deploy-site.sh'
mark; run
check "deployed cleanly by the old copy" eval '[ "$RC" = 0 ] && has "已上线" && head_at c14 && ! has "syntax error" && ! has "command not found"'
run
check "new copy runs: silent" silent

title "--install / --uninstall (cron)"
printf '%s\n' '30 3 * * * /opt/ai-golf/scripts/backup-db.sh >> /var/log/aigolf-backup.log 2>&1' \
  '*/2 * * * * bash /opt/hio-website/scripts/deploy-site.sh >> /var/log/hio-site-deploy.log 2>&1' | crontab -
run --install; run --install
CRON=$(crontab -l)
check "one tagged line (*/2 + sleep 30), legacy line replaced, others kept" eval \
  '[ "$(grep -c deploy-site.sh <<< "$CRON")" = 1 ] && grep -qF "*/2 * * * * sleep 30; bash /opt/hio-website/scripts/deploy-site.sh >> /var/log/hio-site-deploy.log 2>&1 # hio-site-deploy" <<< "$CRON" && grep -q backup-db <<< "$CRON"'
run --status
check "--status: cron installed, in sync" eval 'has "已安装" && has "= 线上" && has "与仓库一致"'
run --uninstall
check "--uninstall keeps other lines" eval '! crontab -l | grep -q deploy-site && crontab -l | grep -q backup-db'
run --bogus
check "unknown option -> exit 2" eq "$RC" 2

echo
[ "$fails" = 0 ] && echo "deploy-site-test: all passed" || { echo "deploy-site-test: $fails FAILED"; exit 1; }
