-- Migration: Create admin_costs table for Unit Economics dashboard + reminders
-- Execute in Supabase SQL Editor (proyecto Neto: zvorjqlubmfrjtkbhqcx)
--
-- Purpose:
--   1. Source of truth para todos los costos operativos de Neto
--   2. Admin dashboard /admin/economics y /admin/costs leen de aquí
--   3. Cron `checkRecordatoriosCostos` (9am Lima diario) busca next_due_date = today
--      y manda WhatsApp al ADMIN_NUMBER, después avanza next_due_date según frequency

-- ===== Enums =====

DO $$ BEGIN
  CREATE TYPE admin_cost_frequency AS ENUM ('monthly', 'yearly', 'one_time');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE admin_cost_category AS ENUM (
    'infra',           -- Railway, Supabase, Vercel, Cloudflare
    'domain',          -- neto.pe, app.neto.pe
    'comms',           -- Chip Entel, WhatsApp, SMS
    'ai',              -- OpenAI, Anthropic
    'compliance',      -- CASA cert, INDECOPI, SUNAT
    'tooling',         -- Sentry, PostHog, etc.
    'other'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- ===== Table =====

CREATE TABLE IF NOT EXISTS admin_costs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Identificación
  label TEXT NOT NULL,                              -- "Railway Hobby", "Dominio neto.pe", "Chip Entel"
  category admin_cost_category NOT NULL DEFAULT 'other',
  notes TEXT,                                       -- Detalle opcional, link al panel del proveedor, etc.

  -- Monto (almacenamos en PEN convertido + moneda original para display)
  amount_pen NUMERIC(10, 2) NOT NULL CHECK (amount_pen >= 0),
  amount_original NUMERIC(10, 2),                   -- monto en moneda original (USD si aplica)
  currency TEXT NOT NULL DEFAULT 'PEN' CHECK (currency IN ('PEN', 'USD')),

  -- Frecuencia y vencimiento
  frequency admin_cost_frequency NOT NULL,
  next_due_date DATE,                               -- NULL si one_time ya pagado o sin fecha conocida
  active BOOLEAN NOT NULL DEFAULT true,             -- false = costo pausado o terminado

  -- Auditoría de pagos
  paid_history JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Estructura: [{ paid_at: '2026-04-29', amount_pen: 18.50, marked_by: 'admin' }, ...]
  -- Cron lo append-ea cuando avanza next_due_date al marcar como pagado

  last_reminder_sent_at TIMESTAMPTZ,                -- Evita doble notificación si el cron corre 2x el mismo día

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ===== Indexes =====

CREATE INDEX IF NOT EXISTS idx_admin_costs_due
  ON admin_costs (next_due_date)
  WHERE active = true AND next_due_date IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_admin_costs_active_category
  ON admin_costs (active, category);

-- ===== updated_at trigger =====

CREATE OR REPLACE FUNCTION admin_costs_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_admin_costs_updated_at ON admin_costs;
CREATE TRIGGER trg_admin_costs_updated_at
  BEFORE UPDATE ON admin_costs
  FOR EACH ROW
  EXECUTE FUNCTION admin_costs_set_updated_at();

-- ===== RLS =====
-- admin_costs es 100% privado del owner. No hay lectura pública nunca.
-- Backend (cron + API admin) usa service_role, que bypass-ea RLS.
-- La webapp lee vía /api/admin/* que valida con requireAdminUser() server-side.

ALTER TABLE admin_costs ENABLE ROW LEVEL SECURITY;

-- Solo service_role puede tocar la tabla
CREATE POLICY "Service role full access on admin_costs"
  ON admin_costs FOR ALL
  USING (true)
  WITH CHECK (true);

-- Grants
GRANT ALL ON admin_costs TO service_role;
-- Nada para authenticated o anon — esta tabla NO se expone al cliente

-- ===== Comentarios para documentación in-DB =====

COMMENT ON TABLE admin_costs IS
  'Costos operativos de Neto. Source of truth para Unit Economics dashboard y cron de recordatorios. Solo accesible vía service_role.';

COMMENT ON COLUMN admin_costs.frequency IS
  'monthly: avanza next_due_date +1 mes al marcar pagado. yearly: +1 año. one_time: next_due_date NULL tras pagar.';

COMMENT ON COLUMN admin_costs.paid_history IS
  'Array de pagos historicos. Append-only. Cada entry: { paid_at, amount_pen, marked_by }.';

COMMENT ON COLUMN admin_costs.last_reminder_sent_at IS
  'Timestamp del último WhatsApp enviado. Cron checa este campo para evitar doble alerta el mismo día.';
