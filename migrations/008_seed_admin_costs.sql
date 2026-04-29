-- Seed: Costos operativos iniciales de Neto (abr 2026)
-- Basado en project_pricing_business memory + ajustes confirmados por Favio.
--
-- Tipo de cambio promedio asumido: USD = 3.50 PEN
--
-- Fechas confirmadas:
--   Railway: primer cobro 6-mar-2026 -> proximo 6-may-2026 (mensual)
--   Dominio neto.pe: pagado 17-mar-2026 -> proximo 17-mar-2027 (anual)
--   Chip Entel: activo desde 15-mar-2026 -> proximo 15-may-2026 (mensual, mes 14-abr ya pasado)

INSERT INTO admin_costs (label, category, amount_pen, amount_original, currency, frequency, next_due_date, notes, active)
VALUES
  (
    'Railway Hobby',
    'infra',
    17.50,
    5.00,
    'USD',
    'monthly',
    '2026-05-06',
    'Backend Node.js de Neto. Plan Hobby $5/mes. Primer cobro 6-abr-2026. Migrar a Pro ($15/mes) cuando ~300 usuarios.',
    true
  ),
  (
    'Dominio neto.pe',
    'domain',
    30.00,
    NULL,
    'PEN',
    'yearly',
    '2027-03-17',
    'Dominio principal. Pagado 17-mar-2026 (anual). Renovacion 17-mar-2027.',
    true
  ),
  (
    'Chip Entel (linea WhatsApp)',
    'comms',
    3.00,
    NULL,
    'PEN',
    'monthly',
    '2026-05-15',
    'Recarga prepago para mantener activa la linea +51 933 014 505. Activo desde 15-mar-2026.',
    true
  );
