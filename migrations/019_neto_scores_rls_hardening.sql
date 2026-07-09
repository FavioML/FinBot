-- 019_neto_scores_rls_hardening.sql
--
-- Reconciliación de drift (repo ↔ prod). NO introduce un cambio nuevo de seguridad:
-- la policy de SELECT de `neto_scores` YA está endurecida en producción desde el
-- 2026-06-23 (migraciones remotas `fix_rls_initplan_select_auth` /
-- `fix_public_true_rls_exposure`). El archivo histórico `001_neto_scores.sql` quedó
-- con la versión tautológica original (`user_id = (SELECT id FROM usuarios WHERE id = user_id)`,
-- siempre verdadera → cualquier usuario autenticado podía leer scores de todos).
-- Este archivo deja el repo alineado con la policy viva para que un rebuild limpio
-- de la base reproduzca el estado correcto.
--
-- Aislamiento real: `neto_scores.user_id` referencia `usuarios.id`, pero el JWT trae
-- `auth.uid()` = `usuarios.supabase_auth_id`. El mapeo se hace vía subquery a `usuarios`,
-- que a su vez está protegida por su policy `webapp_read_own_profile`
-- (`supabase_auth_id = auth.uid()`), así el subquery resuelve solo la propia fila bajo
-- el rol authenticated. La webapp lee el historial con el server client (anon + cookie,
-- RLS aplica: `score/route.ts` bloque `history`); las lecturas "current" y el upsert usan
-- service-role (bypass RLS), así que ninguno se rompe con esta policy.
--
-- Idempotente: DROP IF EXISTS + CREATE con el mismo nombre que la policy viva.
-- Re-aplicarlo contra prod es un no-op. La policy de service_role ("Service role full
-- access on neto_scores") no se toca.
--
-- Nota de convención: database.md pide nombrar `<tabla>_<accion>_<rol>`, pero conservamos
-- el nombre "Users can view own scores" para casar exactamente con el objeto ya existente
-- en prod y no generar una policy duplicada.

DROP POLICY IF EXISTS "Users can view own scores" ON public.neto_scores;

CREATE POLICY "Users can view own scores"
  ON public.neto_scores FOR SELECT
  USING (
    user_id IN (
      SELECT id FROM public.usuarios WHERE supabase_auth_id = (SELECT auth.uid())
    )
  );
