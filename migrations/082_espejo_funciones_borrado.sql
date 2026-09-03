-- 082 · ESPEJO de las dos funciones del borrado. No cambia nada: sincroniza el REPO con la base.
--
-- Ítem 27 del backlog de confiabilidad, hallado el 02-sep-2026 y cerrado el 03-sep.
--
-- ─── Qué estaba mal ──────────────────────────────────────────────────────────────────────
--
-- El cuerpo de la función en `073d_metas_gastos_nullable.sql` tiene **9896** caracteres y el
-- que corre en producción tiene **7768**. No coinciden, y no es un defecto que haya
-- introducido ninguna sesión: es DRIFT, la base se movió y el archivo no.
--
-- El daño no es hoy, es el próximo que la toque. El CLAUDE.md manda partir del archivo de
-- número más alto, y `tests/services/account-deletion.test.js` resuelve la "vigente" de la
-- misma forma. Hacer eso desplegaba una versión DISTINTA de la que está viva, con el diff
-- leyéndose como si solo agregara el cambio nuevo — sobre la función del borrado de cuenta,
-- que es la más cara de equivocar del sistema.
--
-- ─── Por qué un archivo nuevo y no editar el 073d ────────────────────────────────────────
--
-- Las migraciones son append-only. Editar el 073d haría que el archivo mienta sobre lo que
-- ese día se aplicó, y el guard resolvería igual de mal el día que aparezca un 083.
--
-- ─── Lo que este archivo NO hace ─────────────────────────────────────────────────────────
--
-- No cambia el comportamiento, y **NO SE APLICÓ**. Los dos cuerpos se extrajeron con
-- `select prosrc from pg_proc` y son idénticos byte a byte a los que corren — verificado por el
-- canary, que extrae el cuerpo de ESTE archivo y compara su md5 contra el vivo. Aplicarlo sería
-- un no-op y por eso no se hizo: redefinir dos funciones SECURITY DEFINER del camino del borrado
-- de cuentas, en producción, para no cambiar nada, es riesgo sin contrapartida.
--
-- O sea que este archivo NO está en `supabase_migrations.schema_migrations`, a diferencia del
-- resto. Es deliberado y es la única migración del repo de la que eso vale.
--
-- Si algún día se aplica: el **md5 del cuerpo vivo no se puede mover**
-- (`a2d74e70c83fc9724598ae1d34f50ed6` y `b65994ad17ffbd25ce7b6c713f3ff961`). Si se moviera, la
-- copia está mal y hay que revertirla — no actualizar el canary.
--
-- ─── La segunda función, y por qué su comentario se mudó acá arriba ──────────────────────
--
-- `purgar_auditoria_usuario` tenía el MISMO drift, y lo encontró el check nuevo del canary
-- —nadie la había mirado—. La diferencia es sólo un comentario SQL de cinco líneas que vive
-- dentro del cuerpo en `073c` y no está en la base: alguien editó el archivo después de
-- aplicarlo, que es justo lo que la regla append-only prohíbe. Las dos versiones son
-- semánticamente idénticas.
--
-- Se podría haber aplicado la del repo, pero eso es reescribir una función SECURITY DEFINER
-- del camino del borrado para ganar un comentario. El comentario vale y la reescritura no,
-- así que la explicación subió acá y el cuerpo quedó byte-exacto al vivo:
--
--   El chequeo de FORMA va antes del cast, y no es paranoia gratuita: ese predicado se evalúa
--   sobre TODA la tabla, no sólo sobre las filas de este usuario, así que basta una fila ajena
--   con basura en `fila->>'usuario_id'` para tumbar el borrado entero con 22P02. La fila la
--   escribe un trigger sobre `to_jsonb(OLD)`, o sea que hoy siempre es un uuid — pero "hoy
--   siempre" no es una garantía que valga la pena apostar acá.
--
-- ─── Cómo se mantiene ────────────────────────────────────────────────────────────────────
--
-- La fuente de verdad sigue siendo la BASE: es lo que corre. Este archivo es su espejo, y lo
-- que lo mantiene honesto es el check `el archivo del repo describe la función que CORRE` de
-- `qa-e2e/qa-borrado-estructura.mjs`, que corre en el canary diario. Un espejo que nadie
-- compara vuelve a divergir el mes que viene — que es exactamente lo que pasó acá.
--
-- Al modificar cualquiera de las dos: partir de ESTE cuerpo, aplicar el cambio en una
-- migración NUEVA (append-only, nunca editando ésta) y actualizar el md5 del canary con el
-- nuevo valor vivo, en el mismo commit.

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

  SELECT coalesce(array_agg(m.id), '{}') INTO v_metas
    FROM public.metas_ahorro m
   WHERE m.usuario_id = p_usuario_id
     AND NOT EXISTS (SELECT 1 FROM public.meta_aportes a
                      WHERE a.meta_id = m.id AND coalesce(a.usuario_id, m.usuario_id) <> p_usuario_id)
     AND NOT EXISTS (SELECT 1 FROM public.meta_participantes q
                      WHERE q.meta_id = m.id AND coalesce(q.usuario_id, m.usuario_id) <> p_usuario_id);

  SELECT coalesce(array_agg(g.id), '{}') INTO v_gastos
    FROM public.gastos_compartidos g
   WHERE g.creador_id = p_usuario_id
     AND NOT EXISTS (SELECT 1 FROM public.gasto_participantes p
                      WHERE p.gasto_id = g.id AND coalesce(p.usuario_id, g.creador_id) <> p_usuario_id);

  DELETE FROM public.deuda_abonos WHERE deuda_id IN (SELECT id FROM public.deudas WHERE usuario_id = p_usuario_id);
  DELETE FROM public.deudas       WHERE usuario_id = p_usuario_id;

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
