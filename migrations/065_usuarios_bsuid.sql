-- 065: guardar el BSUID (Business Scoped User ID) de cada usuario de WhatsApp.
--
-- Meta arrancó el rollout de WhatsApp Usernames. El usuario que activa un username oculta su
-- número: `from` y `wa_id` dejan de venir en el webhook y en su lugar llega `from_user_id`,
-- un identificador opaco por negocio (formato `PE.1049206861029395`). Cuando eso pasa, hoy no
-- tenemos forma de saber QUIÉN escribió, y el mensaje se descarta (ver handlers/webhook.js).
--
-- La ventana para arreglarlo es AHORA: medido el 2026-08-08 con tráfico real, Meta ya manda el
-- BSUID en todos los mensajes, junto al número (`contacts[0]` trae `wa_id` Y `user_id`). O sea
-- que mientras el usuario siga mandando número podemos aprender su BSUID; el día que active el
-- username, esta columna es lo único que lo conectará con su cuenta y su historial.
--
-- Nada de esto permite RESPONDERLE: enviar por BSUID no está habilitado en nuestra WABA
-- (probado contra v19.0/v23.0/v24.0/v25.0, todas rechazan `recipient`). Esto protege el
-- registro de gastos, que es lo que el modelo promete gratis para siempre.
alter table usuarios add column if not exists bsuid text;

-- Único, pero parcial: `bsuid` es null para todo usuario web-first y para quien no haya
-- escrito desde el deploy, y esas filas no deben colisionar entre sí.
create unique index if not exists usuarios_bsuid_key on usuarios (bsuid) where bsuid is not null;

comment on column usuarios.bsuid is
  'Business Scoped User ID de Meta (formato CC.alfanumerico). Identifica al usuario cuando '
  'activa un username de WhatsApp y deja de mandar su numero. Se aprende de from_user_id en '
  'el webhook. Es por-negocio: el mismo usuario tiene otro BSUID con otra marca.';
