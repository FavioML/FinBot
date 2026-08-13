-- 070 — espejo local del trigger que normaliza `transacciones.subcategoria` (drift D4).
--
-- NO CAMBIA NADA EN PROD. Es la declaración de algo que ya está vivo y que hasta hoy no
-- existía en `app/migrations/`: quien leyera este directorio no tenía forma de saber que la
-- DB reescribe una columna que el código escribe. Misma pata de drift que cerró la 059 con
-- `merge_dedupe_fix_aliases`.
--
-- DE DÓNDE SALIÓ, medido el 2026-08-12 contra `supabase_migrations.schema_migrations` (o sea
-- que NO fue una sentencia suelta en la consola: quedó registrada del lado remoto, sin
-- espejo local):
--
--   20260324025223  normalize_subcategoria_trigger   → LOWER(TRIM(...))  + crea el trigger
--   20260324030247  capitalize_subcategoria_trigger  → pasa a capitalizar, 30 min después,
--                                                      y hace el UPDATE masivo del histórico
--   20260623185154  harden_function_search_path_p6   → le fija `SET search_path TO ''`
--
-- QUÉ HACE, medido con un insert+update de control por service-role:
--
--   INSERT subcategoria='QA-PROBE MixedSub'  -> se lee 'Qa-probe mixedsub'
--   UPDATE subcategoria='QA-PROBE OtroSub'   -> se lee 'Qa-probe otrosub'
--
-- Primera letra en mayúscula, resto en minúscula, y `TRIM`. Sólo `subcategoria`, sólo
-- `transacciones`: `categoria` no se toca, y ninguna otra tabla tiene un trigger equivalente
-- (`pg_trigger` sobre `public` devuelve tres: éste y los dos `trg_audit_borrado` de la 055).
-- Tampoco hay reglas (`pg_rules` sobre la tabla = 0), así que el trigger es el mecanismo
-- completo.
--
-- POR QUÉ IMPORTA, y es visible para el usuario. El código escribe los dos centinelas de
-- "no clasificado" en minúscula —`'sin_categoria'` y el string literal `'null'`— y la DB los
-- guarda capitalizados. Al 2026-08-12, sobre 2234 transacciones:
--
--   'Sin_categoria'  499        'sin_categoria'  0
--   'Null'             4        'null'           0
--
-- O sea que el 22.5% de las filas lleva un centinela que ninguna comparación case-SENSITIVE
-- puede reconocer, y esas filas se pintan como si "Sin_categoria" fuera una subcategoría de
-- verdad. El arreglo va del lado del código (helper único, comparación en minúscula); acá
-- sólo queda declarado el mecanismo para que la próxima persona no lo re-descubra.
--
-- LO QUE NO SE HACE, y el porqué:
--
--   · NO se dropea el trigger. Es lo único que impide que "Delivery" y "delivery" convivan
--     como dos subcategorías distintas — el mismo problema que B28/B30 cerraron un nivel
--     arriba, en `categoria`. Sacarlo hoy parte en dos cada sub que se escriba desde dos
--     caminos con capitalización distinta.
--   · NO se hace un UPDATE masivo del centinela a minúscula. El trigger lo volvería a
--     capitalizar en la misma sentencia: el UPDATE saldría "exitoso" y la fila quedaría
--     igual. La representación canónica EN LA DB es la que el trigger produce.
--   · NO se le agrega una excepción al trigger para el centinela. Dejaría el histórico en
--     'Sin_categoria' y lo nuevo en 'sin_categoria': dos grafías vivas del mismo centinela,
--     que es peor que una sola incómoda.
--
-- La definición de abajo es la VIVA en prod (`pg_get_functiondef`), no la de 2026-03-24: el
-- `SET search_path TO ''` viene de la migración de hardening y quitarlo sería una regresión
-- de seguridad. Todo el cuerpo toca sólo campos de `NEW`, así que no necesita calificar nada.

CREATE OR REPLACE FUNCTION public.normalize_subcategoria()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
BEGIN
  IF NEW.subcategoria IS NOT NULL AND NEW.subcategoria != '' THEN
    -- Capitalize first letter, keep rest lowercase, handle underscores
    NEW.subcategoria := CONCAT(
      UPPER(LEFT(TRIM(NEW.subcategoria), 1)),
      LOWER(SUBSTRING(TRIM(NEW.subcategoria) FROM 2))
    );
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_normalize_subcategoria ON public.transacciones;
CREATE TRIGGER trg_normalize_subcategoria
  BEFORE INSERT OR UPDATE ON public.transacciones
  FOR EACH ROW
  EXECUTE FUNCTION public.normalize_subcategoria();

-- Verificación post-aplicación: la definición no cambió y el trigger sigue siendo uno solo.
--   select tgname, pg_get_triggerdef(oid) from pg_trigger
--    where tgrelid = 'public.transacciones'::regclass and not tgisinternal;
-- Y el invariante que el código de arriba asume — que el centinela NO existe en minúscula:
--   select subcategoria, count(*) from transacciones
--    where lower(subcategoria) in ('sin_categoria','null') group by 1;
