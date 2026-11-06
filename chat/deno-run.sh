#!/usr/bin/env bash
# Стартира Edge Function `chat` локално, без Docker — директно през Deno.
# Слуша на http://localhost:8000. Секретите идват от .env.local (не се комитва).
set -euo pipefail

cd "$(dirname "$0")/supabase/functions/chat"

if [[ ! -f ../.env.local ]]; then
  echo "Липсва ../.env.local — копирай ../.env.example и попълни стойностите." >&2
  exit 1
fi

exec deno run \
  --allow-env --allow-net --allow-read \
  --env-file=../.env.local \
  index.ts
