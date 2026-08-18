-- Arregla una REGRESIÓN que introdujo la 073c, y corrige su paridad con espacios.
--
-- La 073c le dio a metas y gastos compartidos "la misma protección que los espacios": un
-- `NOT EXISTS ... IS DISTINCT FROM p_usuario_id` para no destruir dato de terceros. El
-- predicado estaba copiado literal, y ahí está el error: **las columnas no tienen la misma
-- nulabilidad**.
--
--   | columna                        | nullable | quién la escribe                          |
--   |--------------------------------|----------|-------------------------------------------|
--   | `space_members.user_id`        | NO       | siempre                                   |
--   | `meta_aportes.usuario_id`      | **SÍ**   | **nadie** — services/metas.js no la manda  |
--   | `gasto_participantes.usuario_id` | **SÍ** | solo al canjear un invite                 |
--
-- Con `usuario_id` en NULL, `NULL IS DISTINCT FROM <uuid>` es **TRUE**, así que el `EXISTS`
-- daba positivo y la meta se leía como "compartida con otro": quedaba fuera del borrado.
-- Medido con el predicado real contra producción el 18-ago: **12 de 13 metas se borraban y
-- una no** — la única que tiene un aporte, cuyo `usuario_id` es NULL como todos los que el
-- producto escribe. O sea que la 073c dejó a un usuario con el 100% de sus metas sobreviviendo
-- al borrado, con nombre y montos. Es estrictamente PEOR que la 073, que las borraba todas.
--
-- Y de paso `DELETE FROM meta_aportes WHERE usuario_id = p_usuario_id` tampoco alcanzaba las
-- filas con NULL: antes morían por cascade de `metas_ahorro`, y con la meta viva ya no moría
-- ninguna.
--
-- POR QUÉ EL HARNESS NO LO VIO, que es la parte que más enseña: `qa-borrado-cuenta.mjs`
-- sembraba `meta_aportes` con `usuario_id: A` — un valor que NINGÚN código de producción
-- escribe. Con ese fixture `A IS DISTINCT FROM A` es false y todo pasaba en verde. El fixture
-- era más benévolo que la realidad. Se corrigió a sembrar la forma real (NULL).
--
-- LA SEGUNDA MITAD: la paridad con espacios estaba a medias, y esto sí es un cambio de
-- criterio, no un bug de tipos. En espacios NO existe ningún `DELETE FROM space_expenses WHERE
-- paid_by = p_usuario_id`: lo que A pagó dentro del espacio de B sobrevive, porque es parte de
-- la cuenta de B. En metas y gastos sí se borraba por `usuario_id` sin mirar el contenedor, así
-- que A se daba de baja y la meta compartida de B perdía los aportes de A — con `monto_actual`
-- denormalizado, quedaba un total que no cuadra con su propio historial.
--
-- La regla queda igual para los tres, y es la que ya usaban los espacios:
--
--   · MEMBRESÍA (`space_members`, `meta_participantes`) → se va siempre. Dejar de estar es lo
--     que la persona pidió.
--   · PLATA (`space_expenses`, `meta_aportes`, `gasto_participantes`) → sobrevive si el
--     contenedor sobrevive, y se va por cascade cuando el contenedor se borra. No es nuestra
--     para borrarla: del otro lado hay alguien cuyo saldo cambia.

CREATE OR REPLACE FUNCTION public.borrar_cuenta_total(p_usuario_id uuid, p_borrar_email_gmail boolean DEFAULT true)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_whatsapp   text;
  v_email      text;
  v_auth_id    uuid;
  v_ya         timestamptz;
  v_tx         integer;
  v_deudas     integer;
  v_conv       integer;
  v_purgadas   integer;
  v_espacios   uuid[];
  v_metas      uuid[];
  v_gastos     uuid[];
  v_n          bigint;
  v_residual   jsonb := '{}'::jsonb;
  r            record;
BEGIN
  IF p_usuario_id IS NULL THEN
    RAISE EXCEPTION 'borrar_cuenta_total: p_usuario_id no puede ser null';
  END IF;

  SELECT whatsapp, email, supabase_auth_id, cuenta_borrada_at
    INTO v_whatsapp, v_email, v_auth_id, v_ya
  FROM public.usuarios WHERE id = p_usuario_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'borrar_cuenta_total: no existe el usuario %', p_usuario_id;
  END IF;

  -- Idempotencia: corta ANTES de tocar nada. `cuenta_borrada_at` es un HECHO y las metricas de
  -- churn dependen de que no se mueva. El payload tiene la MISMA forma que el camino normal:
  -- un llamador que ramifique por `email_gmail_borrado` o `tenia_auth` no puede recibir
  -- `undefined` segun por donde vino.
  IF v_ya IS NOT NULL THEN
    RETURN jsonb_build_object(
      'usuario_id', p_usuario_id, 'ya_borrada', true, 'cuenta_borrada_at', v_ya,
      'transacciones', 0, 'deudas', 0, 'conversaciones', 0,
      'auditoria_purgada', 0, 'email_gmail_borrado', false, 'tenia_auth', false,
      'residual', '{}'::jsonb
    );
  END IF;

  SELECT count(*) INTO v_tx     FROM public.transacciones  WHERE usuario_id = p_usuario_id;
  SELECT count(*) INTO v_deudas FROM public.deudas         WHERE usuario_id = p_usuario_id;
  SELECT count(*) INTO v_conv   FROM public.conversaciones WHERE usuario_id = p_usuario_id;

  UPDATE public.deudas SET deuda_vinculada_id = NULL
  WHERE deuda_vinculada_id IN (SELECT id FROM public.deudas WHERE usuario_id = p_usuario_id);

  -- ── Espacios ──────────────────────────────────────────────────────────────
  -- `space_members.user_id` y `space_expenses.paid_by` son NOT NULL, asi que acá el
  -- `IS DISTINCT FROM` es correcto y se queda como está.
  SELECT coalesce(array_agg(s.id), '{}') INTO v_espacios
    FROM public.shared_spaces s
   WHERE s.created_by = p_usuario_id
     AND NOT EXISTS (SELECT 1 FROM public.space_members  m WHERE m.space_id = s.id AND m.user_id IS DISTINCT FROM p_usuario_id)
     AND NOT EXISTS (SELECT 1 FROM public.space_expenses e WHERE e.space_id = s.id AND e.paid_by IS DISTINCT FROM p_usuario_id)
     AND NOT EXISTS (SELECT 1 FROM public.space_settlements t WHERE t.space_id = s.id);

  DELETE FROM public.space_expenses    WHERE space_id = ANY(v_espacios);
  DELETE FROM public.space_settlements WHERE space_id = ANY(v_espacios);
  UPDATE public.metas_ahorro SET space_id = NULL WHERE space_id = ANY(v_espacios);
  DELETE FROM public.shared_spaces     WHERE id       = ANY(v_espacios);
  DELETE FROM public.space_members     WHERE user_id  = p_usuario_id;   -- membresía: se va siempre

  -- ── Metas ─────────────────────────────────────────────────────────────────
  -- `coalesce(...)` y no `IS DISTINCT FROM`: un aporte sin `usuario_id` es del DUEÑO de la
  -- meta (es lo que escribe `services/metas.js`), no de un tercero anónimo.
  SELECT coalesce(array_agg(m.id), '{}') INTO v_metas
    FROM public.metas_ahorro m
   WHERE m.usuario_id = p_usuario_id
     AND NOT EXISTS (SELECT 1 FROM public.meta_aportes a
                      WHERE a.meta_id = m.id AND coalesce(a.usuario_id, m.usuario_id) <> p_usuario_id)
     AND NOT EXISTS (SELECT 1 FROM public.meta_participantes q
                      WHERE q.meta_id = m.id AND coalesce(q.usuario_id, m.usuario_id) <> p_usuario_id);

  -- ── Gastos compartidos ────────────────────────────────────────────────────
  -- Mismo criterio. Un participante sin `usuario_id` es alguien que no usa Neto (se guarda por
  -- `nombre`), o sea que NO es dato de otro usuario: el gasto se puede borrar.
  SELECT coalesce(array_agg(g.id), '{}') INTO v_gastos
    FROM public.gastos_compartidos g
   WHERE g.creador_id = p_usuario_id
     AND NOT EXISTS (SELECT 1 FROM public.gasto_participantes p
                      WHERE p.gasto_id = g.id AND coalesce(p.usuario_id, g.creador_id) <> p_usuario_id);

  DELETE FROM public.deuda_abonos WHERE deuda_id IN (SELECT id FROM public.deudas WHERE usuario_id = p_usuario_id);
  DELETE FROM public.deudas       WHERE usuario_id = p_usuario_id;

  -- La membresía se va; los aportes y las participaciones NO se borran por `usuario_id`: caen
  -- por cascade con su contenedor cuando el contenedor se borra, y sobreviven cuando sobrevive.
  -- Es exactamente lo que hacen `space_expenses`/`space_settlements`.
  DELETE FROM public.meta_participantes  WHERE usuario_id = p_usuario_id;
  DELETE FROM public.metas_ahorro        WHERE id = ANY(v_metas);
  DELETE FROM public.gastos_compartidos  WHERE id = ANY(v_gastos);
  DELETE FROM public.logros              WHERE usuario_id = p_usuario_id;

  DELETE FROM public.presupuestos          WHERE usuario_id = p_usuario_id;
  DELETE FROM public.categorias_usuario    WHERE usuario_id = p_usuario_id;
  DELETE FROM public.reglas_comercio       WHERE usuario_id = p_usuario_id;
  DELETE FROM public.recurrentes_overrides WHERE usuario_id = p_usuario_id;
  DELETE FROM public.spending_alerts       WHERE user_id    = p_usuario_id;
  DELETE FROM public.survey_events         WHERE user_id    = p_usuario_id;
  DELETE FROM public.neto_scores           WHERE user_id    = p_usuario_id;

  DELETE FROM public.notification_deliveries WHERE usuario_id = p_usuario_id;
  DELETE FROM public.notificaciones          WHERE usuario_id = p_usuario_id;
  DELETE FROM public.conversaciones          WHERE usuario_id = p_usuario_id;
  DELETE FROM public.gmail_excluidos         WHERE usuario_id = p_usuario_id;

  DELETE FROM public.errores
  WHERE usuario_id = p_usuario_id OR (v_whatsapp IS NOT NULL AND whatsapp = v_whatsapp);
  DELETE FROM public.tickets_soporte
  WHERE usuario_id = p_usuario_id OR (v_whatsapp IS NOT NULL AND whatsapp = v_whatsapp);
  DELETE FROM public.nlp_errors
  WHERE usuario_id = p_usuario_id OR (v_whatsapp IS NOT NULL AND whatsapp = v_whatsapp);

  DELETE FROM public.webapp_otp
  WHERE (v_auth_id  IS NOT NULL AND supabase_auth_id  = v_auth_id)
     OR (v_email    IS NOT NULL AND lower(email)      = lower(v_email))
     OR (v_whatsapp IS NOT NULL AND (whatsapp_claimed = v_whatsapp OR whatsapp_verified = v_whatsapp));

  DELETE FROM public.referidos WHERE referrer_id = p_usuario_id;
  UPDATE public.referidos SET referido_id = NULL WHERE referido_id = p_usuario_id;

  DELETE FROM public.transacciones_eliminadas WHERE usuario_id = p_usuario_id;
  DELETE FROM public.transacciones WHERE usuario_id = p_usuario_id;

  UPDATE public.pagos SET comprobante_url = NULL, notas = NULL WHERE usuario_id = p_usuario_id;

  UPDATE public.usuarios SET
    whatsapp             = NULL,
    nombre               = NULL,
    email                = NULL,
    bsuid                = NULL,
    ref_code             = NULL,
    supabase_auth_id     = NULL,
    gmail_access_token   = NULL,
    gmail_refresh_token  = NULL,
    gmail_token_expiry   = NULL,
    recordatorios_activos = false,
    onboarding_paso      = 0,
    onboarding_completado = false,
    cuenta_borrada_at    = COALESCE(cuenta_borrada_at, now())
  WHERE id = p_usuario_id;

  IF p_borrar_email_gmail THEN
    UPDATE public.gmail_cuentas
       SET email = NULL, access_token = NULL, refresh_token = NULL, token_expiry = NULL,
           activa = false, updated_at = now()
     WHERE usuario_id = p_usuario_id;
  ELSE
    UPDATE public.gmail_cuentas
       SET access_token = NULL, refresh_token = NULL, token_expiry = NULL,
           activa = false, updated_at = now()
     WHERE usuario_id = p_usuario_id;
  END IF;

  v_purgadas := public.purgar_auditoria_usuario(p_usuario_id, 'baja_de_cuenta');

  -- ── Residual ──────────────────────────────────────────────────────────────
  -- LO QUE ESTE CHEQUEO NO PUEDE VER, para que nadie lo lea como "no quedo nada":
  --   · solo recorre tablas con FK a `usuarios` — la clase `webapp_otp` es invisible por
  --     construccion, y por eso esa tabla se borra explicitamente arriba;
  --   · mira `conkey[1]`, la PRIMERA columna de la FK;
  --   · mira la columna de la FK y NO las columnas paralelas de identidad (`whatsapp`);
  --   · corre DENTRO de la transaccion, asi que no ve nada que se recree despues;
  --   · y NO ve una fila cuya columna quedo en NULL, que fue justo el bug de la 073c.
  FOR r IN
    SELECT c.conrelid::regclass::text AS tabla, a.attname AS col
      FROM pg_constraint c
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
     WHERE c.contype = 'f' AND c.confrelid = 'public.usuarios'::regclass
  LOOP
    CONTINUE WHEN (r.tabla || '.' || r.col) IN (
      'pagos.usuario_id',
      'gmail_cuentas.usuario_id',
      -- Contenedores compartidos y la PLATA que vive adentro: una fila viva acá es la
      -- decision de no destruir el saldo de otra persona.
      'shared_spaces.created_by',
      'space_expenses.paid_by',
      'space_settlements.from_user',
      'space_settlements.to_user',
      'metas_ahorro.usuario_id',
      'meta_aportes.usuario_id',
      'gastos_compartidos.creador_id',
      'gasto_participantes.usuario_id'
    );
    EXECUTE format('SELECT count(*) FROM %s WHERE %I = $1', r.tabla, r.col)
      INTO v_n USING p_usuario_id;
    IF v_n > 0 THEN
      v_residual := v_residual || jsonb_build_object(r.tabla || '.' || r.col, v_n);
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'usuario_id',        p_usuario_id,
    'ya_borrada',        false,
    'transacciones',     v_tx,
    'deudas',            v_deudas,
    'conversaciones',    v_conv,
    'auditoria_purgada', v_purgadas,
    'email_gmail_borrado', p_borrar_email_gmail,
    'tenia_auth',        v_auth_id IS NOT NULL,
    'residual',          v_residual
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.borrar_cuenta_total(uuid, boolean) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.borrar_cuenta_total(uuid, boolean) TO service_role;
