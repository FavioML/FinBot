-- 016_cascade_delete_usuarios_fks.sql
--
-- Convierte a ON DELETE CASCADE las FK que apuntan a `usuarios` y estaban en NO ACTION.
-- Eso era lo que bloqueaba el borrado de usuarios desde el panel admin: el endpoint
-- borraba a mano solo algunas tablas hijas y dejaba fuera errores, neto_scores,
-- meta_aportes, gasto_participantes, spending_alerts y las tablas de espacios
-- compartidos, así que el DELETE final del usuario reventaba por constraint
-- ("error al eliminar").
--
-- Solo cambia el comportamiento de borrado; no toca datos existentes.
-- Idempotente en la práctica: si ya está en CASCADE, re-aplicar es inofensivo.

ALTER TABLE public.errores DROP CONSTRAINT errores_usuario_id_fkey,
  ADD CONSTRAINT errores_usuario_id_fkey FOREIGN KEY (usuario_id) REFERENCES public.usuarios(id) ON DELETE CASCADE;

ALTER TABLE public.gasto_participantes DROP CONSTRAINT gasto_participantes_usuario_id_fkey,
  ADD CONSTRAINT gasto_participantes_usuario_id_fkey FOREIGN KEY (usuario_id) REFERENCES public.usuarios(id) ON DELETE CASCADE;

ALTER TABLE public.meta_aportes DROP CONSTRAINT meta_aportes_usuario_id_fkey,
  ADD CONSTRAINT meta_aportes_usuario_id_fkey FOREIGN KEY (usuario_id) REFERENCES public.usuarios(id) ON DELETE CASCADE;

ALTER TABLE public.neto_scores DROP CONSTRAINT neto_scores_user_id_fkey,
  ADD CONSTRAINT neto_scores_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.usuarios(id) ON DELETE CASCADE;

ALTER TABLE public.presupuestos DROP CONSTRAINT presupuestos_usuario_id_fkey,
  ADD CONSTRAINT presupuestos_usuario_id_fkey FOREIGN KEY (usuario_id) REFERENCES public.usuarios(id) ON DELETE CASCADE;

ALTER TABLE public.shared_spaces DROP CONSTRAINT shared_spaces_created_by_fkey,
  ADD CONSTRAINT shared_spaces_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.usuarios(id) ON DELETE CASCADE;

ALTER TABLE public.space_expenses DROP CONSTRAINT space_expenses_paid_by_fkey,
  ADD CONSTRAINT space_expenses_paid_by_fkey FOREIGN KEY (paid_by) REFERENCES public.usuarios(id) ON DELETE CASCADE;

ALTER TABLE public.space_members DROP CONSTRAINT space_members_user_id_fkey,
  ADD CONSTRAINT space_members_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.usuarios(id) ON DELETE CASCADE;

ALTER TABLE public.space_settlements DROP CONSTRAINT space_settlements_to_user_fkey,
  ADD CONSTRAINT space_settlements_to_user_fkey FOREIGN KEY (to_user) REFERENCES public.usuarios(id) ON DELETE CASCADE;

ALTER TABLE public.space_settlements DROP CONSTRAINT space_settlements_from_user_fkey,
  ADD CONSTRAINT space_settlements_from_user_fkey FOREIGN KEY (from_user) REFERENCES public.usuarios(id) ON DELETE CASCADE;

ALTER TABLE public.spending_alerts DROP CONSTRAINT spending_alerts_user_id_fkey,
  ADD CONSTRAINT spending_alerts_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.usuarios(id) ON DELETE CASCADE;

ALTER TABLE public.transacciones DROP CONSTRAINT transacciones_usuario_id_fkey,
  ADD CONSTRAINT transacciones_usuario_id_fkey FOREIGN KEY (usuario_id) REFERENCES public.usuarios(id) ON DELETE CASCADE;
