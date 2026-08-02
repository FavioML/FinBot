-- Deshacer un borrado duro desde el propio rastro de auditoría.
--
-- La 055 dejó la fila completa en `borrados_auditoria.fila`. Esto la devuelve a
-- su tabla. La diferencia práctica con el backup diario, que fue el único camino
-- el 01-ago-2026:
--
--   · El backup diario tiene una ventana de hasta 24h. Todo lo que el usuario
--     registró entre el snapshot y el borrado no está en ningún lado.
--   · Restaurar desde el backup obliga a clonar el proyecto entero (~40 min,
--     cuesta plata mientras existe) y a copiar a mano tabla por tabla.
--   · Esto es inmediato, exacto, y no pierde nada: la fila que se reinserta es
--     literalmente la que se borró, con su id y sus timestamps.
--
-- `on conflict do nothing` hace que correrlo dos veces sea inofensivo: si la fila
-- ya volvió, no pasa nada. El contador del resultado dice qué entró de verdad.

-- Restaura UNA fila de auditoría.
CREATE OR REPLACE FUNCTION public.restaurar_borrado(p_auditoria_id bigint)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  a public.borrados_auditoria;
  n int;
BEGIN
  SELECT * INTO a FROM public.borrados_auditoria WHERE id = p_auditoria_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No existe borrados_auditoria.id = %', p_auditoria_id;
  END IF;
  -- Lista blanca: `format(%I)` ya escapa el identificador, pero la tabla sale de
  -- una fila de datos y no hay motivo para que esta función pueda escribir en
  -- cualquier tabla del esquema.
  IF a.tabla NOT IN ('transacciones', 'deudas', 'deuda_abonos') THEN
    RAISE EXCEPTION 'Tabla fuera del alcance de la auditoría: %', a.tabla;
  END IF;

  EXECUTE format(
    'INSERT INTO public.%I SELECT * FROM jsonb_populate_record(null::public.%I, $1) ON CONFLICT DO NOTHING',
    a.tabla, a.tabla
  ) USING a.fila;
  GET DIAGNOSTICS n = ROW_COUNT;

  RETURN CASE WHEN n = 1
    THEN 'restaurada ' || a.tabla || ' ' || coalesce(a.fila_id, '?')
    ELSE 'ya existía ' || a.tabla || ' ' || coalesce(a.fila_id, '?') END;
END;
$fn$;

COMMENT ON FUNCTION public.restaurar_borrado(bigint) IS
  'Reinserta la fila guardada en borrados_auditoria. Idempotente. Ver migrations/056.';

-- Restaura TODO lo borrado de un usuario en una ventana de tiempo, en orden de FK
-- (deudas antes que deuda_abonos, o el abono no tiene de qué colgarse).
CREATE OR REPLACE FUNCTION public.restaurar_borrados_de(
  p_usuario_id uuid,
  p_desde timestamptz,
  p_hasta timestamptz DEFAULT now()
)
RETURNS TABLE (tabla text, restauradas bigint, ya_estaban bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  r record;
  res text;
BEGIN
  CREATE TEMP TABLE _restauracion (tabla text, ok boolean) ON COMMIT DROP;

  FOR r IN
    SELECT a.id, a.tabla
      FROM public.borrados_auditoria a
     WHERE a.usuario_id = p_usuario_id
       AND a.borrado_at >= p_desde
       AND a.borrado_at <= p_hasta
     ORDER BY CASE a.tabla
                WHEN 'transacciones' THEN 1
                WHEN 'deudas'        THEN 2
                WHEN 'deuda_abonos'  THEN 3
                ELSE 9 END,
              a.id
  LOOP
    res := public.restaurar_borrado(r.id);
    INSERT INTO _restauracion VALUES (r.tabla, res LIKE 'restaurada%');
  END LOOP;

  RETURN QUERY
    SELECT x.tabla, count(*) FILTER (WHERE x.ok), count(*) FILTER (WHERE NOT x.ok)
      FROM _restauracion x GROUP BY x.tabla ORDER BY x.tabla;
END;
$fn$;

COMMENT ON FUNCTION public.restaurar_borrados_de(uuid, timestamptz, timestamptz) IS
  'Deshace todos los borrados duros de un usuario en una ventana, en orden de FK. Idempotente. Ver migrations/056.';

-- Solo administración. El backend no tiene por qué poder deshacer borrados: si
-- alguna vez lo necesita, es una decisión humana mirando la auditoría primero.
REVOKE ALL ON FUNCTION public.restaurar_borrado(bigint) FROM public, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.restaurar_borrados_de(uuid, timestamptz, timestamptz) FROM public, anon, authenticated, service_role;
