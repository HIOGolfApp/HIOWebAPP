#!/bin/bash
# 在 rockylinux:8 容器里搭一台「假服务器」:和线上 TencentOS 3.3 同版本的 nginx 1.14.1 / git 2.43,
# 再补上官网 nginx 配置依赖、但不在本仓库里的东西(都是桩):
#   - /etc/nginx/conf.d/aigolf-ratelimit.conf   后端仓库(私有)装的 hio_* 限流 zone:zone 名照抄,速率是假的
#   - /etc/nginx/conf.d/aigolf-upstream.conf    upstream aigolf_app,指向下面这个假后端
#   - /etc/nginx/conf.d/zz-ci-backend-stub.conf 假后端:原样回显收到的 URI
#   - /etc/nginx/ssl/hiogolf.cn*                自签证书
#   - /usr/local/bin/systemctl                  容器里没有 systemd:reload nginx 换成 nginx -s reload,并计数
#   - /opt/ci/notify-stub.sh                    代替后端的 lib-notify.sh:通知写进 /tmp/ci-notices
# 用法(CI 和本地一样,本地在仓库根目录):
#   docker run -d --name sim -v "$PWD:/src:ro" rockylinux:8 sleep infinity
#   docker exec sim bash /src/.github/ci/sim-setup.sh
#   docker exec sim bash /src/.github/ci/nginx-test.sh
#   docker exec sim bash /src/.github/ci/deploy-site-test.sh
#   docker rm -f sim
set -euo pipefail

if ! command -v nginx > /dev/null; then
  dnf -y -q module enable nginx:1.14
  # 服务器上 deploy-site.sh 用到的:git、flock(util-linux)、timeout / sha256sum(coreutils)、cmp(diffutils)、crontab(cronie)
  dnf -y -q install nginx git-core cronie diffutils findutils openssl procps-ng util-linux > /dev/null
fi
nginx -v 2>&1 | grep -q 'nginx/1\.14\.' || { echo "expected nginx 1.14.x (the server runs 1.14.1), got: $(nginx -v 2>&1)"; exit 1; }
echo "$(nginx -v 2>&1) / $(git --version) / $(flock --version | head -1)"

mkdir -p /etc/nginx/ssl /run/lock /opt/ci
if [ ! -f /etc/nginx/ssl/hiogolf.cn.key ]; then
  openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj /CN=hiogolf.cn \
    -addext "subjectAltName=DNS:hiogolf.cn,DNS:www.hiogolf.cn" \
    -keyout /etc/nginx/ssl/hiogolf.cn.key -out /etc/nginx/ssl/hiogolf.cn_bundle.crt 2> /dev/null
fi

# 只要 zone 名和后端 nginx/aigolf-ratelimit.conf 一致,nginx -t 就能查出官网配置引用了不存在的 zone。
# 后端新增 / 改名 zone 时这里跟着改。速率故意很低(且本机不豁免),好让 nginx-test.sh 测到 429 页面。
cat > /etc/nginx/conf.d/aigolf-ratelimit.conf <<'EOF'
# CI stub of HIO-backend nginx/aigolf-ratelimit.conf: same zone names, made-up rates
limit_req_zone $binary_remote_addr zone=hio_api:1m    rate=100r/s;
limit_req_zone $binary_remote_addr zone=hio_public:1m rate=1r/m;
limit_req_zone $binary_remote_addr zone=hio_auth:1m   rate=1r/m;
limit_req_zone $binary_remote_addr zone=hio_bundle:1m rate=1r/m;
limit_req_zone $binary_remote_addr zone=hio_geo:1m    rate=1r/m;
limit_req_status    429;
limit_req_log_level error;
EOF
cp /etc/nginx/conf.d/aigolf-ratelimit.conf /opt/ci/aigolf-ratelimit.conf   # deploy-site-test.sh 删了再装回来用

echo 'upstream aigolf_app { server 127.0.0.1:18081; }' > /etc/nginx/conf.d/aigolf-upstream.conf
cat > /etc/nginx/conf.d/zz-ci-backend-stub.conf <<'EOF'
server {
    listen 127.0.0.1:18081;
    location / { default_type text/plain; return 200 "upstream $request_uri\n"; }
}
EOF

cat > /usr/local/bin/systemctl <<'EOF'
#!/bin/sh
[ "$1 $2" = "reload nginx" ] || { echo "fake systemctl: unsupported: $*" >&2; exit 1; }
echo reload >> /tmp/ci-reloads
nginx -s reload
EOF
chmod +x /usr/local/bin/systemctl

cat > /opt/ci/notify-stub.sh <<'EOF'
send_notice() { printf '%s\n@@@\n' "$1" >> /tmp/ci-notices; }
EOF

nginx -t -q
echo "sim ready"
