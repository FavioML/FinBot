-- Migration: add_payment_tracking_columns
-- Run this in Supabase SQL Editor (https://supabase.com/dashboard/project/zvorjqlubmfrjtkbhqcx/sql)

ALTER TABLE usuarios
  ADD COLUMN IF NOT EXISTS estado_pago text DEFAULT 'pendiente',
  ADD COLUMN IF NOT EXISTS tipo_plan text DEFAULT 'mensual',
  ADD COLUMN IF NOT EXISTS fecha_pago timestamptz,
  ADD COLUMN IF NOT EXISTS fecha_vencimiento timestamptz,
  ADD COLUMN IF NOT EXISTS aprobado_gcc boolean DEFAULT false;

-- Add check constraints
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'usuarios_estado_pago_check') THEN
    ALTER TABLE usuarios ADD CONSTRAINT usuarios_estado_pago_check CHECK (estado_pago IN ('pendiente', 'pagado', 'vencido'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'usuarios_tipo_plan_check') THEN
    ALTER TABLE usuarios ADD CONSTRAINT usuarios_tipo_plan_check CHECK (tipo_plan IN ('mensual', 'anual'));
  END IF;
END $$;
