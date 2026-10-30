#!/usr/bin/env bash
# Запуск для разработки: HTTPS-туннель cloudflared → бот с мини-аппом.
# Адрес туннеля меняется при каждом запуске, бот сам обновляет кнопку «Редактор».
set -euo pipefail
cd "$(dirname "$0")/.."
PORT=${PORT:-8080}
CF=${CLOUDFLARED:-$(command -v cloudflared || echo ./bin/cloudflared)}

if [ ! -x "$CF" ]; then
  echo "cloudflared не найден — запускаю бота без мини-аппа (фото → PDF работает)"
  exec .venv/bin/python -m app.main
fi

LOG=$(mktemp)
"$CF" tunnel --no-autoupdate --url "http://localhost:$PORT" >"$LOG" 2>&1 &
CF_PID=$!
trap 'kill $CF_PID 2>/dev/null; rm -f "$LOG"' EXIT

URL=""
for _ in $(seq 60); do
  URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG" | head -1 || true)
  [ -n "$URL" ] && break
  sleep 0.5
done
if [ -z "$URL" ]; then
  echo "Туннель не поднялся:"; cat "$LOG"; exit 1
fi

echo "Мини-апп: $URL"
WEBAPP_URL="$URL" .venv/bin/python -m app.main
