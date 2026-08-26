-- Corrección de `075`: el desfase de HOY no alcanza para decir que la base guarda en UTC.
--
-- La 075 decidía con `desfase_segundos`, que compara lo que la columna GUARDARÍA
-- (`now()::timestamp`) contra lo que el cron le COMPARA (`now() AT TIME ZONE 'UTC'`). Eso
-- responde por el instante en que se corre y por ninguno más: una zona con horario de verano
-- vale 0 medio año y se corre sola el otro medio, así que el guard habría salido VERDE hasta
-- que cambiara el reloj — y la ventana del nudge de onboarding se corre sin que nadie toque
-- nada. `Atlantic/Azores` es el caso concreto: 0 en agosto, -1 en enero. Verificado corriendo
-- `qa-e2e/qa-reloj-ventanas.mjs` contra esa zona: con la 075 salía verde, con ésta sale rojo.
--
-- Se mide el offset de la zona en dos instantes a seis meses, con fechas FIJAS para que la
-- respuesta no dependa de cuándo se corrió. Los dos en 0 = la zona es UTC todo el año, se
-- llame como se llame ('Etc/UTC' y 'UCT' pasan). Comparar el NOMBRE contra 'UTC' fallaba por
-- los dos lados a la vez: rechazaba 'Etc/UTC' (falsa alarma diaria, y una falsa alarma diaria
-- termina en que nadie mira el rojo) y aceptaba 'Europe/London'.
CREATE OR REPLACE FUNCTION public.reloj_ventanas()
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
STABLE
AS $fn$
  SELECT jsonb_build_object(
    'timezone_sesion', current_setting('TimeZone'),
    'timezone_default_db', (SELECT reset_val FROM pg_settings WHERE name = 'TimeZone'),
    'desfase_segundos', EXTRACT(EPOCH FROM (now()::timestamp - (now() AT TIME ZONE 'UTC')))::int,
    'offset_enero_segundos', EXTRACT(EPOCH FROM (
        (timestamptz '2026-01-15 12:00:00+00' AT TIME ZONE current_setting('TimeZone'))
        - timestamp '2026-01-15 12:00:00'))::int,
    'offset_julio_segundos', EXTRACT(EPOCH FROM (
        (timestamptz '2026-07-15 12:00:00+00' AT TIME ZONE current_setting('TimeZone'))
        - timestamp '2026-07-15 12:00:00'))::int,
    'tipo_usuarios_created_at', (
      SELECT data_type FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'usuarios' AND column_name = 'created_at'
    )
  );
$fn$;

COMMENT ON FUNCTION public.reloj_ventanas() IS
  'Solo lectura. Zona horaria efectiva de la sesion, desfase entre lo que guarda un timestamp sin zona y UTC, y el offset de la zona en enero y julio (para que una zona con DST no pase en verde medio ano). La consume qa-e2e/qa-reloj-ventanas.mjs desde el canary. Ver migrations/075.';

REVOKE ALL ON FUNCTION public.reloj_ventanas() FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reloj_ventanas() TO service_role;
