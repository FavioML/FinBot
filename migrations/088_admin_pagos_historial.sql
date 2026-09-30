-- Pagos recibidos (panel admin, /admin/pagos): quién pagó, cuánto, y si fue su primer pago.
--
-- Hasta acá la caja existía solo como un número por mes ("Caja del mes" en Operación, "Ingresos"
-- en el P&L de Costos) y el único detalle era el historial POR USUARIO del PaymentsModal: para
-- saber quién pagó en septiembre había que saber a quién buscar. Estas dos funciones son ese
-- detalle, y por eso copian la definición de caja de `admin_pnl_monthly` en vez de inventar una:
--
--   · el mes lo decide coalesce(aprobado_at, created_at) en hora Lima;
--   · suman los pagos `aprobado` con monto de cuentas reales. La exclusión es la del cuerpo VIVO
--     de admin_pnl_monthly (la 057 le agregó `is_test_user` sobre lo que decía la 044), así que
--     `resumen[mes].total_pen == admin_pnl_monthly(mes).income_pen` es un invariante, y el harness
--     qa-e2e/qa-admin-panel.mjs lo vigila. Si una de las dos cambia de definición, cambian juntas.
--
-- "Primer pago o renovación" no es una columna: es el ordinal del pago dentro de los pagos CON
-- PLATA (aprobado y monto > 0) de ese usuario. Se numera sobre TODA la historia y recién después
-- se filtra el mes. Al revés, cada renovación sería el pago n.º 1 de su mes y la pantalla diría
-- que nadie renueva nunca. Las cortesías (monto 0) no reciben número: no son un pago.
--
-- Se agrega en SQL por la regla del panel (PostgREST corta en 1000 filas sin error). El detalle
-- devuelve las filas de UN mes; la ruta responde 500 si vuelven 1000.
--
-- Sin DDL sobre tablas: solo CREATE FUNCTION, sin lock. SECURITY INVOKER (default), uso admin
-- por service_role, igual que la 044.

create or replace function public.admin_pagos_resumen_mensual(p_excluded text[])
returns table(
  mes date,
  total_pen numeric,
  n_pagos int,
  n_primer_pago int,
  n_renovacion int,
  n_mensual int,
  n_anual int,
  total_mensual numeric,
  total_anual numeric,
  n_cortesia int,
  n_pendiente int,
  n_rechazado int
)
language sql
stable
set search_path = public, pg_temp
as $$
  with ordinal as (
    select p.id,
           row_number() over (
             partition by p.usuario_id
             order by coalesce(p.aprobado_at, p.created_at), p.id
           ) as n_pago
    from public.pagos p
    where p.estado = 'aprobado' and p.monto > 0
  ),
  base as (
    select date_trunc('month', (coalesce(p.aprobado_at, p.created_at) at time zone 'America/Lima'))::date as mes,
           p.estado,
           p.monto,
           p.tipo_plan,
           o.n_pago,
           (coalesce(u.is_test_user, false)
             or (u.whatsapp is not null and u.whatsapp = any(coalesce(p_excluded, array[]::text[])))) as interno
    from public.pagos p
    join public.usuarios u on u.id = p.usuario_id
    left join ordinal o on o.id = p.id
  )
  select
    b.mes,
    round(coalesce(sum(b.monto) filter (where b.estado = 'aprobado' and b.monto is not null and not b.interno), 0), 2),
    (count(*) filter (where b.n_pago is not null and not b.interno))::int,
    (count(*) filter (where b.n_pago = 1 and not b.interno))::int,
    (count(*) filter (where b.n_pago > 1 and not b.interno))::int,
    (count(*) filter (where b.n_pago is not null and not b.interno and b.tipo_plan = 'mensual'))::int,
    (count(*) filter (where b.n_pago is not null and not b.interno and b.tipo_plan = 'anual'))::int,
    round(coalesce(sum(b.monto) filter (where b.n_pago is not null and not b.interno and b.tipo_plan = 'mensual'), 0), 2),
    round(coalesce(sum(b.monto) filter (where b.n_pago is not null and not b.interno and b.tipo_plan = 'anual'), 0), 2),
    (count(*) filter (where b.estado = 'aprobado' and coalesce(b.monto, 0) <= 0 and not b.interno))::int,
    (count(*) filter (where b.estado = 'pendiente' and not b.interno))::int,
    (count(*) filter (where b.estado = 'rechazado' and not b.interno))::int
  from base b
  group by b.mes
  order by b.mes;
$$;

comment on function public.admin_pagos_resumen_mensual(text[]) is
  'Panel admin /admin/pagos: una fila por mes Lima con caja cobrada (misma definición que '
  'admin_pnl_monthly.income_pen), pagos con plata, primeros pagos vs renovaciones y mensual vs anual.';

revoke all on function public.admin_pagos_resumen_mensual(text[]) from public, anon, authenticated;
grant execute on function public.admin_pagos_resumen_mensual(text[]) to service_role;


create or replace function public.admin_pagos_del_mes(p_mes date, p_excluded text[])
returns table(
  id uuid,
  usuario_id uuid,
  cuando timestamptz,
  monto numeric,
  tipo_plan text,
  metodo_pago text,
  origen text,
  estado text,
  aprobado_por text,
  premium_desde date,
  premium_vence date,
  n_pago int,
  tipo_plan_anterior text,
  interno boolean,
  tiene_comprobante boolean,
  nombre text,
  whatsapp text,
  email text,
  cuenta_borrada boolean
)
language sql
stable
set search_path = public, pg_temp
as $$
  with ordinal as (
    select p.id,
           row_number() over w as n_pago,
           lag(p.tipo_plan) over w as tipo_plan_anterior
    from public.pagos p
    where p.estado = 'aprobado' and p.monto > 0
    window w as (partition by p.usuario_id order by coalesce(p.aprobado_at, p.created_at), p.id)
  )
  select
    p.id,
    p.usuario_id,
    coalesce(p.aprobado_at, p.created_at) as cuando,
    p.monto,
    p.tipo_plan,
    p.metodo_pago,
    p.origen,
    p.estado,
    p.aprobado_por,
    p.premium_desde,
    p.premium_vence,
    o.n_pago::int,
    o.tipo_plan_anterior,
    (coalesce(u.is_test_user, false)
      or (u.whatsapp is not null and u.whatsapp = any(coalesce(p_excluded, array[]::text[])))) as interno,
    (p.comprobante_url is not null) as tiene_comprobante,
    u.nombre::text,
    u.whatsapp::text,
    u.email::text,
    (u.cuenta_borrada_at is not null) as cuenta_borrada
  from public.pagos p
  join public.usuarios u on u.id = p.usuario_id
  left join ordinal o on o.id = p.id
  where date_trunc('month', (coalesce(p.aprobado_at, p.created_at) at time zone 'America/Lima'))::date
        = date_trunc('month', p_mes)::date
  order by coalesce(p.aprobado_at, p.created_at) desc, p.id;
$$;

comment on function public.admin_pagos_del_mes(date, text[]) is
  'Panel admin /admin/pagos: los pagos de un mes Lima con su usuario, el ordinal del pago con plata '
  'sobre toda la historia del usuario (1 = primer pago) y el plan anterior. `interno` marca lo que '
  'no suma a la caja.';

revoke all on function public.admin_pagos_del_mes(date, text[]) from public, anon, authenticated;
grant execute on function public.admin_pagos_del_mes(date, text[]) to service_role;
