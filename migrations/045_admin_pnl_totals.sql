-- Complementos de Costos (tanda 2): caja generada acumulada por Neto.
--
-- Versión sin agrupar por mes de admin_pnl_monthly (044): totales históricos de caja. Alimenta el
-- KPI "caja generada acumulada" de /admin/economics (result_total) y sirve de base para el margen
-- operativo. income_total = todos los pagos aprobados no-internos; cost_total = todo paid_history;
-- result_total = income - cost. Agrega en SQL (regla "no traer filas para contarlas").
--
-- SECURITY INVOKER (default). EXECUTE revocado de anon/authenticated; uso admin (service_role).
-- CREATE FUNCTION, sin DDL sobre tablas → sin branch Supabase (convención del equipo, ver migr 043).
create or replace function public.admin_pnl_totals(p_excluded text[])
returns table(income_total numeric, cost_total numeric, result_total numeric)
language sql
stable
set search_path = public, pg_temp
as $$
  with income as (
    select coalesce(sum(p.monto), 0) as total
    from public.pagos p
    join public.usuarios u on u.id = p.usuario_id
    where p.estado = 'aprobado'
      and p.monto is not null
      and (u.whatsapp is null or u.whatsapp <> all(coalesce(p_excluded, array[]::text[])))
  ),
  costs as (
    select coalesce(sum((e->>'amount_pen')::numeric), 0) as total
    from public.admin_costs c
    cross join lateral jsonb_array_elements(c.paid_history) as e
    where jsonb_typeof(c.paid_history) = 'array'
  )
  select
    round((select total from income), 2) as income_total,
    round((select total from costs), 2) as cost_total,
    round((select total from income) - (select total from costs), 2) as result_total;
$$;

comment on function public.admin_pnl_totals(text[]) is
  'Panel admin (tanda 2 Costos): totales históricos de caja. income = pagos aprobados no-internos; '
  'cost = todo paid_history; result = income - cost. Alimenta la caja generada acumulada de economics.';

revoke all on function public.admin_pnl_totals(text[]) from public, anon, authenticated;
grant execute on function public.admin_pnl_totals(text[]) to service_role;
