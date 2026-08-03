#!/usr/bin/env bash
#
# Manda a Telegram el resultado del backup diario.
#
# Uso:  notificar.sh ok | notificar.sh falla
#
# Nunca revienta el job: si Telegram no esta configurado o la API responde mal,
# lo dice y sale con 0. Un backup correcto que no se pudo notificar sigue
# siendo un backup correcto, y marcar el job en rojo por eso entrenaria a
# ignorar los rojos.
#
set -uo pipefail

ESTADO="${1:-ok}"

if [ -z "${TELEGRAM_BOT_TOKEN:-}" ] || [ -z "${TELEGRAM_ADMIN_CHAT_ID:-}" ]; then
  echo "Telegram no configurado (faltan TELEGRAM_BOT_TOKEN o TELEGRAM_ADMIN_CHAT_ID); no aviso."
  exit 0
fi

RUN_URL="https://github.com/${GITHUB_REPOSITORY:-FavioML/FinBot}/actions/runs/${GITHUB_RUN_ID:-}"

if [ "$ESTADO" = "falla" ]; then
  TEXTO="🔴 *Backup de Neto FALLO*

El backup diario de Supabase no se completo. Mientras esto no se arregle, la base NO tiene respaldo del dia.

[Ver el run](${RUN_URL})"
else
  # El resumen lo escribe backup.sh. Si no esta, se avisa igual pero sin cifras:
  # es preferible un mensaje pobre a ningun mensaje.
  if [ -n "${RESUMEN:-}" ] && [ -f "${RESUMEN}" ]; then
    TEXTO="$(node -e '
      const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      const mb = (r.peso / 1048576).toFixed(2);
      const e = r.estructura || {};
      const lineas = [
        "🟢 *Backup de Neto OK*",
        "",
        "`" + (r.objeto || "").replace(/^daily\//, "") + "`",
        "",
        `${r.tablas} tablas · ${r.filas.toLocaleString("es-PE")} filas · ${r.archivos} comprobantes`,
        `${mb} MB cifrados · ${r.retenidos} backups en R2`,
        `public: ${e.tablas} tablas (${e.tablas_rls} con RLS), ${e.policies} policies`,
      ];
      if (r.avisos && r.avisos.length) {
        lineas.push("", "⚠️ " + r.avisos.join("\n⚠️ "));
      }
      process.stdout.write(lineas.join("\n"));
    ' "$RESUMEN")"
  else
    TEXTO="🟢 *Backup de Neto OK*

Se completo, pero no encontre el resumen para darte las cifras.

[Ver el run](${RUN_URL})"
  fi
fi

RESPUESTA="$(curl -sS -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
  -d "chat_id=${TELEGRAM_ADMIN_CHAT_ID}" \
  -d "parse_mode=Markdown" \
  -d "disable_web_page_preview=true" \
  --data-urlencode "text=${TEXTO}" 2>&1)"

if printf '%s' "$RESPUESTA" | grep -q '"ok":true'; then
  echo "Avisado por Telegram."
else
  # Solo el motivo, sin volcar la respuesta entera (lleva el chat_id).
  echo "No pude avisar por Telegram: $(printf '%s' "$RESPUESTA" | sed -n 's/.*"description":"\([^"]*\)".*/\1/p')"
fi
exit 0
