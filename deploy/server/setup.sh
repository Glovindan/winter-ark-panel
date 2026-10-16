#!/usr/bin/env bash
# Однократная настройка чистого Ubuntu 22.04/24.04 или Debian 12. Запускать от root:
#   bash setup.sh <домен>        например: bash setup.sh 1-2-3-4.sslip.io
set -euo pipefail

DOMAIN="${1:?Укажи домен, например: bash setup.sh 1-2-3-4.sslip.io}"
NODE_VERSION=22.12.0
APP=/opt/ark

[ "$(id -u)" -eq 0 ] || { echo "Запусти от root"; exit 1; }
export DEBIAN_FRONTEND=noninteractive

echo "==> Пакеты"
apt-get update -y
apt-get install -y curl xz-utils ufw ca-certificates gnupg debian-keyring debian-archive-keyring apt-transport-https

echo "==> Swap 1 ГБ (если ещё нет)"
if [ -z "$(swapon --show --noheadings)" ]; then
  fallocate -l 1G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo "==> Node $NODE_VERSION (официальный архив, проверка контрольной суммы)"
if ! /usr/local/bin/node -v 2>/dev/null | grep -q "^v$NODE_VERSION$"; then
  cd /tmp
  curl -fsSLO "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-x64.tar.xz"
  curl -fsSLO "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt"
  grep " node-v$NODE_VERSION-linux-x64.tar.xz\$" SHASUMS256.txt | sha256sum -c -
  rm -rf /opt/node && mkdir -p /opt/node
  tar -xJf "node-v$NODE_VERSION-linux-x64.tar.xz" -C /opt/node --strip-components=1
  ln -sf /opt/node/bin/node /usr/local/bin/node
  ln -sf /opt/node/bin/npm /usr/local/bin/npm
  ln -sf /opt/node/bin/npx /usr/local/bin/npx
  rm -f "node-v$NODE_VERSION-linux-x64.tar.xz" SHASUMS256.txt
fi
node -v

echo "==> Caddy (официальный apt-репозиторий)"
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y
  apt-get install -y caddy
fi

echo "==> Пользователь и каталоги"
id ark >/dev/null 2>&1 || useradd --system --home-dir "$APP" --shell /usr/sbin/nologin ark
mkdir -p "$APP" /var/lib/ark /srv/ark/web
chown -R ark:ark "$APP" /var/lib/ark
chmod 755 /srv/ark /srv/ark/web

echo "==> Файл настроек $APP/.env"
if [ ! -f "$APP/.env" ]; then
  umask 077
  cat > "$APP/.env" <<EOF
# Заполни BOT_TOKEN и ADMIN_TG_ID, затем поставь BOT_ENABLED=1 и перезапусти: systemctl restart ark
BOT_TOKEN=
ADMIN_TG_ID=
BOT_ENABLED=0
WEBAPP_URL=https://$DOMAIN
SESSION_SECRET=$(openssl rand -base64 48 | tr -d '\n')
PORT=3000
DB_PATH=/var/lib/ark/ark.db
NODE_ENV=production
EOF
  chown ark:ark "$APP/.env"
  chmod 600 "$APP/.env"
else
  echo ".env уже есть, не трогаю"
fi

echo "==> Служба systemd"
cat > /etc/systemd/system/ark.service <<'EOF'
[Unit]
Description=Winter Arc panel (API, bot, scheduler)
After=network-online.target
Wants=network-online.target

[Service]
User=ark
WorkingDirectory=/opt/ark/apps/server
Environment=NODE_ENV=production
Environment=NODE_OPTIONS=--max-old-space-size=256
ExecStart=/opt/ark/node_modules/.bin/tsx --env-file=/opt/ark/.env src/index.ts
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=full
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable ark

echo "==> Ограничение размера журнала (экономим диск)"
mkdir -p /etc/systemd/journald.conf.d
printf '[Journal]\nSystemMaxUse=100M\n' > /etc/systemd/journald.conf.d/size.conf
systemctl restart systemd-journald

echo "==> Caddy: HTTPS для $DOMAIN, статика и прокси /api на 127.0.0.1:3000"
cat > /etc/caddy/Caddyfile <<EOF
$DOMAIN {
	encode gzip
	handle_path /api/* {
		reverse_proxy 127.0.0.1:3000
	}
	handle {
		root * /srv/ark/web
		try_files {path} /index.html
		file_server
	}
}
EOF
systemctl enable caddy
systemctl restart caddy

echo "==> Firewall: только SSH (22), HTTP (80), HTTPS (443)"
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

echo
echo "Готово. Дальше: залей приложение (deploy.ps1) и заполни $APP/.env."
