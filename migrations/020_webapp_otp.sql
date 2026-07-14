-- Reverse-OTP para verificar posesion del numero de WhatsApp al vincular la cuenta
-- web (Google OAuth) con el registro de usuario.
--
-- Cierra el hueco de account-linking del onboarding webapp: antes, un usuario
-- logueado con Google podia reclamar el registro de OTRO usuario con solo teclear
-- su numero (POST /api/onboarding reasignaba supabase_auth_id sin probar posesion).
--
-- Flujo nuevo: la webapp genera un codigo, el usuario lo envia al bot desde SU
-- WhatsApp (wa.me deep link con el codigo pre-escrito). El webhook ve el numero
-- real que envio (posesion probada) y recien ahi vincula la cuenta.

create table if not exists webapp_otp (
  id                bigint generated always as identity primary key,
  supabase_auth_id  uuid not null,
  email             text,
  nombre            text,
  code              text not null,
  whatsapp_claimed  text,           -- numero tecleado en la webapp (referencia)
  whatsapp_verified text,           -- numero real que envio el codigo (probado)
  verified_at       timestamptz,
  created_at        timestamptz not null default now(),
  expires_at        timestamptz not null
);

-- Un OTP pendiente por cuenta Google: regenerar reemplaza el anterior (upsert).
create unique index if not exists webapp_otp_auth_uidx on webapp_otp (supabase_auth_id);
-- Lookup del webhook por codigo al recibir el mensaje.
create index if not exists webapp_otp_code_idx on webapp_otp (code);

-- Solo el service-role (server) accede. Sin politicas => cero acceso desde el cliente.
alter table webapp_otp enable row level security;
