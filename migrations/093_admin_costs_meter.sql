-- Costos que se MIDEN en vez de cobrar un monto fijo: Meta (mensajes de WhatsApp) y OpenAI.
--
-- Los tres costos que había (Railway, Entel, dominio) tienen monto fijo, y el cron de auto-débito
-- registra `amount_pen` tal cual el día del cobro. Meta y OpenAI cobran lo que se consumió:
-- Meta deja gratis ~1.000 service messages al mes y cobra ~US$0.03 cada uno encima (octubre-2026:
-- 1.445 mensajes, 444 cobrados, US$15.53 con IGV), y OpenAI recarga saldo cuando se acaba, sin
-- fecha ni monto fijos. Registrar un monto fijo para ellos mentiría en el P&L todos los meses.
--
--   meter IS NULL   -> costo de monto fijo, como hasta hoy (planCostReminders lo procesa).
--   meter set       -> el cron lee el consumo del mes anterior en la API del proveedor y registra
--                      ESE monto en paid_history (lib/cost-meters.js). planCostReminders lo salta,
--                      o se registraría dos veces.
--
-- El índice único es lo que impide la doble cuenta: dos filas con el mismo medidor sumarían el
-- mismo consumo dos veces en el P&L, sin que ningún número se viera raro.
--
-- ADD COLUMN nullable sin default: metadata-only, la tabla tiene 3 filas.
alter table public.admin_costs
  add column if not exists meter text
  check (meter in ('meta_whatsapp', 'openai'));

create unique index if not exists admin_costs_meter_unico
  on public.admin_costs (meter)
  where meter is not null;

comment on column public.admin_costs.meter is
  'Medidor del consumo: el cron lee el mes anterior en la API del proveedor y registra ese monto '
  'en paid_history (lib/cost-meters.js). NULL = costo de monto fijo.';
