#!/bin/bash
# Oracle Always Free (Ubuntu ARM) or any Ubuntu VPS.
# Usage: sudo bash deploy/install-vps.sh
set -euo pipefail
APP_DIR=/opt/autotread
REPO_URL="${REPO_URL:-https://github.com/mdsa1348/autoTread.git}"
if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root: sudo bash deploy/install-vps.sh"
  exit 1
fi
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y ca-certificates curl git ufw
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
mkdir -p "$APP_DIR/data"
if [ ! -f "$APP_DIR/watchdog.js" ]; then
  echo "Cloning $REPO_URL into $APP_DIR"
  rm -rf "$APP_DIR"
  git clone "$REPO_URL" "$APP_DIR"
  mkdir -p "$APP_DIR/data"
fi
cd "$APP_DIR"
if [ -f package-lock.json ]; then
  npm ci --omit=dev
else
  npm install --omit=dev
fi
mkdir -p "$APP_DIR/data"
cp -f "$APP_DIR/deploy/autotread.service" /etc/systemd/system/autotread.service
ufw allow OpenSSH
ufw allow 3000/tcp
ufw --force enable || true
systemctl daemon-reload
systemctl enable --now autotread
systemctl restart autotread
systemctl --no-pager --full status autotread || true
IP="$(curl -s --max-time 5 ifconfig.me || echo YOUR_PUBLIC_IP)"
echo "Dashboard: http://${IP}:3000"
echo "Oracle console: VCN -> Security List -> Ingress CIDR 0.0.0.0/0 TCP 3000"
echo "Keep TRADING_MODE=paper. Do not put live API keys on this VM."
