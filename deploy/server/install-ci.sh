#!/usr/bin/env bash
# Переводит сервер на релизную схему и ставит инструменты деплоя. Безопасно запускать повторно.
# Запуск от root, из папки со скриптами:  bash install-ci.sh ["<публичный SSH-ключ CI>"]
#
# Что делает:
#   1. ставит /usr/local/lib/ark/update.sh и /usr/local/bin/ark-deploy (принадлежат root, CI их менять не может);
#   2. однократно переносит текущую установку в /opt/ark/releases/0000-legacy и создаёт симлинк current
#      (короткий простой на пару секунд; при неудаче всё возвращается назад);
#   3. направляет systemd-службу и Caddy на /opt/ark/current;
#   4. если передан ключ CI, разрешает ему ТОЛЬКО команду ark-deploy.
set -euo pipefail

APP=/opt/ark
HERE="$(cd "$(dirname "$0")" && pwd)"
CI_KEY="${1:-}"
UNIT=/etc/systemd/system/ark.service
CADDYFILE=/etc/caddy/Caddyfile
LEGACY="$APP/releases/0000-legacy"
LEGACY_ITEMS=(package.json package-lock.json tsconfig.base.json apps packages node_modules)

log() { echo "==> $*"; }
fail() { echo "ОШИБКА: $*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || fail "запусти от root"
[ -f "$APP/.env" ] || fail "нет $APP/.env, сначала setup.sh"
[ -f "$HERE/update.sh" ] && [ -f "$HERE/ark-deploy.sh" ] || fail "рядом со скриптом нет update.sh и ark-deploy.sh"

wait_health() {
  for _ in $(seq 1 30); do
    curl -fsS -m 3 http://127.0.0.1:3000/health >/dev/null 2>&1 && return 0
    sleep 1
  done
  return 1
}

log "Устанавливаю скрипты деплоя"
install -d -o root -g root -m 755 /usr/local/lib/ark
install -o root -g root -m 755 "$HERE/update.sh" /usr/local/lib/ark/update.sh
install -o root -g root -m 755 "$HERE/ark-deploy.sh" /usr/local/bin/ark-deploy

apply_paths() {
  sed -i 's#/opt/ark/apps/server#/opt/ark/current/apps/server#g; s#/opt/ark/node_modules#/opt/ark/current/node_modules#g' "$UNIT"
  sed -i 's#/srv/ark/web#/opt/ark/current/apps/web/dist#g' "$CADDYFILE"
}

if [ -L "$APP/current" ]; then
  log "Релизная схема уже включена"
  cp -n "$UNIT" "$UNIT.bak" 2>/dev/null || true
  apply_paths
  systemctl daemon-reload
  caddy validate --config "$CADDYFILE" >/dev/null && systemctl reload caddy
else
  log "Миграция на релизную схему (простой на несколько секунд)"
  cp "$UNIT" "$UNIT.bak"
  cp "$CADDYFILE" "$CADDYFILE.bak"

  revert() {
    echo "Откатываю миграцию…" >&2
    systemctl stop ark || true
    rm -f "$APP/current"
    for f in "${LEGACY_ITEMS[@]}"; do [ -e "$LEGACY/$f" ] && mv "$LEGACY/$f" "$APP/"; done
    cp "$UNIT.bak" "$UNIT"
    cp "$CADDYFILE.bak" "$CADDYFILE"
    systemctl daemon-reload
    systemctl reload caddy || true
    systemctl start ark || true
  }

  systemctl stop ark
  mkdir -p "$LEGACY"
  for f in "${LEGACY_ITEMS[@]}"; do [ -e "$APP/$f" ] && mv "$APP/$f" "$LEGACY/"; done
  # статика жила в /srv/ark/web: кладём её в legacy-релиз, чтобы Caddy мог отдавать из current
  if [ -d /srv/ark/web ]; then
    mkdir -p "$LEGACY/apps/web"
    rm -rf "$LEGACY/apps/web/dist"
    cp -r /srv/ark/web "$LEGACY/apps/web/dist"
  fi
  ln -sfn "$LEGACY" "$APP/current"
  chown -R ark:ark "$APP/releases"
  apply_paths
  systemctl daemon-reload

  if caddy validate --config "$CADDYFILE" >/dev/null 2>&1 \
     && systemctl reload caddy \
     && systemctl start ark \
     && wait_health; then
    log "Миграция прошла, сервис работает"
  else
    revert
    fail "после миграции сервис не поднялся, всё возвращено как было"
  fi
fi

if [ -n "$CI_KEY" ]; then
  log "Разрешаю ключу CI только команду ark-deploy"
  case "$CI_KEY" in ssh-ed25519\ *|ssh-rsa\ *|ecdsa-sha2-*\ *) ;; *) fail "это не похоже на публичный SSH-ключ" ;; esac
  install -d -m 700 /root/.ssh
  touch /root/.ssh/authorized_keys
  chmod 600 /root/.ssh/authorized_keys
  KEY_BODY="$(echo "$CI_KEY" | awk '{print $2}')"
  if grep -qF "$KEY_BODY" /root/.ssh/authorized_keys; then
    echo "этот ключ уже добавлен"
  else
    echo "restrict,command=\"/usr/local/bin/ark-deploy\" $CI_KEY" >> /root/.ssh/authorized_keys
    echo "ключ добавлен с ограничением: только ark-deploy"
  fi
fi

log "Готово"
