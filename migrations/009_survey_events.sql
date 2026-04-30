-- Migration: Create survey_events table for engagement system
-- Captura los 4 sistemas de UPDATE-05:
--   1. Recordatorios de uso (WhatsApp): reminder_d3, reminder_d7, reminder_d14, reminder_d30
--   2. Webapp invite a los 10 tx (WhatsApp): webapp_invite_10tx
--   3. Feedback abierto a los 30 tx (WhatsApp): feedback_open_30tx
--   4. NPS-light in-app (webapp): nps_inapp
--
-- Diseno: una sola tabla generica con event_type. Schema flexible via response_data JSONB
-- para que cada tipo guarde lo que necesita sin migrations futuras.

-- ===== Enum =====

DO $$ BEGIN
  CREATE TYPE survey_event_type AS ENUM (
    'reminder_d3',
    'reminder_d7',
    'reminder_d14',
    'reminder_d30',
    'webapp_invite_10tx',
    'feedback_open_30tx',
    'nps_inapp'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE survey_channel AS ENUM ('whatsapp', 'webapp');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- ===== Table =====

CREATE TABLE IF NOT EXISTS survey_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  event_type survey_event_type NOT NULL,
  channel survey_channel NOT NULL,

  -- Timing
  triggered_at TIMESTAMPTZ NOT NULL DEFAULT now(),  -- cuando el cron/UI evaluo el trigger
  sent_at TIMESTAMPTZ,                              -- cuando se mando el mensaje (whatsapp) o se mostro la card (webapp)
  responded_at TIMESTAMPTZ,                         -- cuando el user respondio
  dismissed_at TIMESTAMPTZ,                         -- (solo NPS in-app) cuando hizo dismiss sin responder

  -- Contenido
  message_sent TEXT,                                -- el mensaje exacto enviado (whatsapp) o null para nps_inapp
  response_data JSONB,                              -- estructura varia por event_type:
  -- reminder_*       : { user_replied: bool, reply_text?: string }
  -- webapp_invite    : { logged_in_webapp_within_7d: bool }
  -- feedback_open    : { reply_text: string }
  -- nps_inapp        : { ease: 1-5, usefulness: 1-5, recommend: 1-5, comment?: string }

  -- Conversion tracking
  conversion_within_24h BOOLEAN DEFAULT false,      -- (recordatorios) usuario registro tx en 24h post-mensaje
  conversion_within_7d BOOLEAN DEFAULT false,       -- (webapp_invite) usuario logueo en webapp en 7d
  opted_out_after BOOLEAN DEFAULT false,            -- usuario respondio /silenciar tras este mensaje

  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ===== Indexes =====

-- Idempotencia: para los event_types one-shot, no debe existir mas de una row por (user_id, event_type)
-- Lo enforzamos con un unique partial index en los one-shot:
CREATE UNIQUE INDEX IF NOT EXISTS uq_survey_events_user_oneshot
  ON survey_events (user_id, event_type)
  WHERE event_type IN ('webapp_invite_10tx', 'feedback_open_30tx', 'nps_inapp');

-- Para los reminders (que pueden recurrir en distintos dias), permitimos multiples por user
-- pero indexamos por user+type+sent_at para queries rapidos
CREATE INDEX IF NOT EXISTS idx_survey_events_user_type
  ON survey_events (user_id, event_type, sent_at DESC);

-- Cron query: filas pendientes de envio o de evaluar conversion
CREATE INDEX IF NOT EXISTS idx_survey_events_pending
  ON survey_events (sent_at)
  WHERE responded_at IS NULL;

-- Admin queries: agrupar por tipo + fecha
CREATE INDEX IF NOT EXISTS idx_survey_events_type_date
  ON survey_events (event_type, sent_at DESC);

-- ===== RLS =====

ALTER TABLE survey_events ENABLE ROW LEVEL SECURITY;

-- Service role (cron + API admin) tiene full access
CREATE POLICY "Service role full access on survey_events"
  ON survey_events FOR ALL
  USING (true)
  WITH CHECK (true);

-- Authenticated users solo ven y escriben sus propios survey events (para NPS in-app que escribe desde webapp)
CREATE POLICY "Users can read own survey events"
  ON survey_events FOR SELECT
  TO authenticated
  USING (
    user_id IN (
      SELECT id FROM usuarios WHERE supabase_auth_id = auth.uid()
    )
  );

CREATE POLICY "Users can insert own survey events"
  ON survey_events FOR INSERT
  TO authenticated
  WITH CHECK (
    user_id IN (
      SELECT id FROM usuarios WHERE supabase_auth_id = auth.uid()
    )
  );

CREATE POLICY "Users can update own survey events"
  ON survey_events FOR UPDATE
  TO authenticated
  USING (
    user_id IN (
      SELECT id FROM usuarios WHERE supabase_auth_id = auth.uid()
    )
  );

GRANT ALL ON survey_events TO service_role;
GRANT SELECT, INSERT, UPDATE ON survey_events TO authenticated;

-- ===== Comments =====

COMMENT ON TABLE survey_events IS
  'Engagement events: recordatorios de uso, invitaciones webapp, feedback abierto, NPS in-app. UPDATE-05.';

COMMENT ON COLUMN survey_events.event_type IS
  'reminder_d3/d7/d14/d30: WhatsApp recordatorios uso. webapp_invite_10tx: invita a usar app.neto.pe. feedback_open_30tx: pregunta abierta WhatsApp. nps_inapp: 3 preguntas escala 1-5 en webapp.';

COMMENT ON COLUMN survey_events.response_data IS
  'JSONB. Estructura varia por event_type. Ver migration SQL para schema esperado.';

COMMENT ON INDEX uq_survey_events_user_oneshot IS
  'Idempotencia: garantiza que cada user reciba webapp_invite_10tx, feedback_open_30tx y nps_inapp solo UNA vez.';
