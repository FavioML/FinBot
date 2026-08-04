-- Un referido puede tener UN solo referrer.
--
-- La única restricción que había era `UNIQUE (referrer_id, referido_id)`, que
-- impide registrar dos veces el mismo par pero **no** impide dos pares distintos
-- sobre el mismo referido. O sea que quien escribiera "hola neto ref:A" y después
-- "hola neto ref:B" terminaba con dos filas, cada una con su referrer.
--
-- Lo que rompe eso, y es peor que el doble vínculo en sí:
--
--   · `procesarConversionProReferido` lee la fila con
--     `.eq('referido_id', id).maybeSingle()`. Con dos filas, PostgREST devuelve
--     ERROR (no dos filas): la función loguea y sale. Nadie cobra el mes,
--     `convertido_pro` se queda en false, y la fila **no aparece** en la consulta
--     `where convertido_pro and premio_otorgado_at is null` que la 062 puso como
--     detector de premios perdidos. El agujero que esa migración vino a cerrar
--     seguía abierto justo por este camino.
--   · Y si ese `maybeSingle` alguna vez se relaja a `.limit(1)`, el sello y el
--     rollback —que filtran solo por `referido_id`— escribirían las DOS filas.
--
-- El producto ya decía esto: `registrarReferido` trata el `23505` como "ya
-- existía" (primer link gana, anti-farming). Esto lo hace cierto en la base y no
-- solo en el camino feliz del código.
--
-- `referido_id` es NULLABLE y su FK es `ON DELETE SET NULL`: al borrar un usuario
-- su fila queda con NULL. UNIQUE en Postgres permite múltiples NULLs, así que
-- borrar dos usuarios referidos no choca.
--
-- Seguro de aplicar: `referidos` está vacía (0 filas al 04-ago-2026), así que no
-- hay duplicados que resolver primero.

CREATE UNIQUE INDEX IF NOT EXISTS referidos_referido_id_key
  ON public.referidos (referido_id);

COMMENT ON INDEX public.referidos_referido_id_key IS
  'Un referido tiene UN solo referrer. Sin esto, dos filas rompian el .maybeSingle() de procesarConversionProReferido y el premio se perdia de forma invisible. Ver migrations/064.';
