-- Migration 012: agregar wake_up_onboarding al enum.
-- Trigger one-shot para usuarios que se registraron pero NO completaron
-- onboarding y llevan 7+ dias sin avanzar (vs el cron checkRecordatorioOnboarding
-- existente que solo dispara entre 3-6h post-registro).

ALTER TYPE survey_event_type ADD VALUE IF NOT EXISTS 'wake_up_onboarding';
