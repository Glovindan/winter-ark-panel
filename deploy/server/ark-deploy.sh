#!/usr/bin/env bash
# Принудительная команда для SSH-ключа CI (прописывается в authorized_keys через install-ci.sh).
# Принимает tar.gz релиза из stdin и раскатывает его. Другого доступа по этому ключу нет.
set -euo pipefail

TGZ="$(mktemp /tmp/ark-deploy.XXXXXX.tgz)"
trap 'rm -f "$TGZ"' EXIT

# Ограничение размера: 200 МБ
head -c 200000000 > "$TGZ"
[ -s "$TGZ" ] || { echo "Пустой архив" >&2; exit 1; }

/usr/local/lib/ark/update.sh "$TGZ"
