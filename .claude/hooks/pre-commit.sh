#!/usr/bin/env bash
# Pre-commit gate para neto/app (Node backend + Next.js webapp)
# Exit 2 = bloquea. Exit 0 = permite.

set -e
ROOT="$(git rev-parse --show-toplevel 2>/dev/null || echo .)"
cd "$ROOT"

CHANGED=$(git diff --cached --name-only --diff-filter=ACM)
if [[ -z "$CHANGED" ]]; then
  echo "[pre-commit] no staged files, skip"
  exit 0
fi

# Backend: si cambio algo fuera de webapp/, correr vitest del backend
if echo "$CHANGED" | grep -vE '^webapp/' | grep -qE '\.(js|cjs|mjs)$'; then
  echo "[pre-commit] backend tests..."
  npm test --silent || { echo "[pre-commit] vitest FAILED"; exit 2; }
fi

# Webapp Next.js: si cambio algo dentro de webapp/, correr lint + tsc
if echo "$CHANGED" | grep -qE '^webapp/.*\.(ts|tsx|js|jsx)$'; then
  echo "[pre-commit] webapp typecheck + lint..."
  (cd webapp && npx tsc --noEmit) || { echo "[pre-commit] webapp tsc FAILED"; exit 2; }
  (cd webapp && npm run lint --silent) || { echo "[pre-commit] webapp lint FAILED"; exit 2; }
fi

echo "[pre-commit] OK"
exit 0
