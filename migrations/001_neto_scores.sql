-- Migration: Create neto_scores table for Neto Score feature
-- Execute in Supabase SQL Editor

-- Table
CREATE TABLE IF NOT EXISTS neto_scores (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES usuarios(id) NOT NULL,
  score SMALLINT CHECK (score >= 0 AND score <= 100),
  factor_consistency SMALLINT CHECK (factor_consistency >= 0 AND factor_consistency <= 100),
  factor_budget SMALLINT CHECK (factor_budget >= 0 AND factor_budget <= 100),
  factor_savings SMALLINT CHECK (factor_savings >= 0 AND factor_savings <= 100),
  factor_goals SMALLINT CHECK (factor_goals >= 0 AND factor_goals <= 100),
  factor_debts SMALLINT CHECK (factor_debts >= 0 AND factor_debts <= 100),
  factor_visibility SMALLINT CHECK (factor_visibility >= 0 AND factor_visibility <= 100),
  calculated_at TIMESTAMPTZ DEFAULT now(),
  period DATE NOT NULL,
  UNIQUE(user_id, period)
);

-- Index for fast lookups
CREATE INDEX IF NOT EXISTS idx_neto_scores_user_period
  ON neto_scores (user_id, period DESC);

-- RLS: Enable
ALTER TABLE neto_scores ENABLE ROW LEVEL SECURITY;

-- RLS Policy: Users can only read their own scores
-- ⚠️ OBSOLETO: este USING es una tautología (user_id = user_id → siempre true) y NO
-- aísla por usuario. Reemplazado en prod el 2026-06-23 y reconciliado en el repo por
-- `019_neto_scores_rls_hardening.sql` (aislamiento real vía supabase_auth_id). No usar
-- esta versión en un rebuild limpio; correr la 019 después.
CREATE POLICY "Users can view own scores"
  ON neto_scores FOR SELECT
  USING (user_id = (
    SELECT id FROM usuarios WHERE id = user_id
  ));

-- RLS Policy: Service role can insert/update (for cron jobs)
CREATE POLICY "Service role can manage scores"
  ON neto_scores FOR ALL
  USING (true)
  WITH CHECK (true);

-- Grant access
GRANT SELECT ON neto_scores TO authenticated;
GRANT ALL ON neto_scores TO service_role;
