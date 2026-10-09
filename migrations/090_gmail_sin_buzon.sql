-- Distinguir "Gmail conectado" de "conectaste una cuenta de Google que no tiene Gmail".
--
-- Una cuenta de Google se puede crear con un correo ajeno (Hotmail, Outlook, un dominio
-- propio sin Workspace). El OAuth pasa igual —Google emite el grant y nos cuesta uno de los
-- 100 cupos de por vida— pero esa cuenta no tiene bandeja: `users.messages.list` responde
-- 400 FAILED_PRECONDITION "Mail service not enabled". Medido el 07-oct-2026: un Pro pagado
-- conectó una cuenta así el 21-sep y tenía 0 transacciones de Gmail, con dos líneas
-- "Error en query Gmail: Mail service not enabled" por barrido (cada 15 min), sin usuario en el
-- log, y la tarjeta de /dashboard/pro diciéndole "Gmail conectado ✓".
--
-- Es un tercer estado y no cabe en las columnas que ya existen:
--
--   activa = false      -> desconectada a propósito (revocada en Google).
--   auth_error_at set   -> Google dejó de aceptar el refresh token. Reconectar ESA cuenta lo
--                          arregla.
--   sin_buzon_at set    -> el token anda, la cuenta no tiene Gmail. Reconectar esa misma cuenta
--                          NO lo arregla, y conectar otra cuesta otro cupo y choca con la regla
--                          de una cuenta por usuario: se resuelve por soporte.
--
-- Reusar `auth_error_at` le pediría "reconecta" a quien no puede arreglarlo así, y poner
-- `activa = false` le haría perder el hilo a `emailGmailVinculado` / `login_hint`.
--
-- Se sella en `leerCorreosBancarios` (gmail.js) la primera vez que Gmail responde así, con el
-- write condicional a NULL (la marca es CUÁNDO se detectó). El barrido salta las cuentas
-- selladas salvo una re-prueba por día (`tocaReprobarSinBuzon`), que quita la marca si la cuenta
-- vuelve a listar: el mismo texto sale cuando un admin de Workspace apaga Gmail, y eso se puede
-- revertir. La limpia también toda conexión exitosa (`guardarTokens`). El COMMENT de abajo es el
-- que se aplicó y no menciona la re-prueba (se agregó en la revisión, antes del primer deploy).
--
-- Sin backfill a mano: la fila afectada se sella sola en el primer barrido después del deploy.

ALTER TABLE gmail_cuentas ADD COLUMN IF NOT EXISTS sin_buzon_at timestamptz;

COMMENT ON COLUMN gmail_cuentas.sin_buzon_at IS
  'Primer instante en que Gmail respondió "Mail service not enabled": la cuenta de Google no tiene buzón de Gmail. NULL = tiene (o no se sabe todavía). El barrido la salta. La limpia toda conexión exitosa (guardarTokens).';
