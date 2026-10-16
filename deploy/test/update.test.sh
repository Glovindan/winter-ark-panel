#!/usr/bin/env bash
# Проверка логики update.sh на заглушках (systemctl, curl, npm и т.п. подменены).
# Симлинки эмулируются файлом-указателем, чтобы тест шёл и под Git Bash на Windows:
# проверяется поток управления (деплой, откат, очистка), а не работа ОС с симлинками.
#   bash deploy/test/update.test.sh
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
UPDATE="$HERE/../server/update.sh"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT

export ARK_APP="$T/ark"
export ARK_HEALTH_URL="http://stub/health"
export T
BIN="$T/bin"
mkdir -p "$BIN" "$ARK_APP" "$T/var" "$T/work"
echo "DB_PATH=$T/var/ark.db" > "$ARK_APP/.env"
echo "data" > "$T/var/ark.db"
echo 0 > "$T/clock"

stub() { printf '#!/usr/bin/env bash\n%s\n' "$2" > "$BIN/$1"; chmod +x "$BIN/$1"; }
stub runuser 'shift 3; exec "$@"'
stub systemctl 'echo "$*" >> "$T/systemctl.log"'
stub journalctl 'true'
stub sleep 'true'
stub chown 'true'
stub flock 'true'
stub npm 'mkdir -p node_modules'
stub install 'for last; do :; done; mkdir -p "$last"'
stub python3 'cp "$2" "$3"'
# "симлинк" = файл с путём цели
stub ln 'for last; do :; done; src="${@: -2:1}"; printf "%s" "$src" > "$last"'
stub readlink 'f="${@: -1}"; [ -f "$f" ] && cat "$f" || exit 1'
# заглушка здоровья: релиз с файлом BAD считается неработающим
stub curl 'target="$(cat "$ARK_APP/current" 2>/dev/null)"; [ -n "$target" ] && [ ! -e "$target/BAD" ]'
# детерминированные идентификаторы релизов
stub date 'n=$(( $(cat "$T/clock") + 1 )); echo $n > "$T/clock"; printf "20260101-%06d\n" "$n"'
export PATH="$BIN:$PATH"

pass=0; failn=0
check() {
  if [ "$2" = "$3" ]; then pass=$((pass + 1)); echo "  ok   $1"
  else failn=$((failn + 1)); echo "  FAIL $1 (ожидалось '$3', получено '$2')"; fi
}
make_archive() { # make_archive <имя> [bad] [broken]
  local d="$T/work/$1"; rm -rf "$d"; mkdir -p "$d/apps/server/src" "$d/apps/web/dist"
  echo x > "$d/package.json"
  [ "${3:-}" = broken ] || echo x > "$d/apps/server/src/index.ts"
  echo x > "$d/apps/web/dist/index.html"
  [ "${2:-}" = bad ] && touch "$d/BAD"
  tar -czf "$T/work/$1.tgz" -C "$d" .
  echo "$T/work/$1.tgz"
}
current() { basename "$(cat "$ARK_APP/current" 2>/dev/null || echo none)"; }
releases() { ls -1 "$ARK_APP/releases" | wc -l | tr -d ' '; }
run() { bash "$UPDATE" "$1" >"$T/out.log" 2>&1; echo $?; }

echo "1. первый деплой без предыдущего релиза"
check "код возврата 0" "$(run "$(make_archive r1)")" 0
check "current указывает на релиз 1" "$(current)" "20260101-000001"
check "один релиз на диске" "$(releases)" 1

echo "2. второй деплой, снимается копия базы"
check "код возврата 0" "$(run "$(make_archive r2)")" 0
check "current на релизе 2" "$(current)" "20260101-000002"
check "копии базы сняты перед обоими деплоями" "$(ls "$T/var/backups"/pre-deploy-*.db 2>/dev/null | wc -l | tr -d ' ')" 2

echo "3. сломанный релиз откатывается"
: > "$T/systemctl.log"
check "код возврата 1" "$(run "$(make_archive r3 bad)")" 1
check "current остался на релизе 2" "$(current)" "20260101-000002"
check "сломанный релиз удалён" "$(releases)" 2
check "служба перезапускалась дважды (новый и откат)" "$(grep -c restart "$T/systemctl.log")" 2
check "в выводе есть откат на релиз 2" "$(grep -c 'Откат на 20260101-000002' "$T/out.log")" 1

echo "4. архив без серверного кода отклоняется"
check "код возврата 1" "$(run "$(make_archive r4 ok broken)")" 1
check "current не изменился" "$(current)" "20260101-000002"
check "лишних релизов нет" "$(releases)" 2

echo "5. пустой архив отклоняется"
: > "$T/empty.tgz"
check "код возврата 1" "$(run "$T/empty.tgz")" 1

echo "6. очистка: остаются 3 последних релиза"
for i in 5 6 7 8; do run "$(make_archive "r$i")" >/dev/null; done
check "релизов на диске" "$(releases)" 3
check "current на самом свежем" "$(current)" "$(ls -1 "$ARK_APP/releases" | sort | tail -n1)"
check "копий базы не больше 5" "$(ls "$T/var/backups"/pre-deploy-*.db | wc -l | tr -d ' ')" 5

echo
echo "Итого: ok=$pass, fail=$failn"
[ "$failn" -eq 0 ]
