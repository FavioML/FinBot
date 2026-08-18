-- El inventario también expone el HASH del cuerpo de las dos funciones del borrado.
--
-- Sin esto, el canary estructural vigila la topología de FK y los permisos, pero NO la lógica:
-- alguien podía redefinir `borrar_cuenta_total` desde el editor SQL del dashboard —sacarle un
-- DELETE, ensanchar la allowlist del `residual`, quitarle el corte de idempotencia— y todo
-- seguía verde. El guard estático de `tests/services/account-deletion.test.js` tampoco lo ve:
-- ese lee el ARCHIVO `.sql` del repo, no lo que está vivo en la base.
--
-- Y este repo tiene historia con eso: `app/CLAUDE.md` documenta 8 migraciones aplicadas desde
-- la consola que nunca pasaron por el árbol, y dos (068, 069) que ni siquiera dejaron fila en
-- el ledger. O sea que "el archivo dice X" y "la función hace X" son dos afirmaciones distintas.
--
-- El precio, y es a propósito: **cualquier** cambio a estas funciones pone el canary en rojo
-- hasta que alguien actualice el hash esperado en `qa-e2e/qa-borrado-estructura.mjs`. Cambia
-- incluso con un comentario. Para el resto del código sería insoportable; para la función que
-- borra cuentas de forma irreversible, que un cambio exija una línea de reconocimiento explícito
-- es exactamente lo que se quiere.
CREATE OR REPLACE FUNCTION public.inventario_borrado_cuenta()
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
STABLE
AS $fn$
  SELECT jsonb_build_object(
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
    'funciones', (
      SELECT coalesce(jsonb_object_agg(p.proname, jsonb_build_object(
               'secdef', p.prosecdef,
               'owner',  pg_get_userbyid(p.proowner),
               'acl',    coalesce(p.proacl::text, ''),
               -- El cuerpo VIVO, no el del archivo. `inventario_borrado_cuenta` se excluye del
               -- pin mas abajo: se hashea a si misma y cambiaria con su propia migracion.
               'src_md5', md5(p.prosrc)
             )), '{}'::jsonb)
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('borrar_cuenta_total', 'purgar_auditoria_usuario', 'inventario_borrado_cuenta')
    ),
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

REVOKE ALL ON FUNCTION public.inventario_borrado_cuenta() FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.inventario_borrado_cuenta() TO service_role;
