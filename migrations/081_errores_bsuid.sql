-- 081: `errores.bsuid` — hacer BORRABLE lo que este mismo mes se volvio ATRIBUIBLE.
--
-- El 02-sep-2026 el webhook empezo a guardar el texto del mensaje en las filas de "Mensaje
-- entrante sin from" (acotado a 200 chars, solo tipo `text`). Sin eso, las 9 filas de un usuario
-- real que quedo trabado eran indistinguibles de cualquier otra y solo se supo que pasaba porque
-- la persona reclamo por Instagram.
--
-- El problema que abrio: `borrar_cuenta_total` barre `errores` por `usuario_id` y por `whatsapp`,
-- y estas filas no llevan ninguno de los dos — nacen de alguien a quien todavia no identificamos.
-- La justificacion inicial ("son de gente que no identificamos, asi que no hay cuenta que
-- borrar") **se cae con la feature del mismo dia**: la fila lleva el BSUID, y una vinculacion
-- exitosa escribe ese mismo valor en `usuarios.bsuid`. La atribucion se fabrica retroactivamente.
--
-- POR QUE ESTA MIGRACION NO TOCA `borrar_cuenta_total`, que era el plan obvio:
--
--   · el DELETE por `usuario_id` YA existe y ya esta probado por `qa-borrado-cuenta.mjs`. Lo que
--     falta no es una condicion nueva: es que estas filas TENGAN su `usuario_id`, y se lo podemos
--     poner en el mismo instante en que la persona deja de ser anonima (ver `otp-sin-numero.js`,
--     que hace el backfill al vincular). Menos superficie nueva sobre la funcion mas sensible del
--     sistema, y ningun hash de canary que actualizar.
--   · la alternativa que se descarto MIDIENDO era filtrar por `detalle::json ->> 'fromUserId'`.
--     **Habria abortado el borrado entero**: `errores.detalle` es texto libre y hoy hay 9 filas
--     que no son JSON valido, asi que el cast lanza. Un borrado de cuenta que revienta por una
--     fila de log ajena es peor que el hueco que venia a cerrar.
--   · el caso que queda afuera se cierra solo: quien NUNCA se vincula no tiene cuenta, y sin
--     cuenta no hay pedido de baja posible. El derecho de supresion se ejerce sobre una cuenta.
--
-- La columna ademas cierra la otra mitad del hallazgo: hasta hoy el conteo de "cuantas PERSONAS
-- distintas" que usa la alerta vivia solo en memoria (`_errorCounts` de `lib/error-monitor.js`) y
-- moria con cada deploy, asi que una alerta que dijo "5 personas distintas" no se podia
-- reconstruir despues. Ahora sale de la tabla.

ALTER TABLE public.errores ADD COLUMN IF NOT EXISTS bsuid text;

COMMENT ON COLUMN public.errores.bsuid IS
  'Business Scoped User ID de Meta (PE.xxx) cuando el error lo provoco alguien sin numero '
  'visible. Sirve para dos cosas: contar PERSONAS distintas en vez de mensajes, y rellenar '
  '`usuario_id` cuando esa persona se vincula, que es lo que hace la fila borrable por '
  '`borrar_cuenta_total`. Ver migracion 081 y services/otp-sin-numero.js.';

-- Parcial: la enorme mayoria de las filas de `errores` no tienen BSUID y no hace falta indexarlas.
-- Lo usa el backfill de la vinculacion, que busca por bsuid con `usuario_id is null`.
CREATE INDEX IF NOT EXISTS idx_errores_bsuid
  ON public.errores (bsuid)
  WHERE bsuid IS NOT NULL;
