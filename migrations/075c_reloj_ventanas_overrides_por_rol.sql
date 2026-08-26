-- Corrección de `075`/`075b`: `pg_settings.reset_val` NO es "el default de la base", y el
-- diagnóstico que se apoyaba en él no podía dispararse nunca.
--
-- La 075 reportaba `reset_val` al lado de `current_setting('TimeZone')` para contestar
-- "¿alguien le puso un `ALTER ROLE ... SET TimeZone` al rol de PostgREST?". Es al revés:
-- `reset_val` es lo que un `RESET` restauraría EN ESTA SESIÓN, así que **ya absorbe** el
-- `ALTER ROLE` y el `ALTER DATABASE`. Medido en esta misma base: `statement_timeout` tiene
-- `boot_val = 0` y `reset_val = 120000`, o sea que el override de Supabase está adentro del
-- reset_val. Con esa fuente, un `ALTER ROLE ... SET TimeZone` dejaba los dos campos IGUALES y
-- el hint del canary afirmaba que no había override justo en el caso que venía a detectar.
--
-- `pg_db_role_setting` es la tabla que sí contesta: guarda los `SET` por rol y por base, con
-- su `setconfig`. Hoy no tiene ninguna entrada de TimeZone (el valor viene del
-- postgresql.conf); si aparece una, acá se ve con su rol y su base.
--
-- La grafía no es un problema: Postgres canonicaliza el nombre del GUC al guardarlo, así que
-- `ALTER ROLE ... SET timezone`, `SET TIME ZONE` y `SET "TimeZone"` quedan las tres como
-- `TimeZone=...` en `setconfig`. Verificado sobre PG 17.6 con un rol de prueba, ya borrado.
CREATE OR REPLACE FUNCTION public.reloj_ventanas()
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
STABLE
AS $fn$
  SELECT jsonb_build_object(
    'timezone_sesion', current_setting('TimeZone'),
    'overrides_timezone', (
      SELECT coalesce(jsonb_agg(jsonb_build_object(
               'rol', coalesce(r.rolname, '(todos)'),
               'db',  coalesce(d.datname, '(todas)'),
               'cfg', s.setconfig)), '[]'::jsonb)
        FROM pg_db_role_setting s
        LEFT JOIN pg_roles r ON r.oid = s.setrole
        LEFT JOIN pg_database d ON d.oid = s.setdatabase
       WHERE EXISTS (SELECT 1 FROM unnest(s.setconfig) c WHERE c LIKE 'TimeZone=%')
    ),
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
  'Solo lectura. Zona de la sesion, overrides de TimeZone por rol/base (pg_db_role_setting, NO reset_val), desfase entre lo que guarda un timestamp sin zona y UTC, y el offset en enero y julio. La consume qa-e2e/qa-reloj-ventanas.mjs desde el canary. Ver migrations/075c.';

REVOKE ALL ON FUNCTION public.reloj_ventanas() FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reloj_ventanas() TO service_role;
