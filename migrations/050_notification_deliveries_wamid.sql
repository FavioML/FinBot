-- Migration 050: entrega real en notification_deliveries (wamid + statuses de Meta)
--
-- Motivo (barrido de churn 2026-07-31): `estado='sent'` significaba "Meta aceptó el
-- POST", no "le llegó al usuario". El webhook descartaba los callbacks de status
-- (value.statuses) porque no traen value.messages, y lib/whatsapp.js recibía el wamid
-- de Meta pero no lo guardaba, así que no había forma de cruzar un envío con su
-- entrega. Sin esto no se puede diagnosticar por qué el win-back tuvo 0% de respuesta
-- ni saber si los avisos de fin de trial (fuera de la ventana de 24h) llegan.
--
-- `estado` sigue siendo el resultado del POST; estas columnas son el resultado REAL
-- reportado por Meta después.

ALTER TABLE notification_deliveries ADD COLUMN IF NOT EXISTS wamid TEXT;
ALTER TABLE notification_deliveries ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ;
ALTER TABLE notification_deliveries ADD COLUMN IF NOT EXISTS read_at TIMESTAMPTZ;
ALTER TABLE notification_deliveries ADD COLUMN IF NOT EXISTS failed_at TIMESTAMPTZ;
ALTER TABLE notification_deliveries ADD COLUMN IF NOT EXISTS fail_code INTEGER;

-- Índice parcial: el webhook busca por wamid en cada callback de status. Las filas
-- previas a esta migración (y las de estado skipped_*/blocked_24h, que nunca
-- tuvieron wamid) quedan fuera del índice.
CREATE INDEX IF NOT EXISTS idx_notif_deliv_wamid ON notification_deliveries(wamid) WHERE wamid IS NOT NULL;

COMMENT ON COLUMN notification_deliveries.wamid IS
  'ID del mensaje en Meta (data.messages[0].id). Clave de cruce con los callbacks de status del webhook.';
COMMENT ON COLUMN notification_deliveries.delivered_at IS
  'Momento en que Meta reportó status=delivered. NULL = enviado pero sin confirmacion de entrega.';
COMMENT ON COLUMN notification_deliveries.read_at IS
  'Momento en que Meta reportó status=read (el usuario abrió el mensaje).';
