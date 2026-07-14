-- 022_usuarios_email_unique.sql
-- Índice único parcial sobre lower(email): garantía a nivel DB de que un mismo
-- correo no quede registrado en dos usuarios distintos (case-insensitive).
-- Complementa el chequeo app-level del onboarding (handlers/webhook.js, paso 101)
-- cerrando la ventana TOCTOU entre "verificar duplicado" e "insertar", y protege
-- contra cualquier otro path que escriba email (ej. linking por OTP webapp).
--
-- Parcial: ignora NULL y '' (usuarios que aún no dieron su correo), para no
-- colisionar entre sí. El código que golpea unique_violation (23505) responde
-- con un mensaje amable pidiendo otro correo.
--
-- Aplicado en vivo a Supabase (proyecto zvorjqlubmfrjtkbhqcx) el 2026-07-14.

CREATE UNIQUE INDEX IF NOT EXISTS usuarios_email_lower_unique
  ON usuarios (lower(email))
  WHERE email IS NOT NULL AND email <> '';
