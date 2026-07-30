-- Ola 4 Fase 2 (pagina admin/users): ficha individual. Devuelve, para UN usuario, los conteos por
-- feature + LTV (suma de pagos aprobados). Es el equivalente por-usuario del admin_feature_adoption
-- (041), que da la adopcion agregada. Mismas tablas y llaves.
--
-- Nota de llaves: la mayoria de features cuelga de usuario_id; espacios/alertas/score usan user_id;
-- tickets_soporte se relaciona por whatsapp (asi lo escribe el sistema de soporte), por eso el join.
--
-- SECURITY INVOKER (default). EXECUTE revocado de anon/authenticated; uso admin (service_role).
-- Sin branch de Supabase previo (regla database.md): es CREATE FUNCTION, sin DDL sobre tablas.
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
    'score',           (select count(*) from public.neto_scores where user_id = p_user_id),
    'gmail',           coalesce((select gmail_access_token is not null from public.usuarios where id = p_user_id), false),
    'tickets',         (select count(*) from public.tickets_soporte ts join public.usuarios u on u.whatsapp = ts.whatsapp where u.id = p_user_id),
    'pagos_aprobados', (select count(*) from public.pagos where usuario_id = p_user_id and estado = 'aprobado'),
    'ltv_pen',         coalesce((select sum(monto) from public.pagos where usuario_id = p_user_id and estado = 'aprobado'), 0)
  )
$$;

comment on function public.admin_user_features(uuid) is
  'Panel admin (Ola 4 Fase 2): conteos por feature + LTV para la ficha individual de admin/users. '
  'Equivalente por-usuario de admin_feature_adoption. tickets se relaciona por whatsapp.';

revoke all on function public.admin_user_features(uuid) from public, anon, authenticated;
grant execute on function public.admin_user_features(uuid) to service_role;
