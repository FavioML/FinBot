-- Marcar en la webapp los movimientos que entraron desde la última vez que la persona miró.
--
-- La mayoría de las transacciones no nacen en la webapp: las escribe el bot de WhatsApp (texto,
-- foto, audio) o el barrido de Gmail. Quien entra a la webapp cada pocos días no tiene forma de
-- saber cuáles son nuevas para revisar que se hayan registrado bien. `vista_at` es esa marca:
--
--   vista_at IS NULL  -> nueva, todavía no la vio en la webapp.
--   vista_at set      -> la vio (OK en la fila, la abrió, la editó o tocó "Ya los vi").
--
-- Se llama `vista` y no `revisada` a propósito: la pantalla ya tiene "Por revisar" para lo que
-- Neto no supo categorizar, y son dos cosas distintas.
--
-- El backend NO se toca: ningún insert del bot ni del barrido nombra esta columna, así que todo
-- lo que entra por ahí nace NULL, que es lo que se quiere. Lo que se crea EN la webapp (formulario,
-- importación) lo escribe la propia ruta con la hora del insert: la persona lo acaba de hacer.
--
-- Por qué ADD con DEFAULT now() y después DROP DEFAULT, y no ADD + UPDATE de todas las filas:
-- `now()` es STABLE, así que Postgres (11+) lo evalúa UNA vez y lo guarda en el catálogo como
-- valor de las filas existentes, sin reescribir la tabla. Un UPDATE masivo es la ráfaga de IO que
-- tumbó la base el 13-oct-2026 (presupuesto de disco de Supabase Free). Medido antes de aplicar
-- sobre una tabla temporal en producción: mismo filenode antes y después (sin reescritura), las
-- filas viejas con fecha y la insertada después del DROP DEFAULT en NULL.
--
-- Sin índice: la webapp ya trae el historial completo del usuario para el contador de
-- "Por revisar" y cuenta las nuevas en el cliente. El update de "Ya los vi" filtra por
-- usuario_id, que ya está indexado.

ALTER TABLE transacciones ADD COLUMN IF NOT EXISTS vista_at timestamptz DEFAULT now();
ALTER TABLE transacciones ALTER COLUMN vista_at DROP DEFAULT;

COMMENT ON COLUMN transacciones.vista_at IS
  'Cuándo la persona la vio en la webapp. NULL = nueva (entró por WhatsApp o Gmail y todavía no la miró). Lo que se crea en la webapp nace con la hora del insert. Las filas anteriores a la migración 091 quedaron con la hora de la migración.';
