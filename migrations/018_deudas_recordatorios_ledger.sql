-- Migration 018: ledger de recordatorios enviados por deuda
--
-- Motivo (audit 2026-07-03, T4): checkRecordatorioDeudas disparaba cada touch (3d/1d/hoy/-3d)
-- por match EXACTO de diffDias (.eq). Si el cron se caía justo ese día, ese touch se perdía sin
-- reintento. Esta columna registra qué touches ya se enviaron por deuda, permitiendo catch-up
-- (si se perdió el de 3 días, se manda el día 2) sin duplicar.

ALTER TABLE deudas
  ADD COLUMN IF NOT EXISTS recordatorios_enviados JSONB NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN deudas.recordatorios_enviados IS
  'Array de touches de recordatorio ya enviados para esta deuda: ["v3","v1","v0","p3"] (3d antes, 1d antes, día 0, 3d después). Permite catch-up sin duplicar. Se resetea al avanzar una deuda recurrente.';
