#!/usr/bin/env bash
#
# Sube de vuelta a Supabase Storage los archivos de un backup ya descifrado.
#
# Los comprobantes de pago Yape son archivos, no filas: data_supabase.sql
# restaura la METADATA (storage.objects) pero no el contenido. Sin este paso
# la tabla apunta a archivos que no existen.
#
# Uso:
#   restore-storage.sh <directorio-del-backup-descifrado>
#
# Variables: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (del proyecto DESTINO).
#
set -euo pipefail

BK="${1:-}"
[ -n "$BK" ] && [ -d "${BK}/storage" ] || {
  echo "Uso: restore-storage.sh <dir-backup-descifrado>" >&2; exit 2; }

for v in SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY; do
  [ -n "${!v:-}" ] || { echo "FALTA la variable $v" >&2; exit 2; }
done

echo "==> Restaurando archivos de Storage hacia ${SUPABASE_URL}"

SUBIDOS=0
FALLIDOS=0

# El primer nivel bajo storage/ es el bucket; el resto es la ruta del objeto.
while IFS= read -r archivo; do
  rel="${archivo#"${BK}/storage/"}"
  bucket="${rel%%/*}"
  nombre="${rel#*/}"

  # x-upsert deja el script ser idempotente: se puede reintentar sin limpiar.
  codigo=$(curl -sS -o /dev/null -w '%{http_code}' \
    -X POST "${SUPABASE_URL}/storage/v1/object/${bucket}/${nombre}" \
    -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}" \
    -H "x-upsert: true" \
    --data-binary "@${archivo}")

  if [ "$codigo" = "200" ] || [ "$codigo" = "201" ]; then
    SUBIDOS=$((SUBIDOS + 1))
  else
    echo "  FALLA ${bucket}/${nombre}: HTTP ${codigo}" >&2
    FALLIDOS=$((FALLIDOS + 1))
  fi
done < <(find "${BK}/storage" -type f)

echo "    ${SUBIDOS} subidos, ${FALLIDOS} fallidos"

# Si el bucket no existia en el destino, todo falla con 404 y hay que crearlo
# antes (data_supabase.sql restaura storage.buckets, asi que aplicalo primero).
if [ "$FALLIDOS" -gt 0 ]; then
  echo "Revisa que el bucket exista en el proyecto destino (data_supabase.sql lo crea)." >&2
  exit 1
fi

echo "OK archivos de Storage restaurados"
