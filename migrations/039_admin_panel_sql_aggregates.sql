-- Ola 1 auditoria panel admin (2026-07-30): agrega en SQL lo que el panel agregaba en JS.
--
-- El panel traia filas crudas de `transacciones` y agregaba en JavaScript. PostgREST corta las
-- respuestas en 1000 filas, y eso se estaba comiendo datos EN SILENCIO (verificado en prod:
-- HTTP 206, Content-Range 0-999/2123):
--   * /api/admin/stats pedia la tabla entera ordenada ASC para derivar la primera tx por
--     usuario, y recibia solo las 1000 mas antiguas. El embudo veia 21 de 44 usuarios
--     activados (25% reportado vs 52% real) y avgTimeToFirstTx promediaba solo a los mas
--     viejos. Peor: al ordenar ASC la ventana se congela en el pasado (corte 2026-06-07) y
--     retrocede con cada transaccion nueva.
--   * DAU/WAU/MAU y txPerActiveUser todavia no truncaban (765 filas en 30d) pero iban a
--     congelarse en 1000 sin ningun error visible al cruzar el techo.
-- Ademas /api/admin/users llamaba a count_transactions_by_user, que NUNCA existio en esta
-- base, asi que siempre caia al fallback N+1: una query por usuario, 84 roundtrips
-- secuenciales por carga de pantalla.
--
-- Las funciones de abajo devuelven agregados (decenas de filas, no miles), asi que no queda
-- nada que truncar y el techo de PostgREST deja de ser relevante para estas metricas.
--
-- Notas de diseno:
--   * SECURITY INVOKER (el default) a proposito: si alguna vez las llamara un rol
--     `authenticated`, RLS de transacciones sigue aplicando. Aun asi el EXECUTE queda
--     revocado de anon/authenticated porque son de uso admin (service_role).
--   * Los parametros son `timestamp` SIN zona, igual que transacciones.created_at. Las rutas
--     pasan ISO strings UTC y Postgres descarta la Z al castear, que es exactamente lo que ya
--     pasaba con los filtros .gte() de PostgREST. La semantica de fecha no cambia: este
--     archivo arregla cobertura de datos, no el calendario (ver lib/date-lima.ts).
--   * No lleva branch de Supabase previo (regla de .claude/rules/database.md) porque no hay
--     DDL sobre tablas: son dos CREATE FUNCTION, sin lock sobre datos existentes.

-- Una fila por usuario con transacciones: reemplaza el N+1 de counts y el barrido completo
-- de la tabla para calcular la primera transaccion.
create or replace function public.admin_user_tx_stats()
returns table (
  usuario_id uuid,
  tx_count bigint,
  first_tx timestamp,
  last_tx timestamp
)
language sql
stable
set search_path = public, pg_temp
as $$
  select
    t.usuario_id,
    count(*)::bigint as tx_count,
    min(t.created_at) as first_tx,
    max(t.created_at) as last_tx
  from public.transacciones t
  group by t.usuario_id
$$;

comment on function public.admin_user_tx_stats() is
  'Panel admin: agregados de transacciones por usuario (count, primera, ultima). Evita el '
  'techo de 1000 filas de PostgREST y el fallback N+1 de /api/admin/users.';

-- DAU/WAU/MAU + transacciones del mes en una sola pasada. Escanea solo desde la ventana mas
-- antigua de las tres.
create or replace function public.admin_activity_counts(
  p_day timestamp,
  p_week timestamp,
  p_month timestamp
)
returns table (
  dau bigint,
  wau bigint,
  mau bigint,
  tx_month bigint
)
language sql
stable
set search_path = public, pg_temp
as $$
  select
    count(distinct t.usuario_id) filter (where t.created_at >= p_day)::bigint as dau,
    count(distinct t.usuario_id) filter (where t.created_at >= p_week)::bigint as wau,
    count(distinct t.usuario_id) filter (where t.created_at >= p_month)::bigint as mau,
    count(*) filter (where t.created_at >= p_month)::bigint as tx_month
  from public.transacciones t
  where t.created_at >= least(p_day, p_week, p_month)
$$;

comment on function public.admin_activity_counts(timestamp, timestamp, timestamp) is
  'Panel admin: DAU/WAU/MAU y total de transacciones del mes en una query. Cuenta usuarios '
  'distintos en SQL, no en JS sobre filas truncadas.';

-- Uso admin: solo service_role.
revoke all on function public.admin_user_tx_stats() from public, anon, authenticated;
revoke all on function public.admin_activity_counts(timestamp, timestamp, timestamp)
  from public, anon, authenticated;
grant execute on function public.admin_user_tx_stats() to service_role;
grant execute on function public.admin_activity_counts(timestamp, timestamp, timestamp)
  to service_role;

-- Las queries del panel filtran y ordenan por created_at, pero el unico indice temporal de
-- transacciones es sobre `fecha` (otra columna). Hoy son 18ms con seq scan, o sea que no es
-- el cuello de botella, pero el indice evita que lo sea cuando la tabla crezca.
create index if not exists idx_transacciones_created_at
  on public.transacciones using btree (created_at);
