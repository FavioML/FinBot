-- Migración 078 (27-ago-2026): `in_app` como canal de survey_events.
--
-- ── Por qué hace falta ────────────────────────────────────────────────────────────────────
--
-- `checkRecordatorioDiario` dejó de cortar a quien no tiene número (item 14: el corte no
-- protegía nada y solo le apagaba la campana a 14 usuarios reales, los 14 con cuenta web).
-- Sus avisos ahora pueden salir SOLO por la campana, y la fila de `survey_events` que escribe
-- no es un audit trail: es el DEDUP que leen el anti-fatiga de 3 días del propio cron y
-- `recibioMensajeRecienteProactivo`, que gatea los ocho triggers de `survey-triggers.js`
-- durante 7 días.
--
-- Escribir `channel = 'whatsapp'` sobre un aviso que salió solo in-app hace mentir a la
-- columna de la que dependen esos dos dedup. Por eso el código escribe el canal REAL, y por
-- eso el enum necesita el valor.
--
-- ── Cómo se descubrió, que es la parte que conviene no repetir ─────────────────────────────
--
-- `survey_events.channel` **es un enum** (`survey_channel`), no un `text` libre — a diferencia
-- de `notification_deliveries.canal`, que sí es text con default. El código se escribió
-- asumiendo lo segundo, la suite entera pasó en verde (los guards son estáticos y los dobles
-- de Supabase no validan enums), y el fallo apareció recién al consultar producción DESPUÉS
-- del deploy: `22P02: invalid input value for enum survey_channel: "in_app"`.
--
-- Falla CERRADO, que es lo único bueno del asunto: el insert va ANTES del envío, así que un
-- error deja al usuario sin aviso (igual que antes del cambio) en vez de mandarle algo sin
-- marca. Nadie quedó peor que ayer; el arreglo simplemente no funcionaba todavía.
--
-- ── Por qué NO se reusa 'webapp' ──────────────────────────────────────────────────────────
--
-- `webapp` es lo que usa `nps_inapp`: una encuesta que se MUESTRA cuando la persona ya está
-- adentro de la app. Eso no es un empuje, y por eso `CANALES_EMPUJE` lo excluye a propósito de
-- la ventana de fatiga. Usarlo acá sería lo peor de los dos mundos: el dedup de 3 días no
-- encontraría su propia marca (no está en el conjunto) y el recordatorio de inactividad
-- saldría **todos los días** a quien no tiene número.

ALTER TYPE survey_channel ADD VALUE IF NOT EXISTS 'in_app';

COMMENT ON TYPE survey_channel IS
  'Canal por el que salió un survey_event. `whatsapp` e `in_app` cuentan como EMPUJE y gastan '
  'la ventana de anti-fatiga (ver CANALES_EMPUJE en cron/checks.js y services/survey-triggers.js). '
  '`webapp` NO: es la encuesta in-app que se muestra a quien ya está dentro de la app.';
