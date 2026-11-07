#!/usr/bin/env bash
# Пробен въпрос към локално стартираната функция `chat` (виж deno-run.sh).
# -N изключва буферирането, за да се виждат SSE събитията как идват.
set -euo pipefail

curl -N -sS -X POST http://localhost:8000 \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"При какви условия е разрешено лагеруването на плажа?"}]}'
