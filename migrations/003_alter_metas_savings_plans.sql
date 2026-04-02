-- Migration: Evolve metas_ahorro into savings_plans
-- Already executed via Supabase MCP

ALTER TABLE metas_ahorro ADD COLUMN IF NOT EXISTS monthly_quota NUMERIC(12,2);
ALTER TABLE metas_ahorro ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'active'
  CHECK (status IN ('active', 'completed', 'abandoned'));
ALTER TABLE metas_ahorro ADD COLUMN IF NOT EXISTS space_id UUID;
ALTER TABLE metas_ahorro ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();

-- Backfill
UPDATE metas_ahorro SET status = CASE WHEN completada THEN 'completed' ELSE 'active' END
WHERE status IS NULL;

UPDATE metas_ahorro
SET monthly_quota = CASE
  WHEN fecha_limite IS NOT NULL AND completada = false
  THEN CEIL((monto_objetivo - COALESCE(monto_actual, 0)) /
    GREATEST(1, EXTRACT(MONTH FROM AGE(fecha_limite::date, CURRENT_DATE))))
  ELSE NULL
END
WHERE monthly_quota IS NULL AND fecha_limite IS NOT NULL;
