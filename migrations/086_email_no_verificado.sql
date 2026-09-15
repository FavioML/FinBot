-- 086 · Borrar los correos que nadie probó (15-sep-2026)
--
-- `usuarios.email` dejó de ser una columna de direcciones probadas en el alta viejo por
-- WhatsApp: el paso 101 (retirado el 31-jul-2026 en `3c992bb`) le pedía el correo a la persona
-- y lo guardaba tal cual lo dictaba. Nadie lo verificó. Un error de tipeo que cae en la bandeja
-- real de otra persona le manda a un desconocido los avisos de plata de alguien más (fin de
-- prueba, resumen de deudas, inactividad, respuestas de soporte), y en el d11/d14 el link de
-- activación de su cuenta.
--
-- Medido el 15-sep-2026 sobre producción, antes de escribir esto:
--   · 22 filas vivas, reales, sin cuenta web y con correo; 1 probada por su propio
--     `gmail_cuentas`, ninguna con token de Gmail legacy.
--   · 0 filas `canal='email'` en `notification_deliveries` para esas 22: todavía no le llegó
--     nada a nadie. La exposición era latente.
--   · 111 de 113 filas con cuenta web tienen `email` igual al de su usuario de auth; las otras 2,
--     null. Cero discrepancias.
--
-- El canal de correo ya no les escribe (`correoVerificado`, lib/email.js, mismo commit), así que
-- borrar no es lo que las protege. Se borran por lo que esas direcciones todavía hacen:
--   · ocupan `usuarios_email_lower_unique`. Si la dueña real de una dirección mal tipeada se da
--     de alta en la web, su fila nace SIN correo (`createWebUser` reintenta sin él) y nunca
--     recibe uno;
--   · son lo único que `merge_and_link` (085, `COALESCE(s.email, l.email)`) y el fallback del
--     OTP (`otp.email || usuario.email`) podían pasarle a una fila web, que es la que se lee
--     como probada.
--
-- Qué queda: todo correo probado por la sesión (el de su usuario de auth) o por su propio Gmail.
-- Las cuentas de prueba no se tocan (no reciben correo: `skipped_test`), y la lápida ya tiene
-- `email` en null.
--
-- Marcha atrás: el backup diario a R2 conserva los valores 30 días (y el mensual, 365). No se
-- guardan aparte a propósito: una dirección sin probar no tiene un uso que justifique retenerla.
--
-- Verificación: `qa-e2e/probe-email-no-verificado.mjs` sale exit 1 antes de esto (21) y exit 0
-- después.
--
-- Sin BEGIN/COMMIT propio: se aplica en UNA transacción junto con su fila en
-- `supabase_migrations.schema_migrations` (ver .claude/rules/database.md).

UPDATE public.usuarios u
   SET email = NULL
 WHERE u.email IS NOT NULL
   AND u.is_test_user IS NOT TRUE
   AND NOT EXISTS (
     SELECT 1 FROM auth.users a
      WHERE a.id = u.supabase_auth_id
        AND lower(a.email) = lower(u.email)
   )
   AND NOT EXISTS (
     SELECT 1 FROM public.gmail_cuentas g
      WHERE g.usuario_id = u.id
        AND lower(g.email) = lower(u.email)
   );
