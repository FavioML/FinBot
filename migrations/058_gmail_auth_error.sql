-- Distinguir "Gmail conectado" de "conectado pero con el token muerto".
--
-- Cuando Google revoca el refresh token (invalid_grant), el barrido avisa una vez y sigue:
-- la fila queda en `activa = true`. Como /api/pro/status calcula `gmailConectado` desde esa
-- columna, la tarjeta de /dashboard/pro afirma "Gmail conectado" mientras no se lee un solo
-- correo. Y el único aviso vivía en un throttle EN MEMORIA (`authErrorNotifiedAt`), o sea que
-- un redeploy lo borraba: quien se perdió ese mensaje no tenía forma de enterarse.
--
-- Esta columna NO reemplaza a `activa`. Son dos estados distintos y hacen falta los dos:
--
--   activa = false      -> desconectada a propósito (no-pagador, reemplazo, wipe). Revocada
--                          en Google, el permiso ya no existe.
--   auth_error_at set   -> sigue conectada en nuestros libros, pero Google dejó de aceptar
--                          el refresh token. Hay que volver a autorizar.
--
-- Colapsarlas en `activa = false` sacaría al usuario del barrido (que selecciona por
-- activa = true) y le haría perder el hilo a emailGmailVinculado / login_hint, que es lo
-- único que protege el cupo de Google al reconectar.
--
-- Se sella en el ORIGEN (configurarClienteParaCuenta en gmail.js), que es el único punto que
-- sabe QUÉ fila falló: más arriba, leerCorreosBancarios colapsa N cuentas en un solo flag y
-- escanearGmailYRegistrar devuelve `{authError:true}` sin email ni id. Sellar ahí también
-- cubre los tres productores del error (barrido automático, /escanear por WhatsApp y el
-- barrido histórico del callback de OAuth); los dos últimos hoy lo descartan en silencio.
--
-- El write es condicional a que esté en NULL, así la marca registra CUÁNDO se rompió y no la
-- última vez que se reintentó. La limpia toda conexión exitosa, en el upsert de guardarTokens.
--
-- Sin backfill: al 03-ago-2026 las 3 cuentas activas refrescaron token sin error (verificado
-- contra prod y contra los logs del barrido de las 18:38 UTC).

ALTER TABLE gmail_cuentas ADD COLUMN IF NOT EXISTS auth_error_at timestamptz;

COMMENT ON COLUMN gmail_cuentas.auth_error_at IS
  'Primer instante en que Google rechazó el refresh token (invalid_grant). NULL = sana. La limpia toda conexión exitosa (guardarTokens). No confundir con activa=false, que es desconexión deliberada.';
