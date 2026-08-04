-- Endurece lo que agregó la 060, sobre dos cosas que ese cambio hizo posibles.
--
-- 1. ÍNDICE (tabla, fila_id).
--    La 060 le dio a `audit_borrado()` un tercer fallback que busca al padre en
--    `borrados_auditoria` por `(tabla='deudas', fila_id=<deuda_id>)`. Eso corre
--    DENTRO de un trigger AFTER DELETE, **una vez por abono cascadeado**, sobre
--    una tabla append-only sin retención (246 filas hoy, crece y no baja nunca).
--    Sin índice es un seq scan por abono: borrar un usuario con deudas largas es
--    O(abonos × filas_de_auditoría). Los índices que había eran por `borrado_at`
--    y por `(usuario_id, borrado_at)`, ninguno sirve para esta búsqueda.
--    `restaurar_borrados_de` hace el mismo lookup y también se beneficia.
--
-- 2. LA VENTANA APLICA TAMBIÉN AL PADRE.
--    `restaurar_borrados_de` restaura en orden de FK: deudas (2) antes que
--    deuda_abonos (3). Ese orden es lo único que evita que reinsertar un abono
--    reviente por FK contra una deuda que no existe — y `restaurar_borrado` no
--    atrapa excepciones, así que una violación aborta la función entera y revierte
--    todo lo ya restaurado en esa llamada.
--    El clause nuevo de la 060 selecciona abonos huérfanos preguntando si existe
--    el rastro del padre, SIN exigir que ese rastro caiga dentro de [p_desde,
--    p_hasta]. En un borrado en cascada las dos filas comparten `borrado_at`, así
--    que hoy entran o salen juntas; pero si alguna vez no lo hacen, el abono entra
--    al loop y su deuda no, y se lleva puesta la restauración completa. Acotar el
--    lookup del padre a la misma ventana convierte "el padre se restaura antes"
--    en algo garantizado por la query y no por una coincidencia de timestamps.
--    (La otra rama —el padre sigue vivo en `deudas`— ya es segura por definición.)

CREATE INDEX IF NOT EXISTS idx_borrados_auditoria_tabla_fila
  ON public.borrados_auditoria (tabla, fila_id);

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
     WHERE a.borrado_at >= p_desde
       AND a.borrado_at <= p_hasta
       AND (
            a.usuario_id = p_usuario_id
            -- Un abono borrado EN CASCADA no pudo resolver su dueño: la deuda
            -- padre ya no existía cuando corrió el trigger. Se resuelve acá por
            -- la deuda, sin depender de en qué orden dispararon los triggers.
            --
            -- `usuario_id IS NULL` a propósito: solo se rescata lo que no pudo
            -- resolver dueño. Una fila con un usuario_id DISTINTO no se
            -- re-atribuye — sería una inconsistencia de datos, y taparla
            -- moviendo plata de un usuario a otro es peor que dejarla a la vista.
            OR (a.tabla = 'deuda_abonos' AND a.usuario_id IS NULL AND (
                 -- la deuda padre también se borró, es de este usuario, y su
                 -- rastro cae DENTRO de la ventana: o sea que el loop la va a
                 -- restaurar antes (ORDER BY de abajo) y la FK del abono cierra.
                 EXISTS (SELECT 1 FROM public.borrados_auditoria b
                          WHERE b.tabla = 'deudas'
                            AND b.usuario_id = p_usuario_id
                            AND b.fila_id = a.fila ->> 'deuda_id'
                            AND b.borrado_at >= p_desde
                            AND b.borrado_at <= p_hasta)
                 -- o la deuda padre sigue viva (o ya fue restaurada) y es suya
                 OR EXISTS (SELECT 1 FROM public.deudas d
                             WHERE d.id = NULLIF(a.fila ->> 'deuda_id', '')::uuid
                               AND d.usuario_id = p_usuario_id)
               ))
           )
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
  'Deshace todos los borrados duros de un usuario en una ventana, en orden de FK. Incluye los abonos que la cascada dejo sin usuario_id, siempre que su deuda padre tambien entre en la ventana o siga viva (migr 060 + 063). Idempotente. Ver migrations/056.';

REVOKE ALL ON FUNCTION public.restaurar_borrados_de(uuid, timestamptz, timestamptz) FROM public, anon, authenticated, service_role;
