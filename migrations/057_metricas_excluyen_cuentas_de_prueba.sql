-- Las cuentas de prueba salen de las metricas del panel (2026-08-02).
--
-- Que paso: `isRevenueUser` (webapp/src/lib/admin-revenue.ts) excluia cuentas internas por una
-- LISTA de numeros de WhatsApp, y dos cuentas con is_test_user=true y plan='premium' sumaban S/20
-- al MRR sobre ~S/56 reales. Una era un seed de demo web-first (sin numero que listar) y la otra
-- un QA nuevo que nadie agrego a la lista. El TS ya se arreglo (mira is_test_user ademas de la
-- lista); estas cinco funciones se habian quedado con la definicion vieja.
--
-- Cuanto movia, medido antes de aplicar: 7 cuentas de prueba pasaban el filtro con 81
-- transacciones entre todas. Cinco de ellas, con 0 tx, se contaban como usuarios DORMIDOS
-- (45 de 89 = 50.6%, cuando lo real es 40 de 82 = 48.8%) y una, con 65 tx, entraba como
-- power-user (10 en vez de 9) e inflaba la cohorte de julio, justo la que mejor se ve.
-- Nada de eso rompe: produce numeros creibles y falsos, que es peor.
--
-- El cambio es una condicion por funcion; las firmas quedan IGUALES a proposito, asi que ninguna
-- ruta TS cambia. p_excluded se queda porque el fundador NO es cuenta de prueba: son dos senales
-- distintas y las dos hacen falta.
--
-- `coalesce(is_test_user, false)`: la columna es nullable y en SQL `is_test_user = false` deja
-- fuera las filas con NULL, que son la mayoria — o sea, lo contrario de lo que quiere el filtro.
-- Es el mismo pisotón que ya costo un bug en `iniciarTrialSiCorresponde` con `.neq('plan', ...)`.
--
-- SECURITY INVOKER (default). EXECUTE revocado de anon/authenticated; uso admin (service_role).
-- Son CREATE OR REPLACE FUNCTION, sin DDL sobre tablas: sin branch de Supabase, misma convencion
-- que las migraciones 043/044/045 (un branch arranca sin datos de prod y aca lo que se valida es
-- justamente contra los datos reales).

-- 1) Retencion por cohorte
create or replace function public.admin_retention_cohorts(p_excluded text[])
returns table (
  cohort text,
  cohort_size bigint,
  period int,
  active bigint
)
language sql
stable
set search_path = public, pg_temp
as $$
  with u as (
    select id, created_at, date_trunc('month', created_at) as cm
    from public.usuarios
    where coalesce(is_test_user, false) = false
      and (whatsapp is null or whatsapp <> all(p_excluded))
  ),
  sizes as (
    select cm, count(*)::bigint as sz from u group by cm
  ),
  grid as (
    select s.cm, s.sz, p.period
    from sizes s cross join generate_series(0, 5) as p(period)
  )
  select
    to_char(g.cm, 'YYYY-MM') as cohort,
    g.sz as cohort_size,
    g.period,
    (
      select count(distinct c.id)::bigint
      from u c
      join public.transacciones t on t.usuario_id = c.id
      where c.cm = g.cm
        and t.created_at >= c.created_at + (g.period * interval '30 days')
        and t.created_at <  c.created_at + ((g.period + 1) * interval '30 days')
    ) as active
  from grid g
  order by g.cm, g.period
$$;

comment on function public.admin_retention_cohorts(text[]) is
  'Panel admin (Ola 3): retencion por cohorte de registro. Cohorte=mes de alta, periodo=ventana '
  'de 30 dias desde el alta de cada usuario. Excluye cuentas de prueba (is_test_user) e internas '
  '(p_excluded).';

-- 2) Distribucion de engagement
create or replace function public.admin_engagement_distribution(p_excluded text[])
returns jsonb
language sql
stable
set search_path = public, pg_temp
as $$
  with u as (
    select id from public.usuarios
    where coalesce(is_test_user, false) = false
      and (whatsapp is null or whatsapp <> all(p_excluded))
  ),
  tx as (
    select u.id, count(t.id) as c
    from u left join public.transacciones t on t.usuario_id = u.id
    group by u.id
  )
  select jsonb_build_object(
    'total', (select count(*) from tx),
    'dormant', (select count(*) from tx where c = 0),
    'mean', (select coalesce(round(avg(c), 1), 0) from tx),
    'median', (select coalesce(percentile_cont(0.5) within group (order by c), 0) from tx),
    'buckets', (
      select coalesce(jsonb_agg(jsonb_build_object('bucket', bucket, 'usuarios', n) order by ord), '[]'::jsonb)
      from (
        select
          case when c = 0 then '0'
               when c = 1 then '1'
               when c <= 5 then '2-5'
               when c <= 20 then '6-20'
               when c <= 50 then '21-50'
               else '51+' end as bucket,
          case when c = 0 then 0
               when c = 1 then 1
               when c <= 5 then 2
               when c <= 20 then 3
               when c <= 50 then 4
               else 5 end as ord,
          count(*)::bigint as n
        from tx
        group by 1, 2
      ) b
    )
  )
$$;

comment on function public.admin_engagement_distribution(text[]) is
  'Panel admin (Ola 3): distribucion de transacciones por usuario (buckets + mediana + promedio + '
  'dormidos). Excluye cuentas de prueba (is_test_user) e internas (p_excluded). total == '
  'denominador de adopcion.';

-- 3) Adopcion de features
create or replace function public.admin_feature_adoption(p_excluded text[])
returns table (
  feature text,
  users bigint
)
language sql
stable
set search_path = public, pg_temp
as $$
  with u as (
    select id, gmail_access_token from public.usuarios
    where coalesce(is_test_user, false) = false
      and (whatsapp is null or whatsapp <> all(p_excluded))
  )
  select * from (values
    ('transacciones', (select count(distinct usuario_id)::bigint from public.transacciones where usuario_id in (select id from u))),
    ('categorias',    (select count(distinct usuario_id)::bigint from public.categorias_usuario where usuario_id in (select id from u))),
    ('presupuestos',  (select count(distinct usuario_id)::bigint from public.presupuestos where usuario_id in (select id from u))),
    ('deudas',        (select count(distinct usuario_id)::bigint from public.deudas where usuario_id in (select id from u))),
    ('metas',         (select count(distinct usuario_id)::bigint from public.metas_ahorro where usuario_id in (select id from u))),
    ('espacios',      (select count(distinct user_id)::bigint from public.space_members where user_id in (select id from u))),
    ('alertas',       (select count(distinct user_id)::bigint from public.spending_alerts where user_id in (select id from u))),
    ('score',         (select count(distinct user_id)::bigint from public.neto_scores where user_id in (select id from u))),
    ('gmail',         (select count(*)::bigint from u where gmail_access_token is not null))
  ) as f(feature, users)
$$;

comment on function public.admin_feature_adoption(text[]) is
  'Panel admin (Ola 3): usuarios distintos por feature (adopcion). Denominador = engagement.total. '
  'Excluye cuentas de prueba (is_test_user) e internas (p_excluded).';

-- 4) P&L mensual (base caja)
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
      and coalesce(u.is_test_user, false) = false
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
  'Panel admin (Rework Costos): P&L mensual base caja. income = pagos aprobados por mes Lima '
  '(excluye cuentas de prueba e internas); cost = paid_history por mes Lima; result = income - cost.';

-- 5) Totales historicos de caja
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
      and coalesce(u.is_test_user, false) = false
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
  'Panel admin (tanda 2 Costos): totales historicos de caja. income = pagos aprobados de cuentas '
  'reales (sin is_test_user ni p_excluded); cost = todo paid_history; result = income - cost.';

revoke all on function public.admin_retention_cohorts(text[]) from public, anon, authenticated;
revoke all on function public.admin_engagement_distribution(text[]) from public, anon, authenticated;
revoke all on function public.admin_feature_adoption(text[]) from public, anon, authenticated;
revoke all on function public.admin_pnl_monthly(int, text[]) from public, anon, authenticated;
revoke all on function public.admin_pnl_totals(text[]) from public, anon, authenticated;
grant execute on function public.admin_retention_cohorts(text[]) to service_role;
grant execute on function public.admin_engagement_distribution(text[]) to service_role;
grant execute on function public.admin_feature_adoption(text[]) to service_role;
grant execute on function public.admin_pnl_monthly(int, text[]) to service_role;
grant execute on function public.admin_pnl_totals(text[]) to service_role;
