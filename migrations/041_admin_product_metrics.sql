-- Ola 3 auditoria panel admin (2026-07-30): las tres metricas de PRODUCTO que faltaban para
-- decidir donde invertir. El panel tenia dinero (MRR/LTV/churn) y el embudo de una pasada, pero
-- no: retencion por cohorte, distribucion de engagement, ni adopcion de features.
--
-- Las tres agregan en SQL (no traen filas para contarlas -> no truncan a 1000) y excluyen las
-- cuentas internas via p_excluded (fundador + QA), la MISMA lista que admin-revenue.ts, pasada
-- como parametro para no duplicar la fuente de verdad. Se excluyen porque el fundador es un
-- power-user que solo ha tocado cada feature: contarlo inflaria adopcion y la cola de power-users.
--
-- SECURITY INVOKER (default). EXECUTE revocado de anon/authenticated; uso admin (service_role).
-- Sin branch de Supabase previo (regla database.md): son CREATE FUNCTION, sin DDL sobre tablas.

-- 1) Retencion por cohorte de registro. Cohorte = mes de alta; periodo = ventana de 30 dias
-- DESDE el alta de cada usuario (periodo 0 = primeros 30 dias, etc.). Emite periodos 0..5 para
-- todas las cohortes; la ruta marca cuales ya maduraron (la UI no debe pintar "0%" de un periodo
-- que aun no transcurrio). "Activo" = al menos una transaccion en esa ventana.
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
    where whatsapp is null or whatsapp <> all(p_excluded)
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
  'de 30 dias desde el alta de cada usuario. Excluye cuentas internas via p_excluded.';

-- 2) Distribucion de engagement: buckets de transacciones por usuario + mediana/promedio. El
-- panel muestra un promedio (txPerActiveUser) que miente cuando pocos power-users arrastran la
-- media; la mediana y los buckets muestran cuantos usuarios estan realmente dormidos.
create or replace function public.admin_engagement_distribution(p_excluded text[])
returns jsonb
language sql
stable
set search_path = public, pg_temp
as $$
  with u as (
    select id from public.usuarios
    where whatsapp is null or whatsapp <> all(p_excluded)
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
  'dormidos). Excluye cuentas internas via p_excluded. total == denominador de adopcion.';

-- 3) Adopcion de features: usuarios distintos que tocaron cada feature. El denominador es
-- engagement.total (misma exclusion). Cada valor es count(distinct) -> no trunca.
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
    where whatsapp is null or whatsapp <> all(p_excluded)
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
  'Excluye cuentas internas via p_excluded.';

revoke all on function public.admin_retention_cohorts(text[]) from public, anon, authenticated;
revoke all on function public.admin_engagement_distribution(text[]) from public, anon, authenticated;
revoke all on function public.admin_feature_adoption(text[]) from public, anon, authenticated;
grant execute on function public.admin_retention_cohorts(text[]) to service_role;
grant execute on function public.admin_engagement_distribution(text[]) to service_role;
grant execute on function public.admin_feature_adoption(text[]) to service_role;
