-- 030: CHECK constraints en pagos.estado y pagos.origen.
-- Sin estos, un typo en el código de aprobación ('aprovado', 'approved') insertaría un estado
-- inválido que ningún constraint atrapa, y el polling de /dashboard/pro (compara por igualdad de
-- string) dejaría al usuario pagado sin reflejarse como Pro. Idempotente (guard por pg_constraint).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pagos_estado_chk') THEN
    ALTER TABLE pagos ADD CONSTRAINT pagos_estado_chk CHECK (estado IN ('pendiente', 'aprobado', 'rechazado'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pagos_origen_chk') THEN
    ALTER TABLE pagos ADD CONSTRAINT pagos_origen_chk CHECK (origen IN ('whatsapp', 'webapp'));
  END IF;
END $$;
