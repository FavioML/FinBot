-- Migration 017: notification_deliveries
-- Log de ENTREGA REAL de notificaciones salientes (WhatsApp free-form / template).
--
-- Motivo (audit 2026-07-03): lib/whatsapp.js tragaba los errores de Meta y no retornaba
-- estado, por lo que survey_events.sent_at marcaba "enviado" aunque Meta bloqueara el
-- mensaje (error 131047, ventana de 24h cerrada). Sin registro de fallo no había forma de
-- saber qué le llegaba al usuario. Esta tabla es la fuente de verdad de entrega:
-- una fila por cada intento de envío proactivo, con el estado real reportado por Meta.

CREATE TABLE IF NOT EXISTS notification_deliveries (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  usuario_id UUID REFERENCES usuarios(id) ON DELETE CASCADE,
  tipo TEXT,                                  -- 'inactivity', 'pro_upsell_d28', 'premium_expiry_3d',
                                              -- 'premium_expired', 'deuda', 'score_semanal',
                                              -- 'resumen_semanal', 'resumen_mensual', 'fugas',
                                              -- 'checkin_planes', 'espacios', 'alerta_presupuesto',
                                              -- 'survey_<event_type>', ...
  canal TEXT NOT NULL DEFAULT 'whatsapp',     -- 'whatsapp' | 'whatsapp_template' | ...
  estado TEXT NOT NULL,                        -- 'sent' | 'blocked_24h' | 'error' | 'skipped_test'
  code INTEGER,                                -- código de error de Meta (131047, ...) o null
  error TEXT,                                  -- descripción corta del error o null
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Índices para las queries del audit / panel (por usuario y por estado)
CREATE INDEX IF NOT EXISTS idx_notif_deliv_usuario ON notification_deliveries(usuario_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notif_deliv_estado ON notification_deliveries(estado, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notif_deliv_tipo ON notification_deliveries(tipo, created_at DESC);

-- RLS deny-all intencional: backend-only, solo service-role la escribe/lee. Sin policy a propósito.
ALTER TABLE notification_deliveries ENABLE ROW LEVEL SECURITY;
GRANT ALL ON notification_deliveries TO service_role;

COMMENT ON TABLE notification_deliveries IS
  'RLS deny-all intencional (2026-07-03): backend-only service-role. Log de entrega real de notificaciones salientes (WhatsApp/template). Fuente de verdad de qué le llegó al usuario. Sin policy a proposito.';
