-- Introspección del borrado de cuenta, para que un canary pueda vigilarlo sin sembrar nada.
--
-- POR QUÉ HACE FALTA UNA FUNCIÓN. `qa-e2e/qa-borrado-cuenta.mjs` prueba el borrado de verdad,
-- pero para hacerlo tiene que SEMBRAR: crea dos usuarios, una identidad de auth y un objeto de
-- Storage en producción, y cada corrida deja ~16 filas en `borrados_auditoria` — la tabla que
-- existe para investigar el incidente del 01-ago y que la 073 hizo, a propósito, imposible de
-- limpiar desde el backend. Medido el 18-ago: 98 filas escritas en un día de trabajo, sobre una
-- tabla de 727. A cadencia diaria el residuo de QA la domina en meses. Ese harness NO va al
-- canary, y se corre a mano al tocar el borrado.
--
-- Lo que SÍ se rompe sin un commit —el criterio del canary— es el ESQUEMA, y este repo tiene
-- historia: hay 8 migraciones aplicadas desde la consola que nunca pasaron por el árbol. Tres
-- cosas pueden cambiar así y hoy no las vigila nadie:
--
--   1. Alguien agrega una tabla con FK a `usuarios`. El `residual` de `borrar_cuenta_total` la
--      delata, pero sólo si alguien CORRE un borrado.
--   2. Alguien redefine la función desde el dashboard y le cambia los permisos — o se los da a
--      `purgar_auditoria_usuario`, que es la que NO debe tener ninguno: la única puerta al
--      rastro de borrados es una baja de cuenta completa, y eso avisa.
--   3. Alguien le da `DELETE` a `service_role` sobre `borrados_auditoria`, o borra el trigger.
--      Cualquiera de las dos deshace el invariante "o están las filas, o está escrito por qué
--      no están".
--
-- Esta función devuelve los tres hechos en UNA llamada, es `STABLE` y no escribe nada. Es lo
-- único que un harness puede leer del catálogo: PostgREST no expone `pg_constraint`, y el
-- backend no tiene un cliente de Postgres directo.
--
-- No es información sensible —topología de FK y permisos, cero datos de usuario— pero igual va
-- restringida a `service_role`: nadie que no sea el backend tiene por qué enumerar el esquema.
CREATE OR REPLACE FUNCTION public.inventario_borrado_cuenta()
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
STABLE
AS $fn$
  SELECT jsonb_build_object(
    -- 1. Todo lo que cuelga de `usuarios`, con su columna y su ON DELETE.
    'fks', (
      SELECT coalesce(jsonb_agg(jsonb_build_object('ref', tabla || '.' || col, 'on_delete', od)
                                ORDER BY tabla, col), '[]'::jsonb)
      FROM (
        SELECT c.conrelid::regclass::text AS tabla, a.attname AS col, c.confdeltype::text AS od
          FROM pg_constraint c
          JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
         WHERE c.contype = 'f' AND c.confrelid = 'public.usuarios'::regclass
      ) x
    ),
    -- 2. Las funciones del borrado: que existan, que sean SECURITY DEFINER, de quién son, y
    --    QUIÉN puede ejecutarlas. El ACL es el dato que importa: `purgar_auditoria_usuario`
    --    tiene que estar SIN otorgar a service_role.
    'funciones', (
      SELECT coalesce(jsonb_object_agg(p.proname, jsonb_build_object(
               'secdef', p.prosecdef,
               'owner',  pg_get_userbyid(p.proowner),
               'acl',    coalesce(p.proacl::text, '')
             )), '{}'::jsonb)
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('borrar_cuenta_total', 'purgar_auditoria_usuario', 'inventario_borrado_cuenta')
    ),
    -- 3. Qué puede hacer `service_role` sobre las dos tablas append-only, y sobre qué tablas
    --    sigue puesto el trigger de auditoría.
    'grants_auditoria', (
      SELECT coalesce(jsonb_object_agg(k, v), '{}'::jsonb) FROM (
        SELECT table_name AS k, jsonb_agg(DISTINCT privilege_type ORDER BY privilege_type) AS v
          FROM information_schema.role_table_grants
         WHERE table_schema = 'public'
           AND grantee = 'service_role'
           AND table_name IN ('borrados_auditoria', 'purgas_auditoria')
         GROUP BY table_name
      ) g
    ),
    'triggers_auditoria', (
      SELECT coalesce(jsonb_agg(DISTINCT c.relname::text ORDER BY c.relname::text), '[]'::jsonb)
        FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
       WHERE t.tgname = 'trg_audit_borrado' AND NOT t.tgisinternal
    )
  );
$fn$;

COMMENT ON FUNCTION public.inventario_borrado_cuenta() IS
  'Solo lectura. Topologia de FK a usuarios + permisos de las funciones y tablas del borrado. La consume qa-e2e/qa-borrado-estructura.mjs desde el canary, para vigilar lo que cambia SIN un commit. Ver migrations/074.';

REVOKE ALL ON FUNCTION public.inventario_borrado_cuenta() FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.inventario_borrado_cuenta() TO service_role;
