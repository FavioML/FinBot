-- Borrado real de cuenta: una transaccion, un inventario, y un rastro que no miente.
--
-- POR QUE. `ejecutarBorradoTotal` borraba 4 de las 30 tablas que cuelgan de `usuarios`,
-- mientras el producto decia "Todos tus datos han sido eliminados" y /privacidad prometia
-- borrarlo todo en 30 dias. Medido contra produccion el 17-ago-2026: los 2 usuarios que ya
-- habian pasado por el wipe conservaban 35 filas en `conversaciones` (el texto literal de lo
-- que escribieron), 146 en `notificaciones`, 19 en `reglas_comercio`, 4 en `deudas`, 2 en
-- `pagos` y 1 snapshot completo en `transacciones_eliminadas`.
--
-- TRES COSAS QUE SE MIDIERON ANTES DE ELEGIR EL DISENO, porque las tres desarman la salida
-- obvia ("28 de 30 FK son CASCADE, basta con borrar la fila de `usuarios`"):
--
--   1. EL WIPE NO BORRABA: MOVIA. `trg_audit_borrado` (migracion 055) es AFTER DELETE sobre
--      `transacciones`/`deudas`/`deuda_abonos` y copia la FILA ENTERA a `borrados_auditoria`,
--      donde service_role solo tiene SELECT. Los 2 dados de baja tenian ahi 173 filas
--      completas de sus transacciones. O sea que hasta la parte que "funcionaba" trasladaba
--      el dato a una tabla que la persona no puede alcanzar.
--
--   2. BORRAR LA FILA DE `usuarios` ABORTA. Verificado con un DELETE real revertido:
--      23503 sobre `deudas_deuda_vinculada_id_fkey`. Le pasa hoy a 1 de 113 usuarios. NO
--      ACTION se chequea al final del statement, asi que solo rompe cuando la fila que
--      referencia SOBREVIVE — es decir, justo cuando hay otra persona del otro lado. No es
--      un caso raro que tienda a cero: es el que crece con Deudas y Espacios.
--
--   3. `usuarios` ANCLA DATOS DE TERCEROS. `shared_spaces.created_by` es CASCADE: borrar la
--      fila destruye los espacios que esa persona creo y se lleva los gastos de los demas
--      miembros. Medido: 3 espacios, 1 con mas de un miembro.
--
-- POR ESO LA FILA DE `usuarios` NO SE BORRA: queda como LAPIDA, vaciada de todo dato personal
-- directo (whatsapp, nombre, email, bsuid, ref_code, supabase_auth_id, tokens de Gmail). Es la
-- respuesta estandar para alguien que participo de registros compartidos, y de paso sostiene
-- las dos decisiones ya tomadas: el plan pagado no se toca, y `cuenta_borrada_at` sigue siendo
-- un HECHO que vive en algun lado.
--
-- Y POR ESO ES UNA SOLA TRANSACCION. El wipe viejo era un bucle de deletes donde el ORDEN era
-- la unica garantia, con ~100 lineas dedicadas a distinguir los tres estados de un fallo
-- parcial. Aca no hay fallo parcial: o pasa todo, o no pasa nada. De regalo mata el residual
-- del paso -1, porque el `onboarding_paso = 0` entra en la misma transaccion (antes, un wipe
-- exitoso que no lograra sacar del paso -1 dejaba a la persona leyendo "Cancelado. Tu cuenta
-- sigue igual" con los datos ya borrados).
--
-- LO QUE ESTA MIGRACION NO PUEDE HACER, y por eso el servicio de Node sigue existiendo:
-- revocar el grant en Google, borrar los objetos de Storage (borrar la fila de
-- `storage.objects` NO borra el archivo del bucket) y borrar `auth.users` por el Admin API.


-- ─────────────────────────────────────────────────────────────────────────────
-- 1. El registro de las purgas del rastro de borrados
-- ─────────────────────────────────────────────────────────────────────────────
--
-- `borrados_auditoria` nacio del incidente del 01-ago-2026 (desaparecieron transacciones y
-- deudas de un usuario que paga y la causa no se pudo determinar porque no habia evidencia).
-- Es append-only a proposito y el backend NO puede borrar ahi ni queriendo. Cumple su funcion
-- exactamente por lo que ahora estorba: guarda copia integra de lo que la persona pidio
-- eliminar.
--
-- QUE PASA CON EL INCIDENTE QUE LA CREO: sigue cubierto, y la propiedad forense queda mas
-- fuerte, no mas debil. La tabla existe para explicar borrados INEXPLICADOS; una baja pedida
-- por la persona es un borrado EXPLICADO y ademas dispara aviso al admin en el momento. Un
-- DELETE duro no autorizado sigue dejando su fila. Lo que cambia es que el invariante pasa a
-- ser "o estan las filas, o esta escrito por que no estan".
--
-- NO se le da DELETE a service_role sobre `borrados_auditoria`, NO se toca el trigger y NO se
-- cambia su alcance. La unica puerta es `purgar_auditoria_usuario`, que ni siquiera se expone:
-- solo la llama `borrar_cuenta_total`. No hay forma de purgar el rastro sin borrar la cuenta
-- entera, y borrar la cuenta entera avisa al admin.
CREATE TABLE IF NOT EXISTS public.purgas_auditoria (
  id          bigserial PRIMARY KEY,
  purgado_at  timestamptz NOT NULL DEFAULT now(),
  usuario_id  uuid        NOT NULL,
  filas       integer     NOT NULL,
  motivo      text        NOT NULL,
  db_user     text        NOT NULL,
  contexto    jsonb       NOT NULL
);

COMMENT ON TABLE public.purgas_auditoria IS
  'Append-only. Una fila cada vez que se purga el rastro de borrados_auditoria de un usuario por una baja de cuenta. Ver migrations/073.';

CREATE INDEX IF NOT EXISTS idx_purgas_auditoria_usuario ON public.purgas_auditoria (usuario_id, purgado_at DESC);

ALTER TABLE public.purgas_auditoria ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.purgas_auditoria FROM public, anon, authenticated, service_role;
GRANT SELECT ON public.purgas_auditoria TO service_role;
REVOKE ALL ON SEQUENCE public.purgas_auditoria_id_seq FROM public, anon, authenticated, service_role;

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

  -- Se busca por las DOS vias. `borrados_auditoria.usuario_id` lo resuelve el trigger, y para
  -- `deuda_abonos` lo hace mirando la deuda padre — que en un borrado de cuenta puede haberse
  -- ido primero, dejando la columna en null. La fila completa sigue teniendo el usuario_id
  -- adentro del jsonb, asi que ese es el segundo anzuelo. Sin el, las filas mas dificiles de
  -- ver son justo las que sobrevivirian a la purga.
  WITH borradas AS (
    DELETE FROM public.borrados_auditoria
    WHERE usuario_id = p_usuario_id
       OR NULLIF(fila ->> 'usuario_id', '')::uuid = p_usuario_id
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

COMMENT ON FUNCTION public.purgar_auditoria_usuario(uuid, text) IS
  'Purga el rastro de borrados_auditoria de UN usuario y deja constancia en purgas_auditoria. No se expone: solo la llama borrar_cuenta_total.';

-- Nadie de la aplicacion la llama directo. Es la mitad que hace que la purga no sea un agujero:
-- para usarla hay que pasar por `borrar_cuenta_total`, que borra la cuenta entera y avisa.
REVOKE ALL ON FUNCTION public.purgar_auditoria_usuario(uuid, text) FROM public, anon, authenticated, service_role;


-- ─────────────────────────────────────────────────────────────────────────────
-- 2. El cupo de Gmail sobrevive al borrado; el correo, no
-- ─────────────────────────────────────────────────────────────────────────────
--
-- `emailGmailVinculado()` mira el historial de `gmail_cuentas` SIN filtrar por `activa`,
-- porque cada cuenta de Google distinta gasta uno de los 100 cupos de por vida y revocar no
-- lo devuelve. Como la lapida conserva su `id`, si el borrado se llevara esas filas el mismo
-- usuario podria volver, conectar otro correo y quemar otro cupo irrecuperable pagando una
-- sola vez.
--
-- La columna separa dos preguntas que hoy comparten una sola: "que correo pre-lleno en Google"
-- (`login_hint`, comodidad, dato personal, SE BORRA) y "este correo ya gasto cupo"
-- (`email_hash`, invariante, SOBREVIVE). El hash es HMAC con un pepper de servidor que vive
-- fuera de la DB, asi que un dump — o un backup de R2 — no alcanza para revertirlo.
--
-- Se llena desde Node (`gmail.js`), no desde aca: el pepper no puede vivir en un archivo
-- versionado. Mientras una fila no tenga hash, el gate cae al `email` en claro — que es
-- exactamente lo que hace hoy, o sea que el estado intermedio no rompe nada.
--
-- No hay script de backfill y es deliberado: el unico momento en que la falta del hash hace
-- daño es el borrado, y `services/account-deletion.js` lo calcula justo antes de vaciar el
-- correo. Un backfill separado seria una segunda copia de la misma regla, que es como se
-- desincronizan las cosas.
ALTER TABLE public.gmail_cuentas ADD COLUMN IF NOT EXISTS email_hash text;

COMMENT ON COLUMN public.gmail_cuentas.email_hash IS
  'HMAC-SHA256 del email con pepper de servidor. Sobrevive al borrado de cuenta: es lo unico que sostiene "una cuenta de Google por usuario, para siempre" cuando el email ya se borro. Ver migrations/073 y gmail.js.';

CREATE INDEX IF NOT EXISTS idx_gmail_cuentas_email_hash ON public.gmail_cuentas (email_hash) WHERE email_hash IS NOT NULL;


-- ─────────────────────────────────────────────────────────────────────────────
-- 3. El borrado
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Devuelve un jsonb con los conteos previos (lo unico que hace accionable el aviso al admin:
-- "se fue" vale poco, "se fue con 131 movimientos" dice si hay que llamarlo) y, sobre todo,
-- con `residual`: lo que QUEDO colgando de este usuario.
--
-- `residual` se calcula RECOMPUTANDO de pg_constraint las tablas que apuntan a `usuarios`, no
-- contra una lista escrita a mano. Es la parte que le da vida util a esto: el dia que alguien
-- agregue la tabla 31 y no la clasifique, el residual la va a delatar en vez de dejarla
-- sobrevivir en silencio. No se hace RAISE — quien decide que hacer con eso es el llamador,
-- que es el que puede avisar al admin sin dejar a la persona sin respuesta.
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
  v_tx         integer;
  v_deudas     integer;
  v_conv       integer;
  v_purgadas   integer;
  v_espacios   uuid[];
  v_n          bigint;
  v_residual   jsonb := '{}'::jsonb;
  r            record;
BEGIN
  IF p_usuario_id IS NULL THEN
    RAISE EXCEPTION 'borrar_cuenta_total: p_usuario_id no puede ser null';
  END IF;

  -- FOR UPDATE: serializa dos bajas simultaneas del mismo usuario (los dos puertas — webapp y
  -- WhatsApp — pueden dispararse a la vez si alguien tiene las dos abiertas).
  SELECT whatsapp, email, supabase_auth_id INTO v_whatsapp, v_email, v_auth_id
  FROM public.usuarios WHERE id = p_usuario_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'borrar_cuenta_total: no existe el usuario %', p_usuario_id;
  END IF;

  SELECT count(*) INTO v_tx     FROM public.transacciones  WHERE usuario_id = p_usuario_id;
  SELECT count(*) INTO v_deudas FROM public.deudas         WHERE usuario_id = p_usuario_id;
  SELECT count(*) INTO v_conv   FROM public.conversaciones WHERE usuario_id = p_usuario_id;

  -- ── 3.1 Desactivar los bloqueos NO ACTION ─────────────────────────────────
  -- La deuda espejo de la contraparte apunta a la de esta persona. Es la FK que hace abortar
  -- el DELETE entero (23503, medido). Se desvincula, no se borra: la deuda del otro lado es
  -- SUYA y su monto no cambia porque nosotros nos vayamos.
  UPDATE public.deudas SET deuda_vinculada_id = NULL
  WHERE deuda_vinculada_id IN (SELECT id FROM public.deudas WHERE usuario_id = p_usuario_id);

  -- ── 3.2 Espacios compartidos ──────────────────────────────────────────────
  -- Un espacio solo se destruye si NADIE MAS queda adentro. La condicion mira las tres formas
  -- en que otra persona puede tener algo ahi (miembro, gasto pagado, liquidacion): un espacio
  -- "sin otros miembros" pero con el gasto de alguien que ya se salio sigue siendo la cuenta
  -- de esa persona. Ante la duda, el espacio SOBREVIVE apuntando a la lapida; destruir dato
  -- ajeno es el error que no tiene vuelta.
  SELECT coalesce(array_agg(s.id), '{}') INTO v_espacios
    FROM public.shared_spaces s
   WHERE s.created_by = p_usuario_id
     AND NOT EXISTS (SELECT 1 FROM public.space_members  m WHERE m.space_id = s.id AND m.user_id IS DISTINCT FROM p_usuario_id)
     AND NOT EXISTS (SELECT 1 FROM public.space_expenses e WHERE e.space_id = s.id AND e.paid_by IS DISTINCT FROM p_usuario_id)
     -- Una liquidacion siempre tiene dos lados, asi que cualquiera que exista prueba que hubo
     -- otra persona en ese espacio. Basta con que haya una para que el espacio NO sea solo.
     AND NOT EXISTS (SELECT 1 FROM public.space_settlements t WHERE t.space_id = s.id);

  -- `space_expenses.space_id`, `space_settlements.space_id` y `metas_ahorro.space_id` son NO
  -- ACTION: hay que vaciarlos antes de tocar `shared_spaces` o el DELETE aborta.
  DELETE FROM public.space_expenses    WHERE space_id = ANY(v_espacios);
  DELETE FROM public.space_settlements WHERE space_id = ANY(v_espacios);
  -- Las metas se DESVINCULAN, no se borran: una meta de otra persona colgada de este espacio
  -- se borraria sin que nadie lo pidiera. Las de esta persona caen abajo, por usuario_id.
  UPDATE public.metas_ahorro SET space_id = NULL WHERE space_id = ANY(v_espacios);
  DELETE FROM public.shared_spaces     WHERE id       = ANY(v_espacios);

  -- La membresia propia se va SIEMPRE, tambien en los espacios que sobreviven: dejar de estar
  -- es justamente lo que pidio.
  DELETE FROM public.space_members WHERE user_id = p_usuario_id;

  -- ── 3.3 Lo que se borra (dato exclusivamente suyo) ────────────────────────
  -- `deuda_abonos` va ANTES que `deudas` a proposito: el trigger de auditoria resuelve el
  -- usuario de un abono mirando la deuda padre, asi que si la madre se fue primero la fila de
  -- rastro queda sin `usuario_id` y la purga de abajo tiene que ir a buscarla al jsonb. Cuesta
  -- una linea de orden y ahorra depender de ese rescate.
  DELETE FROM public.deuda_abonos WHERE deuda_id IN (SELECT id FROM public.deudas WHERE usuario_id = p_usuario_id);
  DELETE FROM public.deudas       WHERE usuario_id = p_usuario_id;

  DELETE FROM public.gasto_participantes WHERE usuario_id = p_usuario_id;
  DELETE FROM public.gastos_compartidos  WHERE creador_id = p_usuario_id;

  DELETE FROM public.meta_aportes       WHERE usuario_id = p_usuario_id;
  DELETE FROM public.meta_participantes WHERE usuario_id = p_usuario_id;
  DELETE FROM public.metas_ahorro       WHERE usuario_id = p_usuario_id;
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

  -- Las dos llevan el numero en una columna PROPIA, ademas de la FK. `errores` es CASCADE y
  -- `tickets_soporte` tambien, pero ninguna se borraba antes.
  DELETE FROM public.errores          WHERE usuario_id = p_usuario_id;
  DELETE FROM public.tickets_soporte  WHERE usuario_id = p_usuario_id;

  -- `nlp_errors` SE BORRA, no se anonimiza, y esta es la tabla que mas facil se cuela: su FK
  -- es SET NULL, o sea que "anonimizar" ahi corta el vinculo y DEJA `whatsapp` y `mensaje` —
  -- el texto literal de lo que la persona escribio. Medido: 185 de 185 filas llevan el numero
  -- y 156 ya tenian `usuario_id` en null, o sea que la mayoria solo es alcanzable por telefono.
  -- Por eso el WHERE mira las dos columnas.
  DELETE FROM public.nlp_errors
  WHERE usuario_id = p_usuario_id
     OR (v_whatsapp IS NOT NULL AND whatsapp = v_whatsapp);

  -- La tabla que el inventario de "las 30" no ve: no tiene FK a `usuarios`, asi que ningun
  -- cascade la iba a alcanzar nunca. Guarda email, nombre y el numero reclamado y verificado.
  DELETE FROM public.webapp_otp
  WHERE (v_auth_id  IS NOT NULL AND supabase_auth_id  = v_auth_id)
     OR (v_email    IS NOT NULL AND lower(email)      = lower(v_email))
     OR (v_whatsapp IS NOT NULL AND (whatsapp_claimed = v_whatsapp OR whatsapp_verified = v_whatsapp));

  -- El historial de a quien refirio esta persona es suyo y se va. El lado espejo (alguien que
  -- la refirio A ELLA) se desvincula: esa fila es el historial del OTRO.
  DELETE FROM public.referidos WHERE referrer_id = p_usuario_id;
  UPDATE public.referidos SET referido_id = NULL WHERE referido_id = p_usuario_id;

  DELETE FROM public.transacciones_eliminadas WHERE usuario_id = p_usuario_id;
  -- Ultima de las suyas: es la que dispara un INSERT de auditoria por fila, y quiero que todo
  -- ese rastro exista ya cuando corra la purga del final.
  DELETE FROM public.transacciones WHERE usuario_id = p_usuario_id;

  -- ── 3.4 Lo que se conserva, sin lo que nombra a la persona ────────────────
  -- `pagos` se queda por obligacion contable — la excepcion que la politica ya contempla — pero
  -- el registro contable es CUANTO y CUANDO, no nuestra copia de su captura de Yape. El
  -- `comprobante_url` apunta al objeto de Storage que el servicio borra a continuacion, y
  -- `notas` es texto libre del admin que puede nombrarla.
  UPDATE public.pagos SET comprobante_url = NULL, notas = NULL WHERE usuario_id = p_usuario_id;

  -- ── 3.5 La lapida ─────────────────────────────────────────────────────────
  -- Se va todo lo que identifica; se queda lo que sostiene el entitlement y el HECHO de la baja.
  -- `plan`, `tipo_plan`, `premium_desde` y `premium_vence` NO se tocan (decision lockeada: quien
  -- pago conserva su Pro). Los unicos indices sobre estas columnas son parciales o toleran N
  -- NULLs, asi que varias lapidas conviven sin chocar.
  --
  -- `onboarding_paso = 0` va ACA, dentro de la transaccion, y eso cierra el residual del paso -1:
  -- ya no existe el estado "wipe exitoso + atascado en el menu", que era el que hacia que el
  -- siguiente mensaje libre respondiera "Cancelado. Tu cuenta sigue igual" despues de borrar todo.
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
    cuenta_borrada_at    = now()
  WHERE id = p_usuario_id;

  -- Gmail: el correo en claro se va (es dato personal y solo servia de comodidad), el hash se
  -- queda (es lo unico que impide quemar otro cupo de los 100). Si el llamador no pudo calcular
  -- el hash — falta el pepper — manda `false` y el correo NO se borra: se prefiere retener un
  -- dato de mas antes que perder un cupo irrecuperable. Es la unica direccion de fallo aceptable.
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

  -- ── 3.6 El rastro de auditoria, al final ──────────────────────────────────
  -- Al final para llevarse tambien las filas que este mismo borrado acaba de generar.
  v_purgadas := public.purgar_auditoria_usuario(p_usuario_id, 'baja_de_cuenta');

  -- ── 3.7 Residual ──────────────────────────────────────────────────────────
  -- La allowlist es el inventario hecho ejecutable: son las columnas donde una fila viva es
  -- una DECISION, no un olvido. Cualquier otra que devuelva filas es un agujero.
  FOR r IN
    SELECT c.conrelid::regclass::text AS tabla, a.attname AS col
      FROM pg_constraint c
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
     WHERE c.contype = 'f' AND c.confrelid = 'public.usuarios'::regclass
  LOOP
    CONTINUE WHEN (r.tabla || '.' || r.col) IN (
      'pagos.usuario_id',              -- obligacion contable
      'gmail_cuentas.usuario_id',      -- el hash que protege el cupo
      'shared_spaces.created_by',      -- espacio con otras personas adentro
      'space_expenses.paid_by',        -- gasto que entra en la cuenta de otros
      'space_settlements.from_user',   -- liquidacion: tiene dos lados
      'space_settlements.to_user'
    );
    EXECUTE format('SELECT count(*) FROM %s WHERE %I = $1', r.tabla, r.col)
      INTO v_n USING p_usuario_id;
    IF v_n > 0 THEN
      v_residual := v_residual || jsonb_build_object(r.tabla || '.' || r.col, v_n);
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'usuario_id',        p_usuario_id,
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

COMMENT ON FUNCTION public.borrar_cuenta_total(uuid, boolean) IS
  'Borrado de cuenta en UNA transaccion: borra 24 tablas, anonimiza 6, conserva pagos sin comprobante, purga el rastro de borrados y deja la fila de usuarios como lapida. Devuelve conteos y el residual recomputado de pg_constraint. Storage, auth.users y la revocacion en Google los hace services/account-deletion.js. Ver migrations/073.';

REVOKE ALL ON FUNCTION public.borrar_cuenta_total(uuid, boolean) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.borrar_cuenta_total(uuid, boolean) TO service_role;
