-- 033: elimina las policies SELECT rotas de las tablas de Espacios.
--
-- CTO audit 2026-07-20, hallazgo D1.
--
-- Las 4 policies SELECT (roles = public) se escribieron para habilitar lectura
-- con anon/authenticated, pero eran inservibles: la de space_members se
-- auto-referenciaba en su propio USING y fallaba con
--   ERROR 42P17: infinite recursion detected in policy for relation "space_members"
-- Como shared_spaces / space_expenses / space_settlements hacen subquery a
-- space_members, las cuatro heredaban el fallo.
--
-- Nunca rompio produccion porque Espacios va 100% por /api/spaces/* con
-- service-role, que bypassa RLS. El problema era la FALSA COBERTURA: parecia que
-- RLS protegia la feature cuando en realidad no se ejecutaba nunca.
--
-- Decision (Favio, 2026-07-21): NO reescribirlas. RLS es la herramienta
-- equivocada para este patron de acceso — el modelo "host paga" obliga a leer la
-- fila `usuarios` del OWNER (otro usuario), cosa que una policy scopeada a
-- auth.uid() no permite. Aun arreglando la recursion seguiria haciendo falta
-- service-role, y ademas no existen policies INSERT/UPDATE/DELETE para
-- authenticated, asi que la webapp tampoco podria escribir por anon-key.
--
-- RLS queda ACTIVO en las 4 tablas => deny-all para anon/authenticated. Las
-- policies `ALL` de service_role se conservan intactas.
--
-- La defensa en profundidad que se pierde se reemplaza por un chokepoint en
-- codigo: lib/spaces-server.ts (requireSpaceMember / requireSpaceOwner), por el
-- que TODA ruta bajo /api/spaces/* debe pasar. Documentado en webapp/CLAUDE.md.

DROP POLICY IF EXISTS "Members can view own spaces" ON shared_spaces;
DROP POLICY IF EXISTS "Members can view space members" ON space_members;
DROP POLICY IF EXISTS "Members can view space expenses" ON space_expenses;
DROP POLICY IF EXISTS "Members can view space settlements" ON space_settlements;
