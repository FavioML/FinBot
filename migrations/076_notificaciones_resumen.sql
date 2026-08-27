-- Item 2 del backlog de confiabilidad (2026-08-27): el instrumento de la campana medía
-- CENSURADO y nadie lo veía.
--
-- El panel de notificaciones lista con `.limit(20)` (`api/notifications/inbox` y
-- `api/dashboard`), y el evento `notifications_opened` derivaba `total` y `tipos` de esa lista
-- capada mientras `unreadCount` contaba exacto sobre todas las filas. Por eso hay aperturas
-- reales en PostHog con `total: 20, no_leidas: 22`: el campo que mide el RUIDO satura justo
-- arriba, o sea en el único usuario del muestreo con volumen de verdad.
--
-- Medido en produccion el 27-ago, y `tipos` era el peor de los dos porque el sesgo NO es de
-- magnitud sino de contenido: de los 8 usuarios que superan el cap, **6 pierden al menos un
-- tipo** en la vista capada, y lo que se pierde es sistematicamente lo viejo:
--
--   usuario   total  tipos con cap 20                     tipos reales
--   5e3e05c8    786  alerta, alerta_fugas, recordatorio,   + deuda_vence
--                    sistema
--   e4332f63    364  alerta, recordatorio, sistema         + alerta_fugas, deuda_vence
--   ef9be664     41  alerta_fugas, deuda_vence,            + pro
--                    recordatorio, sistema
--
-- `deuda_vence` es exactamente el tipo sobre el que se decide si va a plantilla HSM, y era
-- invisible en la vista capada de los dos usuarios mas grandes.
--
-- Por que una funcion y no otra query de PostgREST: el conteo exacto ya se puede pedir con
-- `count: 'exact', head: true`, pero el inventario de tipos es un `array_agg(distinct)` y
-- PostgREST no agrupa. La alternativa era traerse la columna `tipo` de todas las filas al
-- servidor de Next para agregarla ahi, que hoy son 786 filas para el usuario mas grande, no
-- tiene techo (nada poda `notificaciones`: la fila mas vieja viva es del 2026-04-03) y se
-- pagaria en cada refetch de 60s. Esta funcion devuelve UNA fila.
--
-- Notas de diseno:
--   * SECURITY INVOKER (el default) a proposito, igual que los agregados del panel admin
--     (migracion 039): si alguna vez la llamara un rol `authenticated`, la RLS de
--     `notificaciones` sigue aplicando. Aun asi el EXECUTE queda revocado de anon/authenticated
--     porque la llaman rutas con service_role que ya scopean por `requireNetoUser`; dejarla
--     expuesta seria un IDOR de manual (cualquier sesion pasando un `p_usuario_id` ajeno).
--   * `usuario_id` ya tiene indice (`idx_notificaciones_usuario`), asi que el agregado no
--     agrega un scan nuevo: es el mismo acceso que ya hacen el listado y el conteo de no leidas.
--   * No lleva branch de Supabase previo (regla de `.claude/rules/database.md`) porque no hay
--     DDL sobre tablas: es un CREATE FUNCTION, sin lock sobre datos existentes.

create or replace function public.notificaciones_resumen(p_usuario_id uuid)
returns table (total bigint, tipos text[])
language sql
stable
set search_path = public, pg_temp
as $$
  select
    count(*)::bigint,
    -- `filter` sobre `tipo is not null` para que un tipo nulo no meta un NULL al array; el
    -- coalesce cubre al usuario sin ninguna notificacion, donde array_agg devuelve NULL.
    coalesce(array_agg(distinct n.tipo) filter (where n.tipo is not null), '{}')
  from public.notificaciones n
  where n.usuario_id = p_usuario_id
$$;

comment on function public.notificaciones_resumen(uuid) is
  'Campana: total exacto e inventario completo de tipos de un usuario. Existe porque el panel '
  'lista con limit 20 y la telemetria derivaba esos dos campos de la lista capada.';

revoke all on function public.notificaciones_resumen(uuid) from public, anon, authenticated;
grant execute on function public.notificaciones_resumen(uuid) to service_role;
