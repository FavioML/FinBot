-- 046_web_first_identity_merge.sql
--
-- Onboarding web-independiente: permite crear una cuenta de Neto desde la webapp
-- (login Google) SIN número de WhatsApp, con WhatsApp como vínculo opcional posterior.
--
-- Dos cambios:
--
-- 1. `usuarios.whatsapp` pasa a NULLABLE. Hasta ahora era la identidad de facto
--    (NOT NULL + UNIQUE). El unique se mantiene: un btree simple trata cada NULL como
--    distinto, así que múltiples usuarios web (whatsapp NULL) conviven y cualquier
--    número real sigue siendo único.
--
-- 2. Función `merge_and_link(survivor, loser)`: fusiona dos filas de `usuarios` en una
--    sola, de forma ATÓMICA. La dispara el reverse-OTP del webhook cuando un usuario
--    nacido en web (fila con supabase_auth_id) prueba posesión de un número que ya tenía
--    su propia fila (creada por el bot). El survivor conserva el auth_id (la sesión web
--    viva sigue mapeando por él); la fila del número se pliega dentro y se borra.
--
--    La seguridad del reverse-OTP NO se relaja: esta función solo corre tras probar
--    posesión del número (mensaje entrante desde ese WhatsApp).
--
-- Aplicado en vivo a Supabase (proyecto zvorjqlubmfrjtkbhqcx) el 2026-07-31, validado
-- con el harness qa-e2e/qa-web-signup-merge.mjs (merge feliz + conflictos auth/espacio).

-- ── 1. whatsapp nullable ────────────────────────────────────────────────────
ALTER TABLE public.usuarios ALTER COLUMN whatsapp DROP NOT NULL;

-- ── 2. merge_and_link ───────────────────────────────────────────────────────
-- Devuelve:
--   'linked'   → fusión completada, survivor quedó con el número + toda la data.
--   'conflict' → no se fusiona (el caller no marca el OTP verificado; va a soporte).
--   'noop'     → nada que hacer (misma fila, o alguna no existe).
--
-- Condiciones de 'conflict' (bordes genuinamente inseguros para v1):
--   a) el loser ya está vinculado a OTRA cuenta Google (auth_id distinto).
--   b) survivor y loser comparten un espacio (space_members) o una meta compartida
--      (meta_participantes): fusionarlos corrompería balances/settlements y los % de
--      reparto. Se rutea a soporte para merge manual.
--
-- Orden crítico: se repuntan los hijos ANTES de borrar el loser (si no, el CASCADE
-- borraría la data que queremos mover). Los escalares se fusionan DESPUÉS del delete,
-- para que whatsapp/email del survivor no colisionen con los del loser en la ventana.
CREATE OR REPLACE FUNCTION public.merge_and_link(p_survivor uuid, p_loser uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  s public.usuarios%ROWTYPE;
  l public.usuarios%ROWTYPE;
  use_loser_premium boolean;
BEGIN
  IF p_survivor IS NULL OR p_loser IS NULL OR p_survivor = p_loser THEN
    RETURN 'noop';
  END IF;

  -- Lock de ambas filas en orden estable por id (evita deadlocks entre webhooks
  -- concurrentes). Luego se leen por rol.
  PERFORM 1 FROM public.usuarios WHERE id IN (p_survivor, p_loser) ORDER BY id FOR UPDATE;
  SELECT * INTO s FROM public.usuarios WHERE id = p_survivor;
  IF NOT FOUND THEN RETURN 'noop'; END IF;
  SELECT * INTO l FROM public.usuarios WHERE id = p_loser;
  IF NOT FOUND THEN RETURN 'noop'; END IF;

  -- (a) el número ya es de otra cuenta Google.
  IF l.supabase_auth_id IS NOT NULL AND l.supabase_auth_id <> s.supabase_auth_id THEN
    RETURN 'conflict';
  END IF;

  -- (b) espacio compartido.
  IF EXISTS (
    SELECT 1 FROM public.space_members a
    JOIN public.space_members b ON a.space_id = b.space_id
    WHERE a.user_id = p_survivor AND b.user_id = p_loser
  ) THEN
    RETURN 'conflict';
  END IF;

  -- (b) meta compartida.
  IF EXISTS (
    SELECT 1 FROM public.meta_participantes a
    JOIN public.meta_participantes b ON a.meta_id = b.meta_id
    WHERE a.usuario_id = p_survivor AND b.usuario_id = p_loser
  ) THEN
    RETURN 'conflict';
  END IF;

  -- ── Re-point de hijos: loser → survivor ────────────────────────────────────
  UPDATE public.categorias_usuario      SET usuario_id = p_survivor WHERE usuario_id = p_loser;
  UPDATE public.conversaciones          SET usuario_id = p_survivor WHERE usuario_id = p_loser;
  UPDATE public.deudas                  SET usuario_id = p_survivor WHERE usuario_id = p_loser;
  UPDATE public.errores                 SET usuario_id = p_survivor WHERE usuario_id = p_loser;
  UPDATE public.gasto_participantes     SET usuario_id = p_survivor WHERE usuario_id = p_loser;
  UPDATE public.gastos_compartidos      SET creador_id = p_survivor WHERE creador_id = p_loser;
  UPDATE public.gmail_cuentas           SET usuario_id = p_survivor WHERE usuario_id = p_loser;
  UPDATE public.gmail_excluidos         SET usuario_id = p_survivor WHERE usuario_id = p_loser;
  UPDATE public.logros                  SET usuario_id = p_survivor WHERE usuario_id = p_loser;
  UPDATE public.meta_aportes            SET usuario_id = p_survivor WHERE usuario_id = p_loser;
  UPDATE public.meta_participantes      SET usuario_id = p_survivor WHERE usuario_id = p_loser;
  UPDATE public.metas_ahorro            SET usuario_id = p_survivor WHERE usuario_id = p_loser;
  UPDATE public.neto_scores             SET user_id    = p_survivor WHERE user_id    = p_loser;
  UPDATE public.nlp_errors              SET usuario_id = p_survivor WHERE usuario_id = p_loser;
  UPDATE public.notificaciones          SET usuario_id = p_survivor WHERE usuario_id = p_loser;
  UPDATE public.notification_deliveries SET usuario_id = p_survivor WHERE usuario_id = p_loser;
  UPDATE public.pagos                   SET usuario_id = p_survivor WHERE usuario_id = p_loser;
  UPDATE public.presupuestos            SET usuario_id = p_survivor WHERE usuario_id = p_loser;
  UPDATE public.recurrentes_overrides   SET usuario_id = p_survivor WHERE usuario_id = p_loser;
  UPDATE public.reglas_comercio         SET usuario_id = p_survivor WHERE usuario_id = p_loser;
  UPDATE public.shared_spaces           SET created_by = p_survivor WHERE created_by = p_loser;
  UPDATE public.space_expenses          SET paid_by    = p_survivor WHERE paid_by    = p_loser;
  UPDATE public.space_members           SET user_id    = p_survivor WHERE user_id    = p_loser;
  UPDATE public.space_settlements       SET to_user    = p_survivor WHERE to_user    = p_loser;
  UPDATE public.space_settlements       SET from_user  = p_survivor WHERE from_user  = p_loser;
  UPDATE public.spending_alerts         SET user_id    = p_survivor WHERE user_id    = p_loser;
  UPDATE public.survey_events           SET user_id    = p_survivor WHERE user_id    = p_loser;
  UPDATE public.tickets_soporte         SET usuario_id = p_survivor WHERE usuario_id = p_loser;
  UPDATE public.transacciones           SET usuario_id = p_survivor WHERE usuario_id = p_loser;
  UPDATE public.transacciones_eliminadas SET usuario_id = p_survivor WHERE usuario_id = p_loser;

  -- referidos: unique(referido_id, referrer_id). Borrar colisiones antes de re-pointar,
  -- y limpiar auto-referidos que la fusión pudiera crear.
  DELETE FROM public.referidos r WHERE r.referrer_id = p_loser
    AND EXISTS (SELECT 1 FROM public.referidos t WHERE t.referrer_id = p_survivor AND t.referido_id = r.referido_id);
  UPDATE public.referidos SET referrer_id = p_survivor WHERE referrer_id = p_loser;
  DELETE FROM public.referidos r WHERE r.referido_id = p_loser
    AND EXISTS (SELECT 1 FROM public.referidos t WHERE t.referido_id = p_survivor AND t.referrer_id = r.referrer_id);
  UPDATE public.referidos SET referido_id = p_survivor WHERE referido_id = p_loser;
  DELETE FROM public.referidos WHERE referrer_id = referido_id;

  -- ── Borrar el loser (ya sin hijos) ─────────────────────────────────────────
  DELETE FROM public.usuarios WHERE id = p_loser;

  -- ── Fusión de escalares en el survivor ─────────────────────────────────────
  -- No degradar a un usuario que paga: si cualquiera es premium, el survivor queda
  -- premium adoptando el bloque de pago de la suscripción más vigente.
  use_loser_premium := (l.plan = 'premium')
    AND (s.plan <> 'premium'
         OR COALESCE(l.premium_vence, DATE '0001-01-01') > COALESCE(s.premium_vence, DATE '0001-01-01'));

  UPDATE public.usuarios SET
    whatsapp              = COALESCE(l.whatsapp, s.whatsapp),
    email                 = COALESCE(s.email, l.email),
    nombre                = COALESCE(s.nombre, l.nombre),
    onboarding_completado = true,
    onboarding_paso       = 0,
    created_at            = LEAST(s.created_at, l.created_at),
    -- Gmail: conserva la conexión de quien la tenga (típicamente la fila WhatsApp).
    gmail_access_token    = COALESCE(s.gmail_access_token, l.gmail_access_token),
    gmail_refresh_token   = COALESCE(s.gmail_refresh_token, l.gmail_refresh_token),
    gmail_token_expiry    = COALESCE(s.gmail_token_expiry, l.gmail_token_expiry),
    bancos_seleccionados  = COALESCE(s.bancos_seleccionados, l.bancos_seleccionados),
    historico_importado   = (s.historico_importado OR l.historico_importado),
    reporte_gmail_modo    = COALESCE(NULLIF(s.reporte_gmail_modo, ''), l.reporte_gmail_modo, 'unificado'),
    -- Preferencias del usuario WhatsApp activo (el que recibe mensajes por chat).
    recordatorios_activos = l.recordatorios_activos,
    manos_libres          = (s.manos_libres OR l.manos_libres),
    alertas_transaccion   = (s.alertas_transaccion OR l.alertas_transaccion),
    -- Bloque premium / pago (coherente: todo del ganador).
    plan             = CASE WHEN use_loser_premium THEN l.plan            ELSE (CASE WHEN s.plan = 'premium' OR l.plan = 'premium' THEN 'premium' ELSE s.plan END) END,
    premium_desde    = CASE WHEN use_loser_premium THEN l.premium_desde   ELSE COALESCE(s.premium_desde, l.premium_desde) END,
    premium_vence    = CASE WHEN use_loser_premium THEN l.premium_vence   ELSE GREATEST(s.premium_vence, l.premium_vence) END,
    estado_pago      = CASE WHEN use_loser_premium THEN l.estado_pago     ELSE s.estado_pago END,
    tipo_plan        = CASE WHEN use_loser_premium THEN l.tipo_plan       ELSE s.tipo_plan END,
    fecha_pago       = CASE WHEN use_loser_premium THEN l.fecha_pago      ELSE s.fecha_pago END,
    fecha_vencimiento= CASE WHEN use_loser_premium THEN l.fecha_vencimiento ELSE s.fecha_vencimiento END,
    aprobado_gcc     = (s.aprobado_gcc OR l.aprobado_gcc),
    -- Contadores: conservadores (no regalar cuota ni re-otorgar meses de referido).
    reporte_usos_mes           = GREATEST(COALESCE(s.reporte_usos_mes, 0), COALESCE(l.reporte_usos_mes, 0)),
    reporte_reset_mes          = GREATEST(s.reporte_reset_mes, l.reporte_reset_mes),
    referidos_meses_otorgados  = GREATEST(s.referidos_meses_otorgados, l.referidos_meses_otorgados),
    ref_code                   = COALESCE(s.ref_code, l.ref_code),
    is_test_user               = (s.is_test_user OR l.is_test_user)
  WHERE id = p_survivor;

  RETURN 'linked';
END;
$$;

-- Solo el service-role (server) la invoca. Cerrar a roles cliente.
REVOKE ALL ON FUNCTION public.merge_and_link(uuid, uuid) FROM PUBLIC, anon, authenticated;
