#!/usr/bin/env bash
# Раскатывает собранный архив приложения. Запускать от root: bash update.sh /tmp/ark-deploy.tgz
set -euo pipefail

TGZ="${1:?Укажи путь к архиву}"
APP=/opt/ark

[ -f "$APP/.env" ] || { echo "Нет $APP/.env: сначала выполни setup.sh"; exit 1; }

echo "==> Распаковка (node_modules и .env сохраняются)"
find "$APP" -mindepth 1 -maxdepth 1 ! -name node_modules ! -name .env -exec rm -rf {} +
tar -xzf "$TGZ" -C "$APP"
chown -R ark:ark "$APP"

echo "==> Зависимости сервера"
cd "$APP"
runuser -u ark -- env HOME="$APP" npm ci --omit=dev --workspace=@ark/server --no-audit --no-fund

echo "==> Фронтенд"
rm -rf /srv/ark/web/*
cp -r "$APP/apps/web/dist/." /srv/ark/web/
chmod -R a+rX /srv/ark/web
rm -rf "$APP/apps/web/dist"

echo "==> Перезапуск"
systemctl restart ark
sleep 3
systemctl --no-pager --lines=12 status ark || true
curl -fsS http://127.0.0.1:3000/health && echo " <- API отвечает"
rm -f "$TGZ"
