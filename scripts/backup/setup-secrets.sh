#!/usr/bin/env bash
#
# Carga en el repo los secrets que necesita .github/workflows/backup-db.yml,
# leyendolos de los archivos locales. Los valores van directo del archivo a
# `gh`; no se imprimen ni se pasan por la linea de comandos.
#
# Correr desde app/:  bash scripts/backup/setup-secrets.sh
#
# Volver a correrlo despues de rotar credenciales es la forma normal de
# actualizarlas: `gh secret set` sobreescribe.
#
set -euo pipefail

REPO="${REPO:-FavioML/FinBot}"
BACKUP_ENV="${BACKUP_ENV:-$HOME/.config/neto/backup.env}"
APP_ENV="${APP_ENV:-.env}"

[ -f "$BACKUP_ENV" ] || { echo "No encuentro $BACKUP_ENV" >&2; exit 2; }

# Lee una clave de un archivo .env sin evaluarlo (evita sorpresas con $ y comillas).
leer() { sed -n "s/^$1=//p" "$2" 2>/dev/null | head -1 | tr -d '\r'; }

poner_secret() {
  local nombre="$1" valor="$2"
  if [ -z "$valor" ]; then echo "  omitido $nombre (no lo encontre)"; return; fi
  printf '%s' "$valor" | gh secret set "$nombre" --repo "$REPO" --body-file -
  echo "  ok $nombre"
}

echo "==> Secrets en ${REPO}"
for k in SUPABASE_DB_URL SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY \
         R2_ACCOUNT_ID R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_BUCKET; do
  poner_secret "$k" "$(leer "$k" "$BACKUP_ENV")"
done

# Para el aviso de fallo por Telegram. Viven en Railway, no en backup.env; si
# no estan en el .env local el workflow simplemente no avisa por ese canal
# (GitHub igual manda correo cuando un workflow programado falla).
for k in TELEGRAM_BOT_TOKEN TELEGRAM_ADMIN_CHAT_ID; do
  poner_secret "$k" "$(leer "$k" "$APP_ENV")"
done

# La clave publica de age NO es secreto: es publica por diseno. Va como
# variable para que se pueda leer de un vistazo y comprobar que es la correcta.
echo "==> Variables"
CLAVE_PUB="${AGE_PUBLIC_KEY:-age1t38efyfp55sfl7q98vdp8m4dh5qth04kltz8ttagyxxyv0uqsvqq9kd5xq}"
gh variable set AGE_PUBLIC_KEY --repo "$REPO" --body "$CLAVE_PUB"
echo "  ok AGE_PUBLIC_KEY = ${CLAVE_PUB}"

echo
echo "Listo. Disparar el backup a mano:"
echo "  gh workflow run 'Backup DB' --repo ${REPO}"
