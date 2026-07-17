-- Flag de barrido histórico único. Se pone en TRUE la primera vez que Neto completa
-- un escaneo de 30 días tras conectar Gmail (routes/public.js /auth/callback →
-- escanearHistoricoInicial). Evita repetir el import histórico en reconexiones.
-- El escaneo recurrente (cron, cada intervalo) sigue leyendo solo newer_than:2d y NO
-- consulta este flag. Default FALSE = elegible para el barrido en la próxima primera
-- conexión de Gmail.
alter table usuarios add column if not exists historico_importado boolean not null default false;

-- Backfill: los usuarios que YA tenían Gmail conectado antes de este feature no deben
-- disparar un import de 30 días si reconectan. Se marcan como ya importados; el barrido
-- aplica solo a conexiones genuinamente nuevas de aquí en adelante.
update usuarios set historico_importado = true
where gmail_access_token is not null
   or id in (select usuario_id from gmail_cuentas where activa = true);
