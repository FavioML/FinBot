-- Renovaciones (panel admin, /admin/pagos): a quién escribirle antes o después de que venza.
--
-- Al 30-sep-2026, de 18 pagos con plata solo 2 eran renovaciones y 4 mensuales habían vencido
-- sin volver a pagar. Los avisos automáticos de vencimiento salen en texto libre por WhatsApp y
-- la mayoría no se entrega (ventana de 24h de Meta), así que la vía que funciona es que Favio
-- les escriba a mano. Esta función es esa lista.
--
-- Quién entra: quien pagó CON PLATA alguna vez (un `pagos` aprobado con monto > 0), cuenta real
-- (misma exclusión que admin_pnl_monthly: `is_test_user` o whatsapp en `p_excluded`) y cuenta
-- sin borrar (la lápida de la 073 no tiene a quién escribirle). Un Pro de cortesía que nunca
-- pagó no está: no hay renovación que perder.
--
--   · por_vencer: hoy en Pro (`plan = 'premium'`) y `premium_vence` entre hoy y hoy + p_dias.
--   · vencido:    la cobertura terminó antes de hoy y dentro de los últimos p_dias_vencido días.
--
-- Para "vencido" la fecha es `coalesce(usuarios.premium_vence, último pagos.premium_vence)`, no
-- la columna de `usuarios` a secas: algún camino de baja la deja en NULL (medido el 30-sep: el
-- primer cliente que pagó, en junio, tiene `premium_vence` NULL y su pago dice que cubría hasta
-- el 03-jul). Con la columna sola, la lista perdía justo a quien se fue.
--
-- "Hoy" es el día calendario de Lima: `premium_vence` es una DATE que nombra un día peruano.
-- `email_web` solo trae el correo si la fila tiene cuenta web (`supabase_auth_id`): la columna
-- no es de direcciones probadas (ver `correoVerificado` en lib/email.js, migración 086).
--
-- SECURITY INVOKER (default), uso admin por service_role, igual que la 044 y la 088.

create or replace function public.admin_renovaciones(p_excluded text[], p_dias int, p_dias_vencido int)
returns table(
  usuario_id uuid,
  estado text,
  dias int,
  premium_vence date,
  tipo_plan text,
  nombre text,
  whatsapp text,
  email_web text,
  tiene_cuenta_web boolean,
  n_pagos int,
  ultimo_pago_at timestamptz,
  ultimo_monto numeric,
  pago_pendiente boolean
)
language sql
stable
set search_path = public, pg_temp
as $$
  with hoy as (
    select (now() at time zone 'America/Lima')::date as d
  ),
  pagados as (
    select p.usuario_id,
           count(*)::int as n_pagos,
           max(coalesce(p.aprobado_at, p.created_at)) as ultimo_pago_at,
           (array_agg(p.monto order by coalesce(p.aprobado_at, p.created_at) desc, p.id desc))[1] as ultimo_monto,
           max(p.premium_vence) as vence_segun_pagos
    from public.pagos p
    where p.estado = 'aprobado' and p.monto > 0
    group by p.usuario_id
  ),
  pendientes as (
    select distinct p.usuario_id from public.pagos p where p.estado = 'pendiente'
  ),
  con_vence as (
    select u.*, g.n_pagos, g.ultimo_pago_at, g.ultimo_monto,
           coalesce(u.premium_vence, g.vence_segun_pagos) as vence
    from public.usuarios u
    join pagados g on g.usuario_id = u.id
  ),
  base as (
    select u.id,
           case
             when u.plan = 'premium' and u.premium_vence >= h.d
                  and u.premium_vence <= h.d + greatest(coalesce(p_dias, 14), 0) then 'por_vencer'
             when u.vence < h.d
                  and u.vence >= h.d - greatest(coalesce(p_dias_vencido, 90), 0) then 'vencido'
           end as estado,
           (u.vence - h.d)::int as dias,
           u.vence as premium_vence,
           u.tipo_plan::text,
           u.nombre::text,
           u.whatsapp::text,
           case when u.supabase_auth_id is not null then u.email::text end as email_web,
           (u.supabase_auth_id is not null) as tiene_cuenta_web,
           u.n_pagos,
           u.ultimo_pago_at,
           u.ultimo_monto,
           (pe.usuario_id is not null) as pago_pendiente
    from con_vence u
    left join pendientes pe on pe.usuario_id = u.id
    cross join hoy h
    where coalesce(u.is_test_user, false) = false
      and (u.whatsapp is null or u.whatsapp <> all(coalesce(p_excluded, array[]::text[])))
      and u.cuenta_borrada_at is null
      and u.vence is not null
  )
  select b.id, b.estado, b.dias, b.premium_vence, b.tipo_plan, b.nombre, b.whatsapp, b.email_web,
         b.tiene_cuenta_web, b.n_pagos, b.ultimo_pago_at, b.ultimo_monto, b.pago_pendiente
  from base b
  where b.estado is not null
  -- Lo que vence primero arriba; entre los vencidos, el más reciente primero (el más tibio).
  order by case b.estado when 'por_vencer' then 0 else 1 end,
           case when b.estado = 'por_vencer' then b.dias else -b.dias end,
           b.id;
$$;

comment on function public.admin_renovaciones(text[], int, int) is
  'Panel admin /admin/pagos: pagadores reales con el plan por vencer (próximos p_dias) o vencido '
  'sin renovar (últimos p_dias_vencido), con su contacto y si tienen un comprobante pendiente.';

revoke all on function public.admin_renovaciones(text[], int, int) from public, anon, authenticated;
grant execute on function public.admin_renovaciones(text[], int, int) to service_role;
