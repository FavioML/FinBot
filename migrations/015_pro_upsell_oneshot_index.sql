-- Migration 015: extender uq_survey_events_user_oneshot para incluir pro_upsell_d28
-- como one-shot. inactivity_reminder NO entra al unique porque es recurrente.

DROP INDEX IF EXISTS uq_survey_events_user_oneshot;

CREATE UNIQUE INDEX uq_survey_events_user_oneshot
  ON survey_events (user_id, event_type)
  WHERE event_type IN (
    'webapp_invite_10tx',
    'feedback_open_30tx',
    'nps_inapp',
    'wake_up_inactive',
    'wake_up_onboarding',
    'pro_upsell_d28'
  );

COMMENT ON INDEX uq_survey_events_user_oneshot IS
  'Idempotencia one-shot: webapp_invite_10tx, feedback_open_30tx, nps_inapp, wake_up_inactive, wake_up_onboarding, pro_upsell_d28. inactivity_reminder es recurrente (no entra al unique).';
