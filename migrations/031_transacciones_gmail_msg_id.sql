-- 031: identificador del correo Gmail de origen + índice único parcial anti-doble-barrido.
--
-- Problema (C3-residual del CTO audit 2026-07-18): el scanner de Gmail dedup-ea un correo
-- por SELECT-luego-INSERT sobre `descripcion_original = msg.id`, sin unique en DB. Dos
-- escaneos solapados (el sweep histórico de 30d por setTimeout + el cron cada 15min) pueden
-- pasar ambos el SELECT antes de que cualquiera inserte → doble fila para el mismo correo.
--
-- No se puede poner UNIQUE sobre `descripcion_original`: esa columna es compartida con las
-- entradas manuales de texto libre (dos "taxi 20" del mismo día colisionarían). Por eso una
-- columna dedicada `gmail_msg_id` con índice único parcial (solo filas con correo de origen).
--
-- Sin backfill a propósito: la race solo puede duplicar correos NUNCA vistos (ambos inserts
-- son nuevos y ambos escriben gmail_msg_id → el índice los atrapa). Los correos ya registrados
-- antes de esta migración tienen gmail_msg_id NULL, pero el pre-check por descripcion_original
-- del scanner (services/gmail-scanner.js) los sigue cubriendo, así que no se re-insertan.
--
-- El scanner escribe msg.id en gmail_msg_id (services/gmail-scanner.js → guardarTransaccion),
-- y guardarTransaccion (services/transactions.js) trata el error 23505 como dedup: devuelve la
-- fila que ya ganó en vez de lanzar.
--
-- RLS: `transacciones` ya tiene RLS; una columna nueva hereda las políticas existentes.
alter table transacciones add column if not exists gmail_msg_id text;

-- Único por (usuario_id, gmail_msg_id) solo donde hay correo de origen. Parcial: los registros
-- manuales/imagen (gmail_msg_id NULL) no compiten por el índice.
create unique index if not exists idx_transacciones_usuario_gmail_msg_id
  on transacciones (usuario_id, gmail_msg_id)
  where gmail_msg_id is not null;
