-- 083 · Instrumentar el INTENTO de vincular WhatsApp desde la webapp.
--
-- ─── La pregunta que hoy no se puede contestar, y de la que depende una decisión ─────────
--
-- El alta web-first existe desde el 02-ago-2026. Medido el 03-sep contra producción:
--
--   · 23 cuentas web sin número, y **ninguna** vinculó WhatsApp;
--   · **19 de esas 23 nunca registraron una sola transacción**;
--   · en septiembre son 9 de 9 altas web, todas sin número y todas sin transacciones.
--
-- Favio quiere pedir el teléfono obligatorio al registrarse. La idea ataca un problema real,
-- pero **hoy no se puede distinguir "intentó vincular y no pudo" de "ni abrió la pantalla"**,
-- y las dos lecturas piden arreglos OPUESTOS: la primera es un bug en la pantalla de
-- vinculación, la segunda es fricción que falta en el alta. Sin este dato se estaría diseñando
-- contra un problema de tamaño desconocido, que es justo lo que pasó con los pasos 30/31 del
-- onboarding: existieron para producir un valor que en producción siempre fue `null`.
--
-- ─── Por qué `webapp_otp` no lo puede contestar, aunque lo parezca ──────────────────────
--
-- Esa tabla tiene **una sola fila en toda su vida** y podría leerse como "nadie lo intentó
-- nunca". Es falso por dos mecanismos independientes:
--
--   · el upsert es por `supabase_auth_id` (un OTP pendiente por cuenta), así que reintentar
--     PISA el intento anterior en vez de sumar;
--   · `cron/checks.js` borra las filas con `expires_at` vencido, así que la tabla es una
--     ventana viva de 15 minutos, no un registro histórico.
--
-- O sea que `webapp_otp` responde "¿tiene un código pendiente ahora?", que es otra pregunta.
--
-- ─── Por qué dos columnas y no una tabla de eventos ─────────────────────────────────────
--
-- La pregunta es de ESTADO por persona ("¿esta cuenta lo intentó?"), no una serie temporal.
-- Dos columnas en la fila que ya existe se consultan con un `count(*) filter`, no necesitan
-- retención, y el borrado de cuenta ya se las lleva por la lápida.
--
-- `otp_solicitado_at` es el PRIMER intento y no se pisa (COALESCE en el UPDATE): es un hecho,
-- no un estado. `otp_solicitudes` cuenta, que es lo que separa "lo intentó y se fue" de
-- "lo intentó nueve veces" — la forma de alguien peleándose con la pantalla, que es exactamente
-- lo que le pasó al usuario del 02-sep (mandó 9 códigos en 9 minutos).
--
-- Lectura, dentro de 2-3 semanas:
--
--   select count(*) filter (where otp_solicitado_at is not null) intentaron,
--          count(*) filter (where otp_solicitado_at is null)     ni_lo_intentaron,
--          count(*) filter (where otp_solicitudes >= 3)          insistieron
--     from usuarios
--    where supabase_auth_id is not null and whatsapp is null
--      and coalesce(is_test_user,false) = false and cuenta_borrada_at is null;
--
-- Nota al leerla: sólo cuenta desde HOY. Las 23 cuentas de agosto van a salir todas como
-- `ni_lo_intentaron` sin que eso signifique nada sobre ellas.

ALTER TABLE public.usuarios
  ADD COLUMN IF NOT EXISTS otp_solicitado_at timestamptz,
  ADD COLUMN IF NOT EXISTS otp_solicitudes   integer DEFAULT 0;

COMMENT ON COLUMN public.usuarios.otp_solicitado_at IS
  'Primera vez que esta cuenta pidió un código para vincular WhatsApp desde la webapp. No se pisa: es un hecho. NULL = nunca lo intentó.';
COMMENT ON COLUMN public.usuarios.otp_solicitudes IS
  'Cuántas veces lo pidió. Separa "lo intentó una vez y se fue" de "se peleó con la pantalla".';
