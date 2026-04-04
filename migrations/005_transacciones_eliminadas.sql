-- 005_transacciones_eliminadas.sql
-- Audit trail de transacciones eliminadas para permitir restauración ("restablecer").
-- Guarda un snapshot completo de la fila antes de borrarla.

CREATE TABLE IF NOT EXISTS transacciones_eliminadas (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id   uuid NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  tx_id        uuid NOT NULL,
  snapshot     jsonb NOT NULL,
  deleted_at   timestamptz NOT NULL DEFAULT now(),
  restored_at  timestamptz
);

CREATE INDEX IF NOT EXISTS idx_tx_elim_usuario_deleted_at
  ON transacciones_eliminadas (usuario_id, deleted_at DESC)
  WHERE restored_at IS NULL;

ALTER TABLE transacciones_eliminadas ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tx_eliminadas_owner" ON transacciones_eliminadas;
CREATE POLICY "tx_eliminadas_owner" ON transacciones_eliminadas
  FOR ALL USING (usuario_id IN (
    SELECT id FROM usuarios WHERE supabase_auth_id = auth.uid()
  ));
