-- Alta reordenada: el valor antes que la identidad.
--
-- El baseline del 2026-07-31 (82 usuarios) midió 21 caídas ANTES de que la
-- persona usara Neto una sola vez: 10 en el paso del nombre y 7 en el del email.
-- El paso del email no tenía razón de producto (servía para vincular la cuenta
-- web, cosa que ahora hace el link firmado de lib/activacion.js), así que se
-- retiró; el del nombre dejó de ser un bucle sin salida.
--
-- Esta migración solo agrega las dos columnas que el flujo nuevo necesita y
-- desatasca a los que quedaron en un paso que ya no existe.

-- Cuántas veces se le repreguntó el nombre. Al segundo intento fallido el alta
-- se cierra igual: vale más un usuario activo sin nombre que uno trabado con él.
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS nombre_intentos smallint NOT NULL DEFAULT 0;

-- Ledger del empujón proactivo del día 2 (cron/checks.js → checkActivacionDia2).
-- Un solo envío por usuario: si insistir no funcionó la primera vez, repetirlo
-- fuera de la ventana de 24h de Meta solo produce filas blocked_24h.
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS activacion_nudge_at timestamptz;

-- Índice parcial para el barrido diario: solo interesan los NO activados.
-- Sin esto el cron escanea la tabla entera para encontrar un puñado de filas.
CREATE INDEX IF NOT EXISTS idx_usuarios_sin_activar
  ON usuarios (created_at)
  WHERE supabase_auth_id IS NULL AND activacion_nudge_at IS NULL;

-- Desatascar los dos pasos que quedaron sin entrada (medidos el 2026-07-31: 7 en
-- el 101 y 3 en el 1). Ambos son ahora bucles sin salida: el usuario responde y
-- el bot le vuelve a pedir lo mismo para siempre.
--   101 — pedía el email. Se retiró: era el punto de fuga más caro y su única
--         razón era vincular la cuenta web, que ahora resuelve el link firmado.
--     1 — pedía elegir Free o Pro. Se retiró porque el modelo pasa a ser probar
--         primero y pagar después; ya nada enruta hacia ahí desde el alta.
-- Todos ellos YA dieron nombre y correo, así que no queda nada que preguntarles.
-- handlers/onboarding.js tiene además una rama de compatibilidad para el 101 con
-- la data en vuelo durante el deploy; esto es para los que están quietos.
--
-- Los que están en el paso 100 (sin nombre) NO se tocan a propósito: ese paso
-- sigue existiendo y ahora tiene salidas (saltar, escribir un gasto, o el
-- segundo intento), así que cerrarles el alta en silencio solo perdería un
-- nombre que todavía podemos pedir cuando vuelvan a escribir.
--
-- El paso 2 tampoco se toca: ahí hay gente esperando enviar su comprobante de
-- pago, y sacarlos rompería esperaComprobante() (lib/pro-payment.js).
UPDATE usuarios
   SET onboarding_paso = 0,
       onboarding_completado = true
 WHERE onboarding_paso IN (1, 101)
   AND (onboarding_completado IS NULL OR onboarding_completado = false);
