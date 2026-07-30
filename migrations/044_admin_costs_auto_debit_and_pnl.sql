-- Rework Costos admin: débito auto/manual + P&L mensual.
--
-- Parte 1 (DDL sobre tabla con datos): columna auto_debit en admin_costs.
--   manual (default false) = Favio lo paga → recordatorio Telegram el día del vencimiento
--     y nag diario mientras siga atrasado.
--   auto (true) = se cobra solo (ej. Railway con tarjeta) → el cron NO molesta con "págalo";
--     el día del cobro manda una línea informativa, avanza next_due_date y registra el pago
--     en paid_history (para que el P&L lo cuente).
-- ADD COLUMN boolean NOT NULL DEFAULT false es metadata-only en PG11+ (sin reescritura de tabla,
-- lock ACCESS EXCLUSIVE de microsegundos). admin_costs tiene ~3 filas. Probado en branch Supabase
-- antes de prod (regla database.md).
alter table public.admin_costs
  add column if not exists auto_debit boolean not null default false;

comment on column public.admin_costs.auto_debit is
  'true = débito automático (se cobra solo, solo informativo el día del cobro, auto-avanza y auto-registra pago). '
  'false = manual (dispara recordatorio Telegram el día del vencimiento + nag diario si queda atrasado).';

-- Parte 2 (CREATE FUNCTION, sin DDL sobre tablas): P&L mensual base caja.
--   income_pen = pagos aprobados cuyo coalesce(aprobado_at, created_at) cae en el mes Lima,
--     excluyendo cuentas internas (p_excluded = whatsapps de fundador/QA). Misma definición de
--     caja que cajaDelMes/economics (webapp/src/lib/admin-revenue.ts).
--   cost_pen  = suma de paid_history[].amount_pen cuyo paid_at cae en el mes Lima (cash-out real,
--     simétrico con el ingreso; incluye costos ya pausados: un pago pasado es plata que salió).
--   result_pen = income_pen - cost_pen.
-- Devuelve una fila por mes para los últimos p_months meses (meses sin datos → 0). Agrega TODO en
-- SQL (regla "no traer filas para contarlas": pagos puede crecer sobre 1000 filas y truncar).
--
-- SECURITY INVOKER (default). EXECUTE revocado de anon/authenticated; uso admin (service_role).
create or replace function public.admin_pnl_monthly(p_months int, p_excluded text[])
returns table(month date, income_pen numeric, cost_pen numeric, result_pen numeric)
language sql
stable
set search_path = public, pg_temp
as $$
  with months as (
    select generate_series(
      date_trunc('month', (now() at time zone 'America/Lima'))
        - ((greatest(coalesce(p_months, 6), 1) - 1) * interval '1 month'),
      date_trunc('month', (now() at time zone 'America/Lima')),
      interval '1 month'
    )::date as m
  ),
  income as (
    select date_trunc('month', (coalesce(p.aprobado_at, p.created_at) at time zone 'America/Lima'))::date as m,
           sum(p.monto) as total
    from public.pagos p
    join public.usuarios u on u.id = p.usuario_id
    where p.estado = 'aprobado'
      and p.monto is not null
      and (u.whatsapp is null or u.whatsapp <> all(coalesce(p_excluded, array[]::text[])))
    group by 1
  ),
  costs as (
    select date_trunc('month', (e->>'paid_at')::date)::date as m,
           sum((e->>'amount_pen')::numeric) as total
    from public.admin_costs c
    cross join lateral jsonb_array_elements(c.paid_history) as e
    where jsonb_typeof(c.paid_history) = 'array'
    group by 1
  )
  select
    mo.m as month,
    round(coalesce(i.total, 0), 2) as income_pen,
    round(coalesce(co.total, 0), 2) as cost_pen,
    round(coalesce(i.total, 0) - coalesce(co.total, 0), 2) as result_pen
  from months mo
  left join income i on i.m = mo.m
  left join costs co on co.m = mo.m
  order by mo.m;
$$;

comment on function public.admin_pnl_monthly(int, text[]) is
  'Panel admin (Rework Costos): P&L mensual base caja. income = pagos aprobados por mes Lima (excluye '
  'internos via p_excluded); cost = paid_history por mes Lima; result = income - cost. Últimos p_months meses.';

revoke all on function public.admin_pnl_monthly(int, text[]) from public, anon, authenticated;
grant execute on function public.admin_pnl_monthly(int, text[]) to service_role;
