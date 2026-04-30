-- Migration 011: extender el unique partial index para incluir wake_up_inactive
-- como one-shot. Va separada de migration 010 porque Postgres requiere commit
-- entre ALTER TYPE y uso del nuevo valor en una expresion (la del WHERE clause).

-- Drop el index viejo y recrear con wake_up_inactive incluido
DROP INDEX IF EXISTS uq_survey_events_user_oneshot;

CREATE UNIQUE INDEX uq_survey_events_user_oneshot
  ON survey_events (user_id, event_type)
  WHERE event_type IN (
    'webapp_invite_10tx',
    'feedback_open_30tx',
    'nps_inapp',
    'wake_up_inactive'
  );

COMMENT ON INDEX uq_survey_events_user_oneshot IS
  'Idempotencia: cada user recibe webapp_invite_10tx, feedback_open_30tx, nps_inapp y wake_up_inactive solo UNA vez en su vida util.';
