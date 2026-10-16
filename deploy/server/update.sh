#!/usr/bin/env bash
# Раскатывает новый релиз из архива. Запускать от root: update.sh <архив.tgz>
#
# Схема: /opt/ark/releases/<время> + симлинк /opt/ark/current. Новый релиз ставится рядом со старым,
# перед переключением снимается копия БД, после перезапуска проверяется /health;
# если сервис не поднялся, симлинк возвращается на прошлый релиз.
set -euo pipefail

APP="${ARK_APP:-/opt/ark}"
HEALTH_URL="${ARK_HEALTH_URL:-http://127.0.0.1:3000/health}"
KEEP_RELEASES=3
KEEP_SNAPSHOTS=5

TGZ="${1:?Укажи архив: update.sh <архив.tgz>}"
REL="$APP/releases"
ID="$(date +%Y%m%d-%H%M%S)"
DIR="$REL/$ID"

log() { echo "==> $*"; }
fail() { echo "ОШИБКА: $*" >&2; exit 1; }

wait_health() {
  for _ in $(seq 1 30); do
    if curl -fsS -m 3 "$HEALTH_URL" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  return 1
}

[ -f "$APP/.env" ] || fail "нет $APP/.env, сначала выполни setup.sh"
[ -s "$TGZ" ] || fail "архив пустой или не найден: $TGZ"

# Один деплой за раз
mkdir -p "$REL"
exec 9>"$APP/.deploy.lock"
flock -n 9 || fail "другой деплой уже идёт"

# Если что-то пойдёт не так, недоустановленный релиз не оставляем
ok=0
trap '[ "$ok" = 1 ] || rm -rf "$DIR"' EXIT

log "Распаковка релиза $ID (от имени ark)"
install -d -o ark -g ark "$DIR"
# архив создан от root (mktemp даёт 600), а распаковывает его пользователь ark
chmod a+r "$TGZ"
runuser -u ark -- tar -xzf "$TGZ" -C "$DIR"
[ -f "$DIR/apps/server/src/index.ts" ] || fail "в архиве нет серверного кода"
[ -f "$DIR/apps/web/dist/index.html" ] || fail "в архиве нет собранного фронтенда"

log "Зависимости сервера"
runuser -u ark -- env HOME="$APP" sh -c "cd '$DIR' && npm ci --omit=dev --workspace=@ark/server --no-audit --no-fund"

DB_PATH="$(grep -E '^DB_PATH=' "$APP/.env" | tail -n1 | cut -d= -f2- || true)"
DB_PATH="${DB_PATH:-/var/lib/ark/ark.db}"
if [ -f "$DB_PATH" ]; then
  log "Копия базы перед деплоем"
  SNAP_DIR="$(dirname "$DB_PATH")/backups"
  mkdir -p "$SNAP_DIR"
  SNAP="$SNAP_DIR/pre-deploy-$ID.db"
  if command -v python3 >/dev/null 2>&1 \
     && python3 - "$DB_PATH" "$SNAP" <<'PY'
import sqlite3, sys
src = sqlite3.connect(sys.argv[1])
dst = sqlite3.connect(sys.argv[2])
src.backup(dst)
dst.close()
src.close()
PY
  then
    chown ark:ark "$SNAP" 2>/dev/null || true
    echo "копия: $SNAP"
    # храним последние несколько
    # shellcheck disable=SC2012
    ls -1t "$SNAP_DIR"/pre-deploy-*.db 2>/dev/null | tail -n +$((KEEP_SNAPSHOTS + 1)) | xargs -r rm -f
  else
    echo "ПРЕДУПРЕЖДЕНИЕ: копию базы сделать не удалось, продолжаю без неё" >&2
  fi
fi

PREV="$(readlink -f "$APP/current" 2>/dev/null || true)"

log "Переключение на новый релиз"
ln -sfn "$DIR" "$APP/current.new"
mv -T "$APP/current.new" "$APP/current"

log "Перезапуск"
systemctl restart ark
if wait_health; then
  ok=1
  log "Сервис поднялся, релиз $ID активен"
else
  echo "ОШИБКА: сервис не ответил на $HEALTH_URL за 30 секунд" >&2
  journalctl -u ark --no-pager -n 25 2>/dev/null || true
  if [ -n "$PREV" ] && [ -d "$PREV" ]; then
    log "Откат на $(basename "$PREV")"
    ln -sfn "$PREV" "$APP/current.new"
    mv -T "$APP/current.new" "$APP/current"
    systemctl restart ark
    if wait_health; then
      echo "Откат выполнен, работает прошлый релиз. Новый релиз не принят." >&2
    else
      echo "КРИТИЧНО: после отката сервис тоже не отвечает, нужен ручной разбор" >&2
    fi
  else
    echo "Прошлого релиза нет, откатываться некуда" >&2
  fi
  exit 1
fi

log "Очистка старых релизов (оставляю $KEEP_RELEASES)"
CUR="$(readlink -f "$APP/current")"
# shellcheck disable=SC2012
ls -1 "$REL" | sort -r | tail -n +$((KEEP_RELEASES + 1)) | while read -r old; do
  [ "$REL/$old" = "$CUR" ] || rm -rf "${REL:?}/$old"
done

systemctl --no-pager --lines=5 status ark || true
