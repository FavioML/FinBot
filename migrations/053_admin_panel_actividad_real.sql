-- Panel admin (2026-08-01): dos numeros de la ficha de usuario mentian.
--
-- Contexto: revisando a un usuario que acababa de renovar Pro, el panel lo pintaba como
-- "Dormido / sin actividad / 0 tx". El usuario llevaba semanas conversando por WhatsApp,
-- tenia deudas vivas y recibia recordatorios ese mismo dia. Los dos numeros que lo
-- ocultaban:
--
--   1. "Ultima actividad" salia de last_tx_at, o sea SOLO transacciones. Quien usa Neto
--      por WhatsApp sin registrar gastos figura como fantasma. Ahora existe
--      last_activity_at = la mas reciente entre su ultima transaccion y su ultimo mensaje.
--      last_tx_at se queda como esta: lo usan "Primera transaccion" y los segmentos, que
--      miden activacion (registrar gastos) y esa definicion es deliberada.
--
--   2. El chip "Score" mostraba count(*) de neto_scores, o sea CUANTOS DIAS se le calculo
--      el score, no su score. Decia 37 cuando su score era 35. Y como el cron calcula el
--      score de todos a diario, ese chip solo medía antiguedad: estaba encendido para
--      cualquiera. Ahora devuelve el ultimo valor calculado, o null si nunca tuvo.
--
-- Sin DDL sobre tablas (regla database.md): solo reemplazo de funciones.

-- ── 1. admin_user_activity: sumar last_activity_at ──────────────────────────────
-- Cambia el returns table, asi que no basta create or replace.
drop function if exists public.admin_user_activity();

create function public.admin_user_activity()
returns table (
  user_id uuid,
  tx_14d bigint,
  tx_30d bigint,
  first_tx_at timestamptz,
  last_tx_at timestamptz,
  last_activity_at timestamptz
)
language sql
stable
set search_path = public, pg_temp
as $$
  select
    u.id as user_id,
    count(t.id) filter (where t.created_at >= now() - interval '14 days') as tx_14d,
    count(t.id) filter (where t.created_at >= now() - interval '30 days') as tx_30d,
    min(t.created_at) as first_tx_at,
    max(t.created_at) as last_tx_at,
    -- greatest() en Postgres ignora los NULL, asi que cubre los tres casos sin coalesce:
    -- solo tx, solo conversaciones, o ambas. transacciones.created_at es timestamp SIN
    -- zona y conversaciones.created_at SI la lleva; el 'at time zone UTC' hace explicita
    -- la conversion en vez de depender del TimeZone de la sesion.
    greatest(
      max(t.created_at) at time zone 'UTC',
      (select max(c.created_at) from public.conversaciones c where c.usuario_id = u.id)
    ) as last_activity_at
  from public.usuarios u
  left join public.transacciones t on t.usuario_id = u.id
  group by u.id
$$;

comment on function public.admin_user_activity() is
  'Panel admin (Ola 4): ventanas de actividad (14d/30d), primera/ultima transaccion y ultima '
  'actividad real (tx o mensaje) por usuario. Alimenta los segmentos de la pagina admin/users. '
  'Devuelve todos los usuarios; el filtrado de cuentas internas para el analisis lo hace el '
  'front (flag is_internal).';

revoke all on function public.admin_user_activity() from public, anon, authenticated;
grant execute on function public.admin_user_activity() to service_role;

-- ── 2. admin_user_features: score = valor, no conteo ────────────────────────────
create or replace function public.admin_user_features(p_user_id uuid)
returns jsonb
language sql
stable
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'transacciones',   (select count(*) from public.transacciones where usuario_id = p_user_id),
    'categorias',      (select count(*) from public.categorias_usuario where usuario_id = p_user_id),
    'presupuestos',    (select count(*) from public.presupuestos where usuario_id = p_user_id),
    'deudas',          (select count(*) from public.deudas where usuario_id = p_user_id),
    'metas',           (select count(*) from public.metas_ahorro where usuario_id = p_user_id),
    'espacios',        (select count(*) from public.space_members where user_id = p_user_id),
    'alertas',         (select count(*) from public.spending_alerts where user_id = p_user_id),
    -- El VALOR del score, no cuantas veces se calculo. null = nunca tuvo.
    'score',           (select ns.score from public.neto_scores ns
                         where ns.user_id = p_user_id
                         order by ns.calculated_at desc limit 1),
    'gmail',           coalesce((select gmail_access_token is not null from public.usuarios where id = p_user_id), false),
    'tickets',         (select count(*) from public.tickets_soporte ts join public.usuarios u on u.whatsapp = ts.whatsapp where u.id = p_user_id),
    'pagos_aprobados', (select count(*) from public.pagos where usuario_id = p_user_id and estado = 'aprobado'),
    'ltv_pen',         coalesce((select sum(monto) from public.pagos where usuario_id = p_user_id and estado = 'aprobado'), 0)
  )
$$;

comment on function public.admin_user_features(uuid) is
  'Panel admin: conteos de features por usuario + LTV. "score" es el ULTIMO valor del Neto Score '
  '(null si nunca se calculo), no el numero de calculos.';

revoke all on function public.admin_user_features(uuid) from public, anon, authenticated;
grant execute on function public.admin_user_features(uuid) to service_role;
