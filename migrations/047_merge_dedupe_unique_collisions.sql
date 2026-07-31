-- 047_merge_dedupe_unique_collisions.sql
--
-- Fix de merge_and_link (migr 046): la fusión abortaba cuando ambas filas (web y
-- WhatsApp) tenían datos que chocaban en un índice único por (usuario_id, ...).
-- Ejemplo garantizado: las categorías default. Un usuario web-first tiene las 11
-- categorías sembradas y un usuario WhatsApp tiene las suyas con los mismos nombres;
-- al repuntar loser→survivor, "Alimentación" del loser choca con la del survivor
-- (unique categorias_usuario(usuario_id, nombre, padre_id)) → unique_violation →
-- toda la transacción del merge hace rollback y no se fusiona nada.
--
-- Solución: antes de repuntar cada tabla con unique compuesto por dueño, borrar las
-- filas del loser que colisionarían con una fila ya existente del survivor (se conserva
-- la del survivor). Mismo patrón que ya se usaba para `referidos`.
--
-- Tablas con unique (usuario_id|user_id, ...) que se deduplican:
--   categorias_usuario (nombre, padre_id)            [padre_id FK CASCADE: al borrar
--                                                      un padre duplicado caen sus subs]
--   presupuestos       (categoria, subcategoria, mes, anio)
--   neto_scores        (period)
--   gmail_cuentas      (email)
--   gmail_excluidos    (descripcion_original)
--   logros             (tipo, meta_id)
--   recurrentes_overrides (dominio, clave_variante)
--   reglas_comercio    (comercio_pattern)
--   survey_events      (event_type)
--   transacciones      (gmail_msg_id)   [solo filas con gmail_msg_id no nulo]
--
-- Se conserva la fila del survivor en cada colisión (categorías/score/etc. son
-- metadata regenerable o de bajo valor; lo crítico —transacciones sin gmail_msg_id,
-- deudas, metas— no tiene unique por dueño y se une completo).
--
-- Aplicado en vivo a Supabase (proyecto zvorjqlubmfrjtkbhqcx) el 2026-07-31.

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

  PERFORM 1 FROM public.usuarios WHERE id IN (p_survivor, p_loser) ORDER BY id FOR UPDATE;
  SELECT * INTO s FROM public.usuarios WHERE id = p_survivor;
  IF NOT FOUND THEN RETURN 'noop'; END IF;
  SELECT * INTO l FROM public.usuarios WHERE id = p_loser;
  IF NOT FOUND THEN RETURN 'noop'; END IF;

  IF l.supabase_auth_id IS NOT NULL AND l.supabase_auth_id <> s.supabase_auth_id THEN
    RETURN 'conflict';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.space_members a
    JOIN public.space_members b ON a.space_id = b.space_id
    WHERE a.user_id = p_survivor AND b.user_id = p_loser
  ) THEN
    RETURN 'conflict';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.meta_participantes a
    JOIN public.meta_participantes b ON a.meta_id = b.meta_id
    WHERE a.usuario_id = p_survivor AND b.usuario_id = p_loser
  ) THEN
    RETURN 'conflict';
  END IF;

  -- ── Dedup de colisiones de unique compuesto (borra la del loser, conserva survivor) ──
  -- categorias_usuario: solo colisionan los padres (subs difieren por padre_id); el
  -- CASCADE de padre_id limpia las subs del padre duplicado que se borra.
  -- Alias dl/ds (no L/S): en plpgsql, un alias `l`/`s` chocaría con las variables
  -- ROWTYPE `l`/`s` (identificadores case-insensitive) y rompería la resolución.
  DELETE FROM public.categorias_usuario dl WHERE dl.usuario_id = p_loser
    AND EXISTS (SELECT 1 FROM public.categorias_usuario ds
      WHERE ds.usuario_id = p_survivor AND ds.nombre = dl.nombre
        AND ds.padre_id IS NOT DISTINCT FROM dl.padre_id);

  DELETE FROM public.presupuestos dl WHERE dl.usuario_id = p_loser
    AND EXISTS (SELECT 1 FROM public.presupuestos ds
      WHERE ds.usuario_id = p_survivor AND ds.categoria = dl.categoria
        AND ds.subcategoria IS NOT DISTINCT FROM dl.subcategoria
        AND ds.mes = dl.mes AND ds.anio = dl.anio);

  DELETE FROM public.neto_scores dl WHERE dl.user_id = p_loser
    AND EXISTS (SELECT 1 FROM public.neto_scores ds
      WHERE ds.user_id = p_survivor AND ds.period = dl.period);

  DELETE FROM public.gmail_cuentas dl WHERE dl.usuario_id = p_loser
    AND EXISTS (SELECT 1 FROM public.gmail_cuentas ds
      WHERE ds.usuario_id = p_survivor AND ds.email = dl.email);

  DELETE FROM public.gmail_excluidos dl WHERE dl.usuario_id = p_loser
    AND EXISTS (SELECT 1 FROM public.gmail_excluidos ds
      WHERE ds.usuario_id = p_survivor AND ds.descripcion_original = dl.descripcion_original);

  DELETE FROM public.logros dl WHERE dl.usuario_id = p_loser
    AND EXISTS (SELECT 1 FROM public.logros ds
      WHERE ds.usuario_id = p_survivor AND ds.tipo = dl.tipo
        AND ds.meta_id IS NOT DISTINCT FROM dl.meta_id);

  DELETE FROM public.recurrentes_overrides dl WHERE dl.usuario_id = p_loser
    AND EXISTS (SELECT 1 FROM public.recurrentes_overrides ds
      WHERE ds.usuario_id = p_survivor AND ds.dominio = dl.dominio
        AND ds.clave_variante = dl.clave_variante);

  DELETE FROM public.reglas_comercio dl WHERE dl.usuario_id = p_loser
    AND EXISTS (SELECT 1 FROM public.reglas_comercio ds
      WHERE ds.usuario_id = p_survivor AND ds.comercio_pattern = dl.comercio_pattern);

  DELETE FROM public.survey_events dl WHERE dl.user_id = p_loser
    AND EXISTS (SELECT 1 FROM public.survey_events ds
      WHERE ds.user_id = p_survivor AND ds.event_type = dl.event_type);

  DELETE FROM public.transacciones dl WHERE dl.usuario_id = p_loser AND dl.gmail_msg_id IS NOT NULL
    AND EXISTS (SELECT 1 FROM public.transacciones ds
      WHERE ds.usuario_id = p_survivor AND ds.gmail_msg_id = dl.gmail_msg_id);

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

  DELETE FROM public.referidos r WHERE r.referrer_id = p_loser
    AND EXISTS (SELECT 1 FROM public.referidos t WHERE t.referrer_id = p_survivor AND t.referido_id = r.referido_id);
  UPDATE public.referidos SET referrer_id = p_survivor WHERE referrer_id = p_loser;
  DELETE FROM public.referidos r WHERE r.referido_id = p_loser
    AND EXISTS (SELECT 1 FROM public.referidos t WHERE t.referido_id = p_survivor AND t.referrer_id = r.referrer_id);
  UPDATE public.referidos SET referido_id = p_survivor WHERE referido_id = p_loser;
  DELETE FROM public.referidos WHERE referrer_id = referido_id;

  DELETE FROM public.usuarios WHERE id = p_loser;

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
    gmail_access_token    = COALESCE(s.gmail_access_token, l.gmail_access_token),
    gmail_refresh_token   = COALESCE(s.gmail_refresh_token, l.gmail_refresh_token),
    gmail_token_expiry    = COALESCE(s.gmail_token_expiry, l.gmail_token_expiry),
    bancos_seleccionados  = COALESCE(s.bancos_seleccionados, l.bancos_seleccionados),
    historico_importado   = (s.historico_importado OR l.historico_importado),
    reporte_gmail_modo    = COALESCE(NULLIF(s.reporte_gmail_modo, ''), l.reporte_gmail_modo, 'unificado'),
    recordatorios_activos = l.recordatorios_activos,
    manos_libres          = (s.manos_libres OR l.manos_libres),
    alertas_transaccion   = (s.alertas_transaccion OR l.alertas_transaccion),
    plan             = CASE WHEN use_loser_premium THEN l.plan            ELSE (CASE WHEN s.plan = 'premium' OR l.plan = 'premium' THEN 'premium' ELSE s.plan END) END,
    premium_desde    = CASE WHEN use_loser_premium THEN l.premium_desde   ELSE COALESCE(s.premium_desde, l.premium_desde) END,
    premium_vence    = CASE WHEN use_loser_premium THEN l.premium_vence   ELSE GREATEST(s.premium_vence, l.premium_vence) END,
    estado_pago      = CASE WHEN use_loser_premium THEN l.estado_pago     ELSE s.estado_pago END,
    tipo_plan        = CASE WHEN use_loser_premium THEN l.tipo_plan       ELSE s.tipo_plan END,
    fecha_pago       = CASE WHEN use_loser_premium THEN l.fecha_pago      ELSE s.fecha_pago END,
    fecha_vencimiento= CASE WHEN use_loser_premium THEN l.fecha_vencimiento ELSE s.fecha_vencimiento END,
    aprobado_gcc     = (s.aprobado_gcc OR l.aprobado_gcc),
    reporte_usos_mes           = GREATEST(COALESCE(s.reporte_usos_mes, 0), COALESCE(l.reporte_usos_mes, 0)),
    reporte_reset_mes          = GREATEST(s.reporte_reset_mes, l.reporte_reset_mes),
    referidos_meses_otorgados  = GREATEST(s.referidos_meses_otorgados, l.referidos_meses_otorgados),
    ref_code                   = COALESCE(s.ref_code, l.ref_code),
    is_test_user               = (s.is_test_user OR l.is_test_user)
  WHERE id = p_survivor;

  RETURN 'linked';
END;
$$;

REVOKE ALL ON FUNCTION public.merge_and_link(uuid, uuid) FROM PUBLIC, anon, authenticated;
