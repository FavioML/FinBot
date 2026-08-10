-- 066 — merge_and_link preserva el `bsuid` (auditoría CTO 2026-08-10, hallazgo B13).
--
-- EL BUG: es el MISMO defecto que la 059 (B11), sobre la columna que creó la 065.
-- `merge_and_link` fusiona 31 columnas de `usuarios` a mano, y `bsuid` nació después
-- de la última vez que alguien tocó esa lista. El BSUID vive en la fila de WhatsApp
-- —es lo único que Meta manda cuando el usuario activa un username— y esa fila es
-- SIEMPRE el loser: los dos call-sites (`handlers/webhook.js` en el OTP inverso y
-- `webapp/src/lib/bind-activation.ts` en el link de activación) eligen como survivor
-- la fila web, que es la que tiene el `supabase_auth_id` de la sesión viva.
--
-- O sea que el camino feliz de activación —registro por WhatsApp → link → login
-- Google → merge— BORRA el mapeo BSUID→usuario en el `DELETE FROM usuarios WHERE
-- id = p_loser`. Al usuario que después active un username dejamos de reconocerlo,
-- y `buscarUsuarioPorBsuid` no tiene de dónde recuperarlo: el BSUID solo vuelve si
-- la persona escribe otra vez ANTES de activar el username, que es justo la ventana
-- que la 065 existe para no depender.
--
-- EL FIX: una línea, con la misma forma que el resto de las columnas del survivor.
--   · `COALESCE(s.bsuid, l.bsuid)`: si el survivor ya aprendió el suyo, gana el suyo.
--     Hay un índice único parcial sobre `bsuid` (065), así que no puede haber dos
--     filas con el mismo valor; y el loser ya está borrado cuando corre este UPDATE
--     (línea de `DELETE FROM public.usuarios`), así que copiarlo no colisiona.
--
-- EL GUARD, que es lo que impide el tercer caso: `tests/merge-and-link-columnas.test.js`
-- compara la lista de columnas de `usuarios` (base congelada + las que agregan las
-- migraciones, parseadas del árbol) contra las que este UPDATE nombra. Una columna
-- nueva que nadie clasifique rompe el build. Sin eso, la 067 llega sola.
--
-- Esta versión parte de la definición VIVA en prod (= la 059) y solo AGREGA `bsuid`.

CREATE OR REPLACE FUNCTION public.merge_and_link(p_survivor uuid, p_loser uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  s public.usuarios%ROWTYPE;
  l public.usuarios%ROWTYPE;
  use_loser_premium boolean;
BEGIN
  IF p_survivor IS NULL OR p_loser IS NULL OR p_survivor = p_loser THEN
    RETURN 'noop';
  END IF;

  PERFORM 1 FROM public.usuarios WHERE id IN (p_survivor, p_loser) ORDER BY id FOR UPDATE;
  SELECT * INTO s FROM public.usuarios WHERE id = p_survivor;
  IF NOT FOUND THEN RETURN 'noop'; END IF;
  SELECT * INTO l FROM public.usuarios WHERE id = p_loser;
  IF NOT FOUND THEN RETURN 'noop'; END IF;

  IF l.supabase_auth_id IS NOT NULL AND l.supabase_auth_id <> s.supabase_auth_id THEN
    RETURN 'conflict';
  END IF;

  IF EXISTS (SELECT 1 FROM public.space_members a JOIN public.space_members b ON a.space_id = b.space_id
    WHERE a.user_id = p_survivor AND b.user_id = p_loser) THEN
    RETURN 'conflict';
  END IF;

  IF EXISTS (SELECT 1 FROM public.meta_participantes a JOIN public.meta_participantes b ON a.meta_id = b.meta_id
    WHERE a.usuario_id = p_survivor AND b.usuario_id = p_loser) THEN
    RETURN 'conflict';
  END IF;

  DELETE FROM public.categorias_usuario dl WHERE dl.usuario_id = p_loser
    AND EXISTS (SELECT 1 FROM public.categorias_usuario ds WHERE ds.usuario_id = p_survivor AND ds.nombre = dl.nombre AND ds.padre_id IS NOT DISTINCT FROM dl.padre_id);
  DELETE FROM public.presupuestos dl WHERE dl.usuario_id = p_loser
    AND EXISTS (SELECT 1 FROM public.presupuestos ds WHERE ds.usuario_id = p_survivor AND ds.categoria = dl.categoria AND ds.subcategoria IS NOT DISTINCT FROM dl.subcategoria AND ds.mes = dl.mes AND ds.anio = dl.anio);
  DELETE FROM public.neto_scores dl WHERE dl.user_id = p_loser
    AND EXISTS (SELECT 1 FROM public.neto_scores ds WHERE ds.user_id = p_survivor AND ds.period = dl.period);
  DELETE FROM public.gmail_cuentas dl WHERE dl.usuario_id = p_loser
    AND EXISTS (SELECT 1 FROM public.gmail_cuentas ds WHERE ds.usuario_id = p_survivor AND ds.email = dl.email);
  DELETE FROM public.gmail_excluidos dl WHERE dl.usuario_id = p_loser
    AND EXISTS (SELECT 1 FROM public.gmail_excluidos ds WHERE ds.usuario_id = p_survivor AND ds.descripcion_original = dl.descripcion_original);
  DELETE FROM public.logros dl WHERE dl.usuario_id = p_loser
    AND EXISTS (SELECT 1 FROM public.logros ds WHERE ds.usuario_id = p_survivor AND ds.tipo = dl.tipo AND ds.meta_id IS NOT DISTINCT FROM dl.meta_id);
  DELETE FROM public.recurrentes_overrides dl WHERE dl.usuario_id = p_loser
    AND EXISTS (SELECT 1 FROM public.recurrentes_overrides ds WHERE ds.usuario_id = p_survivor AND ds.dominio = dl.dominio AND ds.clave_variante = dl.clave_variante);
  DELETE FROM public.reglas_comercio dl WHERE dl.usuario_id = p_loser
    AND EXISTS (SELECT 1 FROM public.reglas_comercio ds WHERE ds.usuario_id = p_survivor AND ds.comercio_pattern = dl.comercio_pattern);
  DELETE FROM public.survey_events dl WHERE dl.user_id = p_loser
    AND EXISTS (SELECT 1 FROM public.survey_events ds WHERE ds.user_id = p_survivor AND ds.event_type = dl.event_type);
  DELETE FROM public.transacciones dl WHERE dl.usuario_id = p_loser AND dl.gmail_msg_id IS NOT NULL
    AND EXISTS (SELECT 1 FROM public.transacciones ds WHERE ds.usuario_id = p_survivor AND ds.gmail_msg_id = dl.gmail_msg_id);

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

  DELETE FROM public.referidos r WHERE r.referrer_id = p_loser
    AND EXISTS (SELECT 1 FROM public.referidos t WHERE t.referrer_id = p_survivor AND t.referido_id = r.referido_id);
  UPDATE public.referidos SET referrer_id = p_survivor WHERE referrer_id = p_loser;
  DELETE FROM public.referidos r WHERE r.referido_id = p_loser
    AND EXISTS (SELECT 1 FROM public.referidos t WHERE t.referido_id = p_survivor AND t.referrer_id = r.referrer_id);
  UPDATE public.referidos SET referido_id = p_survivor WHERE referido_id = p_loser;
  DELETE FROM public.referidos WHERE referrer_id = referido_id;

  DELETE FROM public.usuarios WHERE id = p_loser;

  use_loser_premium := (l.plan = 'premium') AND (s.plan <> 'premium' OR COALESCE(l.premium_vence, DATE '0001-01-01') > COALESCE(s.premium_vence, DATE '0001-01-01'));

  UPDATE public.usuarios SET
    whatsapp              = COALESCE(l.whatsapp, s.whatsapp),
    -- ── B13: el mapeo BSUID→usuario sobrevive al merge ─────────────────────────
    -- El BSUID lo trae la fila de WhatsApp, que es siempre el loser. Sin esta
    -- línea, el `DELETE FROM usuarios` de arriba lo destruye y al usuario que
    -- después active un username dejamos de reconocerlo (migración 065).
    bsuid                 = COALESCE(s.bsuid, l.bsuid),
    email                 = COALESCE(s.email, l.email),
    nombre                = COALESCE(s.nombre, l.nombre),
    onboarding_completado = true,
    onboarding_paso       = 0,
    created_at            = LEAST(s.created_at, l.created_at),
    gmail_access_token    = COALESCE(s.gmail_access_token, l.gmail_access_token),
    gmail_refresh_token   = COALESCE(s.gmail_refresh_token, l.gmail_refresh_token),
    gmail_token_expiry    = COALESCE(s.gmail_token_expiry, l.gmail_token_expiry),
    bancos_seleccionados  = COALESCE(s.bancos_seleccionados, l.bancos_seleccionados),
    historico_importado   = (s.historico_importado OR l.historico_importado),
    reporte_gmail_modo    = COALESCE(NULLIF(s.reporte_gmail_modo, ''), l.reporte_gmail_modo, 'unificado'),
    recordatorios_activos = l.recordatorios_activos,
    manos_libres          = (s.manos_libres OR l.manos_libres),
    alertas_transaccion   = (s.alertas_transaccion OR l.alertas_transaccion),
    plan             = CASE WHEN use_loser_premium THEN l.plan ELSE (CASE WHEN s.plan = 'premium' OR l.plan = 'premium' THEN 'premium' ELSE s.plan END) END,
    premium_desde    = CASE WHEN use_loser_premium THEN l.premium_desde ELSE COALESCE(s.premium_desde, l.premium_desde) END,
    premium_vence    = CASE WHEN use_loser_premium THEN l.premium_vence ELSE GREATEST(s.premium_vence, l.premium_vence) END,
    estado_pago      = CASE WHEN use_loser_premium THEN l.estado_pago ELSE s.estado_pago END,
    tipo_plan        = CASE WHEN use_loser_premium THEN l.tipo_plan ELSE s.tipo_plan END,
    fecha_pago       = CASE WHEN use_loser_premium THEN l.fecha_pago ELSE s.fecha_pago END,
    fecha_vencimiento= CASE WHEN use_loser_premium THEN l.fecha_vencimiento ELSE s.fecha_vencimiento END,
    aprobado_gcc     = (s.aprobado_gcc OR l.aprobado_gcc),
    reporte_usos_mes           = GREATEST(COALESCE(s.reporte_usos_mes, 0), COALESCE(l.reporte_usos_mes, 0)),
    reporte_reset_mes          = GREATEST(s.reporte_reset_mes, l.reporte_reset_mes),
    referidos_meses_otorgados  = GREATEST(s.referidos_meses_otorgados, l.referidos_meses_otorgados),
    ref_code                   = COALESCE(s.ref_code, l.ref_code),
    is_test_user               = (s.is_test_user OR l.is_test_user),
    -- ── B11: el estado comercial del trial sobrevive al merge ──────────────────
    -- Ranking: convertido > vencido > activo > NULL. 'vencido' le gana a 'activo'
    -- para que partir la identidad no regale una segunda prueba. Fechas con LEAST
    -- (ignora NULLs): el merge no extiende el reloj de nadie.
    trial_estado = CASE
      WHEN s.trial_estado = 'convertido' OR l.trial_estado = 'convertido' THEN 'convertido'
      WHEN s.trial_estado = 'vencido'    OR l.trial_estado = 'vencido'    THEN 'vencido'
      WHEN s.trial_estado = 'activo'     OR l.trial_estado = 'activo'     THEN 'activo'
      ELSE NULL END,
    trial_inicio = LEAST(s.trial_inicio, l.trial_inicio),
    trial_vence  = LEAST(s.trial_vence,  l.trial_vence)
  WHERE id = p_survivor;

  -- Normalización: si el ranking dejó 'vencido' pero el plan quedó 'premium' solo por
  -- herencia del trial (sin premium_vence vigente ni pago aprobado), eso es el muro.
  -- Sin esto, el caso "trial vencido en un canal + trial fresco en el otro" produciría
  -- otro premium-indefinido, que es justo lo que la 059 mata.
  UPDATE public.usuarios SET plan = 'free'
  WHERE id = p_survivor AND trial_estado = 'vencido' AND plan = 'premium'
    AND premium_vence IS NULL AND COALESCE(estado_pago, '') <> 'pagado';

  RETURN 'linked';
END;
$function$;

-- CREATE OR REPLACE conserva los grants, pero la 047 dejó el patrón explícito: esta
-- función es service-role-only.
REVOKE ALL ON FUNCTION public.merge_and_link(uuid, uuid) FROM PUBLIC, anon, authenticated;
