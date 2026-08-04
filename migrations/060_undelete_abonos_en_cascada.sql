-- El undelete restauraba las deudas SIN sus abonos.
--
-- POR QUÉ. `deuda_abonos.deuda_id` es `ON DELETE CASCADE`. Cuando se borra una
-- deuda, Postgres borra sus abonos por la acción referencial, y el trigger de la
-- 055 dispara sobre cada uno. Ahí `audit_borrado()` resuelve el `usuario_id` del
-- abono con un `SELECT` sobre `deudas`... y la deuda padre YA NO ESTÁ. Resultado:
-- la fila de auditoría del abono queda con `usuario_id = NULL`.
--
-- Y `restaurar_borrados_de(p_usuario_id, ...)` selecciona por `usuario_id`. O sea
-- que el camino de recuperación que existe justamente para el incidente del
-- 01-ago-2026 devolvía las deudas con su `monto_pendiente` original y perdía en
-- silencio todo lo que la persona ya había abonado. El contador del resultado
-- decía "2 deudas restauradas" y sonaba a éxito.
--
-- VERIFICADO, no deducido (04-ago-2026): un DO block que crea deuda+abono, borra
-- la deuda y hace ROLLBACK devolvió `deudas=<uuid> | deuda_abonos=NULL`.
--
-- Dos arreglos, y hacen falta los dos porque cubren cosas distintas:
--
--   1. `restaurar_borrados_de` deja de depender del `usuario_id` del abono y lo
--      resuelve por su deuda padre. Esta es LA garantía: no depende del orden en
--      que Postgres dispara los triggers, y además rescata las filas que ya están
--      guardadas con NULL.
--
--   2. `audit_borrado()` gana un tercer fallback: si la deuda padre ya no existe,
--      busca su propia fila de auditoría. Esto NO es lo que sostiene el undelete
--      (para eso está el 1); sirve para la otra mitad del valor de la tabla, que
--      es poder preguntar "¿qué perdió ESTE usuario?" y que los abonos aparezcan.
--      Depende de que la fila del padre se escriba antes que la del hijo, cosa
--      que hoy es cierta (el mismo experimento de arriba mostró el id de `deudas`
--      por debajo del de `deuda_abonos`) pero que es orden de disparo de triggers
--      por nombre, así que no se le confía la garantía.
--
-- Sin backfill: al aplicar esto no hay ninguna fila con `usuario_id` nulo en
-- `borrados_auditoria` (verificado: 242 transacciones, 2 deudas, 2 abonos, cero
-- nulos). Las que vengan quedan cubiertas por el punto 2, y si el orden alguna
-- vez se invierte, por el punto 1.

CREATE OR REPLACE FUNCTION public.audit_borrado()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  j jsonb := to_jsonb(OLD);
BEGIN
  INSERT INTO public.borrados_auditoria (tabla, usuario_id, fila_id, fila, db_user, contexto)
  VALUES (
    TG_TABLE_NAME,
    -- deuda_abonos no tiene usuario_id propio: se resuelve por la deuda padre,
    -- que es justo lo que uno quiere buscar cuando investiga. Si el borrado vino
    -- en CASCADA la deuda ya no existe, así que el último recurso es la fila de
    -- auditoría que ella misma dejó un instante antes.
    COALESCE(
      NULLIF(j ->> 'usuario_id', '')::uuid,
      (SELECT d.usuario_id FROM public.deudas d WHERE d.id = NULLIF(j ->> 'deuda_id', '')::uuid),
      (SELECT b.usuario_id
         FROM public.borrados_auditoria b
        WHERE b.tabla = 'deudas'
          AND b.fila_id = NULLIF(j ->> 'deuda_id', '')
          AND b.usuario_id IS NOT NULL
        ORDER BY b.id DESC
        LIMIT 1)
    ),
    j ->> 'id',
    j,
    current_user,
    jsonb_strip_nulls(jsonb_build_object(
      'app_name',     NULLIF(current_setting('application_name', true), ''),
      'client_addr',  host(inet_client_addr()),
      'req_method',   NULLIF(current_setting('request.method', true), ''),
      'req_path',     NULLIF(current_setting('request.path', true), ''),
      -- PostgREST movió los claims de GUCs sueltos a un JSON; se leen los dos
      -- porque el `true` de missing_ok hace que el que no exista devuelva null.
      'jwt_role',     COALESCE(
                        NULLIF(current_setting('request.jwt.claim.role', true), ''),
                        NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'
                      )
    ))
  );
  RETURN OLD;
END;
$$;

COMMENT ON FUNCTION public.audit_borrado() IS
  'Trigger AFTER DELETE: copia la fila borrada a borrados_auditoria. No bloquea; solo deja rastro. El usuario_id de deuda_abonos se resuelve por la deuda padre viva o, si el borrado fue en cascada, por la fila de auditoria que ella dejo (migr 060).';

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
                 -- la deuda padre también se borró y su rastro es de este usuario
                 EXISTS (SELECT 1 FROM public.borrados_auditoria b
                          WHERE b.tabla = 'deudas'
                            AND b.usuario_id = p_usuario_id
                            AND b.fila_id = a.fila ->> 'deuda_id')
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
  'Deshace todos los borrados duros de un usuario en una ventana, en orden de FK. Incluye los abonos que la cascada dejo sin usuario_id (migr 060). Idempotente. Ver migrations/056.';

-- Se recrean con CREATE OR REPLACE, que conserva los grants existentes de la 056
-- (nadie salvo `postgres`). Se repiten igual: si algun dia alguien recrea la
-- funcion a mano sin REVOKE, el default de Postgres es EXECUTE para PUBLIC.
REVOKE ALL ON FUNCTION public.restaurar_borrados_de(uuid, timestamptz, timestamptz) FROM public, anon, authenticated, service_role;
