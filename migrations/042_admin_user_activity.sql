-- Ola 4 Fase 1 auditoria panel admin (2026-07-30): pagina admin/users. Actividad por usuario para
-- segmentar la base (power/activo/en riesgo/dormido) y alimentar el feed y la adquisicion.
-- El conteo total de tx sigue viniendo de admin_user_tx_stats (039); esta RPC solo agrega las
-- VENTANAS de actividad (14d/30d) y las fechas de primera/ultima transaccion, por usuario.
--
-- Agrega en SQL (una fila por usuario, no por transaccion) -> no trunca a 1000 (PostgREST).
-- NO excluye cuentas internas: devuelve TODOS los usuarios (la ruta /api/admin/users muestra la
-- base completa para gestion). El filtrado de internas para el ANALISIS lo hace el front con el
-- flag is_internal, para no romper el invariante "suma de tx == total real" del harness.
--
-- SECURITY INVOKER (default). EXECUTE revocado de anon/authenticated; uso admin (service_role).
-- Sin branch de Supabase previo (regla database.md): es CREATE FUNCTION, sin DDL sobre tablas.
create or replace function public.admin_user_activity()
returns table (
  user_id uuid,
  tx_14d bigint,
  tx_30d bigint,
  first_tx_at timestamptz,
  last_tx_at timestamptz
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
    max(t.created_at) as last_tx_at
  from public.usuarios u
  left join public.transacciones t on t.usuario_id = u.id
  group by u.id
$$;

comment on function public.admin_user_activity() is
  'Panel admin (Ola 4): ventanas de actividad (14d/30d) y primera/ultima transaccion por usuario. '
  'Alimenta los segmentos de la pagina admin/users. Devuelve todos los usuarios; el filtrado de '
  'cuentas internas para el analisis lo hace el front (flag is_internal).';

revoke all on function public.admin_user_activity() from public, anon, authenticated;
grant execute on function public.admin_user_activity() to service_role;
