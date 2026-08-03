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
DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1

[ -f "$BACKUP_ENV" ] || { echo "No encuentro $BACKUP_ENV" >&2; exit 2; }

# Lee una clave de un archivo .env sin evaluarlo (evita sorpresas con $ y comillas).
leer() { sed -n "s/^$1=//p" "$2" 2>/dev/null | head -1 | tr -d '\r'; }

# Solo para el dry-run: confirma que el valor existe y es plausible sin revelarlo.
huella() { printf '%s' "$1" | wc -c | tr -d ' '; }

FALTANTES=0
# poner_secret <nombre> <valor> [opcional]
poner_secret() {
  local nombre="$1" valor="$2" opcional="${3:-}"
  if [ -z "$valor" ]; then
    if [ -n "$opcional" ]; then
      echo "  omito  $nombre (opcional, no lo encontre)"
    else
      echo "  FALTA  $nombre"; FALTANTES=$((FALTANTES + 1))
    fi
    return
  fi
  if [ "$DRY" = "1" ]; then
    echo "  listo  $nombre ($(huella "$valor") caracteres)"
    return
  fi
  # `gh secret set` lee el valor de stdin cuando no se pasa --body. Se hace asi
  # y no con --body "$valor" para que el secreto no aparezca en la linea de
  # comandos (visible en el historial del shell y en la lista de procesos).
  # Ojo: --body-file no existe para secrets, solo para issues/releases.
  printf '%s' "$valor" | gh secret set "$nombre" --repo "$REPO"
  echo "  ok     $nombre"
}

echo "==> Secrets en ${REPO}"
for k in SUPABASE_DB_URL SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY \
         R2_ACCOUNT_ID R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_BUCKET; do
  poner_secret "$k" "$(leer "$k" "$BACKUP_ENV")"
done

# Para el aviso de fallo por Telegram. Viven en Railway, no en backup.env, asi
# que normalmente no estaran aca. Son OPCIONALES: sin ellos el workflow
# simplemente no avisa por ese canal, y GitHub igual manda correo cuando un
# workflow programado falla. Para tenerlos, copiar los dos valores de Railway
# al .env local y volver a correr este script.
for k in TELEGRAM_BOT_TOKEN TELEGRAM_ADMIN_CHAT_ID; do
  poner_secret "$k" "$(leer "$k" "$APP_ENV")" opcional
done

# La clave publica de age NO es secreto: es publica por diseno. Va como
# variable para que se pueda leer de un vistazo y comprobar que es la correcta.
echo "==> Variables"
CLAVE_PUB="${AGE_PUBLIC_KEY:-age1t38efyfp55sfl7q98vdp8m4dh5qth04kltz8ttagyxxyv0uqsvqq9kd5xq}"
if [ "$DRY" = "1" ]; then
  echo "  listo  AGE_PUBLIC_KEY = ${CLAVE_PUB}"
else
  # La clave publica no es secreto, pero se pasa por stdin igual por coherencia.
  printf '%s' "$CLAVE_PUB" | gh variable set AGE_PUBLIC_KEY --repo "$REPO"
  echo "  ok     AGE_PUBLIC_KEY = ${CLAVE_PUB}"
fi

echo
if [ "$FALTANTES" -gt 0 ]; then
  echo "Hay ${FALTANTES} valor(es) que no encontre. Revisa ${BACKUP_ENV}."
  exit 1
fi

if [ "$DRY" = "1" ]; then
  echo "Prueba OK: todos los valores estan. Para cargarlos de verdad, corre el"
  echo "mismo comando sin --dry-run."
else
  echo "Listo. Disparar el backup a mano:"
  echo "  gh workflow run 'Backup DB' --repo ${REPO}"
fi
