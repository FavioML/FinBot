-- El claim del referido se consumía ANTES de otorgar el premio.
--
-- `procesarConversionProReferido` hacía dos escrituras en dos tablas distintas y
-- no hay transacción entre ellas:
--
--   1. CLAIM   `referidos.convertido_pro` false -> true  (idempotencia)
--   2. GRANT   `usuarios.premium_vence` += 1 mes         (el premio)
--
-- El claim es correcto que sea pegajoso: evita premiar dos veces la misma
-- conversión. El problema era que si el paso 2 fallaba —un hipo de Supabase al
-- leer al referrer, el proceso muerto entre las dos— el claim ya estaba puesto,
-- así que en el siguiente intento la función salía por `if (convertido_pro)
-- return`. El mes que el referrer se ganó desaparecía **para siempre y en
-- silencio**: nadie lo sabía, porque el aviso también sale después del grant.
--
-- Esta columna separa los dos hechos, que hasta ahora estaban colapsados en uno:
--
--   `convertido_pro_at`  = el referido PAGÓ. Hecho del mundo, irreversible.
--   `premio_otorgado_at` = al referrer se le acreditó su mes. Consecuencia.
--
-- Con las dos separadas, "premios que se deben y no se pagaron" pasa a ser una
-- consulta en vez de un agujero invisible:
--
--   SELECT * FROM referidos
--    WHERE convertido_pro AND premio_otorgado_at IS NULL;
--
-- Lo que hace el código encima de esto (services/referrals.js):
--   · Si falla la LECTURA del referrer, todavía no se escribió nada en
--     `usuarios`: el claim se REVIERTE y el siguiente intento reintenta limpio.
--   · Si falla el UPDATE de `usuarios`, no se sabe si entró: NO se revierte
--     (revertir arriesga pagar dos meses) y se avisa al admin en el acto.
--   · En los dos casos, y también si el CAS se agota, sale un aviso al admin sin
--     cooldown. Un premio perdido es plata; no puede depender de que alguien
--     mire los logs.
--
-- Backfill: no hace falta. `referidos` está vacía (0 filas al 04-ago-2026), o sea
-- que ningún premio se otorgó nunca todavía. El DEFAULT NULL deja la invariante
-- limpia desde la primera conversión real.

ALTER TABLE public.referidos
  ADD COLUMN IF NOT EXISTS premio_otorgado_at timestamptz;

COMMENT ON COLUMN public.referidos.premio_otorgado_at IS
  'Cuando se le acredito el mes al referrer. NULL con convertido_pro=true significa premio DEBIDO y no pagado (fallo transitorio): ver migrations/062 y services/referrals.js.';

-- Para la consulta de arriba, que es la que va a correr un humano buscando
-- premios pendientes. Parcial: solo indexa las filas en el estado anomalo, que
-- deberian ser cero.
CREATE INDEX IF NOT EXISTS idx_referidos_premio_pendiente
  ON public.referidos (convertido_pro_at)
  WHERE convertido_pro AND premio_otorgado_at IS NULL;
