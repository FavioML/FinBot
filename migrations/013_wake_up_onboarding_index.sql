-- Migration 013: extender el unique partial index para incluir wake_up_onboarding
-- como one-shot por usuario (igual que webapp_invite_10tx, feedback_open_30tx,
-- nps_inapp, wake_up_inactive).

DROP INDEX IF EXISTS uq_survey_events_user_oneshot;

CREATE UNIQUE INDEX uq_survey_events_user_oneshot
  ON survey_events (user_id, event_type)
  WHERE event_type IN (
    'webapp_invite_10tx',
    'feedback_open_30tx',
    'nps_inapp',
    'wake_up_inactive',
    'wake_up_onboarding'
  );

COMMENT ON INDEX uq_survey_events_user_oneshot IS
  'Idempotencia: cada user recibe webapp_invite_10tx, feedback_open_30tx, nps_inapp, wake_up_inactive y wake_up_onboarding solo UNA vez en su vida util.';
