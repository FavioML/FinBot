-- Migration 014: agregar inactivity_reminder y pro_upsell_d28 al enum
--
-- inactivity_reminder: reemplaza el viejo "checkRecordatorioDiario" diario.
--   Nueva cadencia: 1 mensaje cada 3 dias de inactividad. Recurrente, NO one-shot.
--
-- pro_upsell_d28: el upsell a Pro tras 28-30 dias que estaba escondido dentro
--   de checkRecordatorioDiario. Migrado a survey_events para visibilidad en
--   /admin/surveys. One-shot por usuario.

ALTER TYPE survey_event_type ADD VALUE IF NOT EXISTS 'inactivity_reminder';
ALTER TYPE survey_event_type ADD VALUE IF NOT EXISTS 'pro_upsell_d28';
