-- Migration: Create spending_alerts table for Detector de Fugas feature
-- Already executed via Supabase MCP

CREATE TABLE IF NOT EXISTS spending_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES usuarios(id) NOT NULL,
  type TEXT CHECK (type IN ('spike', 'ant', 'recurring', 'projection')),
  category TEXT,
  amount NUMERIC(12,2),
  comparison_amount NUMERIC(12,2),
  message TEXT,
  action_taken BOOLEAN DEFAULT false,
  limit_set NUMERIC(12,2),
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_spending_alerts_user
  ON spending_alerts (user_id, created_at DESC);

ALTER TABLE spending_alerts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own alerts"
  ON spending_alerts FOR SELECT
  USING (user_id IN (
    SELECT id FROM usuarios WHERE supabase_auth_id = auth.uid()
  ));

CREATE POLICY "Service role full access on spending_alerts"
  ON spending_alerts FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
