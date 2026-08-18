-- Cuatro correcciones a `borrar_cuenta_total`, salidas de la revision adversarial del diff.
--
-- Ninguna se veia leyendo la funcion: las cuatro aparecen cuando alguien pregunta "¿y si...?"
-- sobre una rama que el harness no siembra. Es el motivo por el que el CLAUDE.md exige que un
-- subagente SIN memoria de mi intencion revise el diff antes del push.
--
--   1. `errores` y `tickets_soporte` conservaban el TELEFONO. La 073 razono sobre `nlp_errors`
--      ("su FK es SET NULL, asi que hay que mirar tambien la columna `whatsapp`") y no aplico
--      el mismo razonamiento a las otras dos tablas que llevan el numero en columna propia.
--      Medido contra produccion el 18-ago: `errores` tiene 300 filas y **166 tienen
--      `usuario_id` en NULL con un `whatsapp` que pertenece a un usuario VIVO**. O sea que tras
--      la baja el numero de la persona seguia ahi, al lado del `mensaje` del error. El
--      `residual` no podia verlo: cuenta `errores.usuario_id = A`, que da 0.
--
--   2. **El borrado no era idempotente**, y las dos puertas lo hacen alcanzable. Una segunda
--      corrida sobre la lapida pasaba entera y pisaba `cuenta_borrada_at = now()`. Esa columna
--      es un HECHO —CUANDO pidio la baja— del que dependen las metricas de churn y el
--      `LEAST(...)` de `merge_and_link` (migracion 072b). El disparador no es hipotetico: la
--      ruta de la webapp devuelve 502 con "Intenta de nuevo" cuando el fetch revienta, y su
--      propio comentario reconoce que en ese caso el backend PUDO haber commiteado.
--
--   3. **Metas y gastos compartidos no tenian la proteccion que si recibieron los espacios.**
--      `meta_aportes.meta_id`, `meta_participantes.meta_id` y `gasto_participantes.gasto_id`
--      son CASCADE, asi que borrar la meta o el gasto de A destruia las filas de B — que son
--      lo que B aporto o lo que B debe. Hoy el daño medido es CERO (esas tres tablas estan
--      vacias en produccion), pero `/join/meta/[code]` es una feature viva, y es exactamente
--      la clase de bug que la 073 midio y cerro para espacios, latente en la rama de al lado.
--
--   4. `purgar_auditoria_usuario` casteaba jsonb AJENO a uuid sobre TODA la tabla. Una sola
--      fila con un `usuario_id` no-UUID adentro del jsonb —hoy no hay ninguna, en un año quien
--      sabe— lanza 22P02 y **aborta la transaccion de borrado entera**. Es fragilidad latente,
--      y cuesta un chequeo de forma evitarla.

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. El cast defensivo
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.purgar_auditoria_usuario(p_usuario_id uuid, p_motivo text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_filas integer;
BEGIN
  IF p_usuario_id IS NULL THEN
    RAISE EXCEPTION 'purgar_auditoria_usuario: p_usuario_id no puede ser null';
  END IF;

  WITH borradas AS (
    DELETE FROM public.borrados_auditoria
    WHERE usuario_id = p_usuario_id
       -- El chequeo de FORMA va antes del cast, y no es paranoia gratuita: este predicado se
       -- evalua sobre TODA la tabla, no solo sobre las filas de este usuario, asi que basta
       -- una fila ajena con basura en `fila->>'usuario_id'` para tumbar el borrado entero con
       -- 22P02. La fila la escribe un trigger sobre `to_jsonb(OLD)`, o sea que hoy siempre es
       -- un uuid — pero "hoy siempre" no es una garantia que valga la pena apostar acá.
       OR (
         (fila ->> 'usuario_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         AND (fila ->> 'usuario_id')::uuid = p_usuario_id
       )
    RETURNING 1
  )
  SELECT count(*) INTO v_filas FROM borradas;

  INSERT INTO public.purgas_auditoria (usuario_id, filas, motivo, db_user, contexto)
  VALUES (
    p_usuario_id, v_filas, p_motivo, current_user,
    jsonb_strip_nulls(jsonb_build_object(
      'app_name',    NULLIF(current_setting('application_name', true), ''),
      'client_addr', host(inet_client_addr()),
      'req_path',    NULLIF(current_setting('request.path', true), '')
    ))
  );

  RETURN v_filas;
END;
$fn$;

REVOKE ALL ON FUNCTION public.purgar_auditoria_usuario(uuid, text) FROM public, anon, authenticated, service_role;


-- ─────────────────────────────────────────────────────────────────────────────
-- 1 + 2 + 3
-- ─────────────────────────────────────────────────────────────────────────────
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

  -- ── IDEMPOTENCIA ──────────────────────────────────────────────────────────
  -- Corta ANTES de tocar nada. Sin esto, una segunda corrida pisaba `cuenta_borrada_at` con
  -- una fecha nueva, escribia otra fila en `purgas_auditoria` y mandaba un segundo "BAJA
  -- DECLARADA". `cuenta_borrada_at` es un HECHO —cuando pidio la baja— y las metricas de
  -- churn y el `LEAST(...)` de `merge_and_link` dependen de que no se mueva.
  --
  -- Devuelve `ok` con `ya_borrada: true` en vez de lanzar: para quien la llama, el resultado
  -- deseado ya se cumplio. Un error acá haria que la webapp le dijera "no pudimos eliminar tu
  -- cuenta" a alguien cuya cuenta esta perfectamente eliminada.
  IF v_ya IS NOT NULL THEN
    RETURN jsonb_build_object(
      'usuario_id', p_usuario_id, 'ya_borrada', true, 'cuenta_borrada_at', v_ya,
      'transacciones', 0, 'deudas', 0, 'conversaciones', 0,
      'auditoria_purgada', 0, 'residual', '{}'::jsonb
    );
  END IF;

  SELECT count(*) INTO v_tx     FROM public.transacciones  WHERE usuario_id = p_usuario_id;
  SELECT count(*) INTO v_deudas FROM public.deudas         WHERE usuario_id = p_usuario_id;
  SELECT count(*) INTO v_conv   FROM public.conversaciones WHERE usuario_id = p_usuario_id;

  UPDATE public.deudas SET deuda_vinculada_id = NULL
  WHERE deuda_vinculada_id IN (SELECT id FROM public.deudas WHERE usuario_id = p_usuario_id);

  -- ── Espacios: solo se destruye lo que no tiene a nadie mas adentro ────────
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
  DELETE FROM public.space_members     WHERE user_id  = p_usuario_id;

  -- ── Metas y gastos compartidos: la MISMA proteccion que los espacios ──────
  -- `meta_aportes.meta_id` y `meta_participantes.meta_id` son CASCADE, asi que borrar la meta
  -- de A destruiria lo que B aporto. Solo se borran las metas donde nadie mas puso nada.
  SELECT coalesce(array_agg(m.id), '{}') INTO v_metas
    FROM public.metas_ahorro m
   WHERE m.usuario_id = p_usuario_id
     AND NOT EXISTS (SELECT 1 FROM public.meta_aportes       a WHERE a.meta_id = m.id AND a.usuario_id IS DISTINCT FROM p_usuario_id)
     AND NOT EXISTS (SELECT 1 FROM public.meta_participantes q WHERE q.meta_id = m.id AND q.usuario_id IS DISTINCT FROM p_usuario_id);

  -- `gasto_participantes.gasto_id` es CASCADE y esas filas llevan lo que CADA participante
  -- debe: borrar el gasto de A le borra a B el registro de su parte.
  SELECT coalesce(array_agg(g.id), '{}') INTO v_gastos
    FROM public.gastos_compartidos g
   WHERE g.creador_id = p_usuario_id
     AND NOT EXISTS (SELECT 1 FROM public.gasto_participantes p WHERE p.gasto_id = g.id AND p.usuario_id IS DISTINCT FROM p_usuario_id);

  -- ── Lo que se borra ───────────────────────────────────────────────────────
  DELETE FROM public.deuda_abonos WHERE deuda_id IN (SELECT id FROM public.deudas WHERE usuario_id = p_usuario_id);
  DELETE FROM public.deudas       WHERE usuario_id = p_usuario_id;

  DELETE FROM public.gasto_participantes WHERE usuario_id = p_usuario_id;
  DELETE FROM public.gastos_compartidos  WHERE id = ANY(v_gastos);

  DELETE FROM public.meta_aportes       WHERE usuario_id = p_usuario_id;
  DELETE FROM public.meta_participantes WHERE usuario_id = p_usuario_id;
  DELETE FROM public.metas_ahorro       WHERE id = ANY(v_metas);
  DELETE FROM public.logros             WHERE usuario_id = p_usuario_id;

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

  -- Las TRES tablas que llevan el numero en una columna PROPIA, ademas de la FK. La 073 solo
  -- le aplicaba el doble WHERE a `nlp_errors`; medido el 18-ago, `errores` tenia 166 filas con
  -- `usuario_id` NULL y el telefono de un usuario vivo.
  DELETE FROM public.errores
  WHERE usuario_id = p_usuario_id
     OR (v_whatsapp IS NOT NULL AND whatsapp = v_whatsapp);

  DELETE FROM public.tickets_soporte
  WHERE usuario_id = p_usuario_id
     OR (v_whatsapp IS NOT NULL AND whatsapp = v_whatsapp);

  DELETE FROM public.nlp_errors
  WHERE usuario_id = p_usuario_id
     OR (v_whatsapp IS NOT NULL AND whatsapp = v_whatsapp);

  DELETE FROM public.webapp_otp
  WHERE (v_auth_id  IS NOT NULL AND supabase_auth_id  = v_auth_id)
     OR (v_email    IS NOT NULL AND lower(email)      = lower(v_email))
     OR (v_whatsapp IS NOT NULL AND (whatsapp_claimed = v_whatsapp OR whatsapp_verified = v_whatsapp));

  DELETE FROM public.referidos WHERE referrer_id = p_usuario_id;
  UPDATE public.referidos SET referido_id = NULL WHERE referido_id = p_usuario_id;

  DELETE FROM public.transacciones_eliminadas WHERE usuario_id = p_usuario_id;
  DELETE FROM public.transacciones WHERE usuario_id = p_usuario_id;

  UPDATE public.pagos SET comprobante_url = NULL, notas = NULL WHERE usuario_id = p_usuario_id;

  -- ── La lapida ─────────────────────────────────────────────────────────────
  -- `plan`, `tipo_plan`, `premium_desde` y `premium_vence` NO se tocan: decision lockeada.
  -- `cuenta_borrada_at` va con COALESCE ademas del corte de arriba — cinturon y tirantes sobre
  -- el unico dato de esta fila que no se puede reconstruir.
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
  --   · mira la columna de la FK y NO las columnas paralelas de identidad (`whatsapp`), que
  --     es justo el hallazgo de `errores`;
  --   · corre DENTRO de la transaccion, asi que no ve nada que se recree despues.
  FOR r IN
    SELECT c.conrelid::regclass::text AS tabla, a.attname AS col
      FROM pg_constraint c
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
     WHERE c.contype = 'f' AND c.confrelid = 'public.usuarios'::regclass
  LOOP
    CONTINUE WHEN (r.tabla || '.' || r.col) IN (
      'pagos.usuario_id',
      'gmail_cuentas.usuario_id',
      'shared_spaces.created_by',
      'space_expenses.paid_by',
      'space_settlements.from_user',
      'space_settlements.to_user',
      -- Una meta o un gasto compartido donde OTRA persona puso algo sobrevive apuntando a la
      -- lapida, por el mismo motivo que los espacios: la fila es de los dos.
      'metas_ahorro.usuario_id',
      'gastos_compartidos.creador_id'
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
