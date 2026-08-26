-- OJO: esta migración se APLICÓ con este cuerpo y después se corrigió DOS veces, en
-- `075b` (offsets de enero y julio) y `075c` (los overrides por rol, porque `reset_val`
-- resultó estar mal). Las tres filas están en `supabase_migrations.schema_migrations`. El
-- cuerpo VIVO es el de la 075c: no leas éste como si fuera el vigente.
--
-- Introspección del RELOJ de la base, para que un canary pueda vigilar un supuesto que hoy
-- sólo vive en un comentario.
--
-- EL SUPUESTO. `usuarios.created_at` es `timestamp WITHOUT time zone`, o sea que no guarda
-- offset: el instante que representa depende de en qué zona se escribió. El default de la
-- columna evalúa `now()` en la zona de la SESIÓN que hace el INSERT, que para todo lo que
-- entra por PostgREST es el GUC `TimeZone` de la base.
--
-- QUIÉN DEPENDE DE ESO. `checkRecordatorioOnboarding` (cron/checks.js) arma su ventana de
-- elegibilidad con `new Date(...).toISOString()`, que es UTC, y la compara contra esa columna
-- con `.gte()` / `.lte()`. La comparación es correcta ÚNICAMENTE porque el GUC es 'UTC' y las
-- dos puntas hablan de lo mismo. Con el GUC en 'America/Lima' los `created_at` nuevos quedarían
-- 5 horas por detrás de la ventana: el nudge le erraría a la población entera, sin lanzar, sin
-- loguear un error y sin que ningún test lo vea — los tests mockean Supabase, así que el GUC
-- real no participa. Es el mismo modo de falla que ya dejó a ese cron 12 días mudo.
--
-- POR QUÉ UNA FUNCIÓN Y NO UN TEST. El GUC se cambia desde el dashboard de Supabase, sin un
-- commit, que es exactamente el criterio de lo que va al canary. Y PostgREST no expone
-- `pg_settings` ni permite SQL suelto, así que un harness no tiene otra forma de leerlo.
--
-- Devuelve HECHOS, no el nombre de la zona: `now()::timestamp` es lo que la columna guardaría
-- hoy y `now() AT TIME ZONE 'UTC'` es contra qué se lo compara; si esos dos se separan, la
-- ventana está corrida. Comparar el nombre contra 'UTC' sería a la vez demasiado estricto
-- (rechaza 'Etc/UTC', que es lo mismo) y demasiado flojo (acepta cualquier zona que HOY valga
-- 0 y en seis meses no, como 'Europe/London'). Por eso van también los dos offsets a seis
-- meses. El nombre se reporta igual, pero para el mensaje: un rojo tiene que decir qué tocar.
CREATE OR REPLACE FUNCTION public.reloj_ventanas()
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
STABLE
AS $fn$
  SELECT jsonb_build_object(
    -- La zona de ESTA sesión: la que de verdad se aplica al INSERT que entra por PostgREST.
    'timezone_sesion', current_setting('TimeZone'),
    'timezone_default_db', (SELECT reset_val FROM pg_settings WHERE name = 'TimeZone'),
    'desfase_segundos', EXTRACT(EPOCH FROM (now()::timestamp - (now() AT TIME ZONE 'UTC')))::int,
    'tipo_usuarios_created_at', (
      SELECT data_type FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'usuarios' AND column_name = 'created_at'
    )
  );
$fn$;

COMMENT ON FUNCTION public.reloj_ventanas() IS
  'Solo lectura. Zona horaria efectiva de la sesion + desfase entre lo que guarda un timestamp sin zona y UTC. La consume qa-e2e/qa-reloj-ventanas.mjs desde el canary: la ventana del nudge de onboarding compara una columna sin zona contra toISOString(). Ver migrations/075.';

REVOKE ALL ON FUNCTION public.reloj_ventanas() FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reloj_ventanas() TO service_role;
