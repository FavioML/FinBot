-- 080 — "Tiene Gmail conectado" pasa a mirar las DOS fuentes
--
-- `usuarios.gmail_access_token` es el almacén LEGACY. El actual es `gmail_cuentas`, una fila
-- por cuenta conectada, y `services/gmail-scanner.js` ya lee los dos (une los ids de ambas
-- antes de escanear). Estas dos funciones se quedaron mirando solo la columna vieja.
--
-- Medido contra producción el 2026-09-01, antes de escribir esta migración:
--
--   usuarios con la columna legacy .................. 2
--   usuarios con fila en gmail_cuentas .............. 6   (3 con `activa = true`)
--   conectados de verdad hoy (la unión) ............. 3
--
-- O sea que `admin_feature_adoption` reportaba la adopción de la feature más cara del producto
-- con un tercio de los datos, y la ficha de usuario pintaba "sin Gmail" sobre gente que sí lo
-- tenía conectado (incluida la cuenta del fundador, que es la que hizo notar el bug).
--
-- **La unión de FUENTES es la misma que arma el scanner**, que es lo que importa: mirar un
-- almacén distinto que el cron es cómo nació el bug. El espejo en TypeScript es
-- `webapp/src/lib/gmail-conectado.ts`, con su test.
--
-- Lo que NO es igual: el scanner aplica después dos filtros de elegibilidad sobre esa unión
-- (`esProPagado` y excluir lápidas del borrado), así que `gmail` acá es un superconjunto de
-- "a quién se le escanea". La pregunta que responde es "¿tiene Gmail vinculado?", y eso no
-- cambia porque se le haya vencido el Pro.
--
-- Y la distinción que esta migración introduce y no hay que colapsar después:
--
--   conectado    → `gmail_cuentas.activa = true` ∪ token legacy. A estos les lee el correo.
--   cupo gastado → CUALQUIER fila de `gmail_cuentas` ∪ token legacy. Quien desconectó deja
--                  `activa = false` pero su consentimiento ya se gastó, y ese es el número que
--                  cuenta contra el cap de 100 usuarios de la app OAuth sin certificar (el
--                  cupo NO se recupera nunca; ver el CLAUDE.md del backend). Contarlo de menos
--                  es descubrir el techo cuando ya se chocó.

-- ---------------------------------------------------------------------------
-- Ficha individual (admin/users → drill-down). Antes: solo la columna legacy.
-- ---------------------------------------------------------------------------
create or replace function public.admin_user_features(p_user_id uuid)
returns jsonb
language sql
stable
set search_path to 'public', 'pg_temp'
as $function$
  select jsonb_build_object(
    'transacciones',   (select count(*) from public.transacciones where usuario_id = p_user_id),
    'categorias',      (select count(*) from public.categorias_usuario where usuario_id = p_user_id),
    'presupuestos',    (select count(*) from public.presupuestos where usuario_id = p_user_id),
    'deudas',          (select count(*) from public.deudas where usuario_id = p_user_id),
    'metas',           (select count(*) from public.metas_ahorro where usuario_id = p_user_id),
    'espacios',        (select count(*) from public.space_members where user_id = p_user_id),
    'alertas',         (select count(*) from public.spending_alerts where user_id = p_user_id),
    'score',           (select ns.score from public.neto_scores ns
                         where ns.user_id = p_user_id
                         order by ns.calculated_at desc limit 1),
    -- La unión. `exists` y no un join: acá solo importa si hay al menos una.
    'gmail',           (
                         coalesce((select gmail_access_token is not null from public.usuarios where id = p_user_id), false)
                         or exists (select 1 from public.gmail_cuentas gc
                                     where gc.usuario_id = p_user_id and gc.activa is true)
                       ),
    -- Conectado pero con la autorización caída (migración 058): sigue vinculado, pero Google
    -- dejó de aceptar el token y el cron no lee nada. La ficha lo separa porque es la única
    -- sub-población sobre la que hay algo que hacer: pedirle que reconecte.
    'gmail_caido',     exists (select 1 from public.gmail_cuentas gc
                                where gc.usuario_id = p_user_id
                                  and gc.activa is true
                                  and gc.auth_error_at is not null),
    'tickets',         (select count(*) from public.tickets_soporte ts join public.usuarios u on u.whatsapp = ts.whatsapp where u.id = p_user_id),
    'pagos_aprobados', (select count(*) from public.pagos where usuario_id = p_user_id and estado = 'aprobado'),
    'ltv_pen',         coalesce((select sum(monto) from public.pagos where usuario_id = p_user_id and estado = 'aprobado'), 0)
  )
$function$;

-- ---------------------------------------------------------------------------
-- Adopción por feature (admin/producto). Antes: `count(*) where gmail_access_token is not null`.
-- ---------------------------------------------------------------------------
create or replace function public.admin_feature_adoption(p_excluded text[])
returns table(feature text, users bigint)
language sql
stable
set search_path to 'public', 'pg_temp'
as $function$
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
    -- Conectados HOY: los que el cron efectivamente escanea.
    ('gmail',         (select count(*)::bigint from u
                        where u.gmail_access_token is not null
                           or exists (select 1 from public.gmail_cuentas gc
                                       where gc.usuario_id = u.id and gc.activa is true))),
    -- Cupo consumido de los 100 de Google: los que conectaron alguna vez, hayan desconectado
    -- después o no. Se reporta al lado y no en vez de `gmail`, porque son preguntas distintas:
    -- cuánta gente USA la feature, y cuánto queda del INVENTARIO.
    --
    -- **Esta única fila NO aplica `p_excluded` ni `is_test_user`, y es a propósito.** Todas las
    -- demás miden adopción entre usuarios reales, donde excluir al fundador y a los bots de QA
    -- es lo correcto. Esta mide un inventario que Google lleva por su cuenta, y a Google no le
    -- importa de quién es la cuenta: la del fundador gastó su cupo igual, y es irrecuperable.
    -- Excluirla acá haría creer que quedan más cupos de los que quedan, que es el único lado
    -- del error que hace daño.
    ('gmail_cupo',    (select count(*)::bigint from public.usuarios uu
                        where uu.gmail_access_token is not null
                           or exists (select 1 from public.gmail_cuentas gc
                                       where gc.usuario_id = uu.id)))
  ) as f(feature, users)
$function$;
