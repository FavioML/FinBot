-- Saneo de los estados que la 052 dejó inconsistentes, y de los que iba a dejar.
--
-- La 052 escribió la regla correcta ("un ex-pagador que churnea no se gana una prueba
-- gratis") pero su paso 1 solo selló como 'convertido' a quien estaba `plan='premium'`
-- EN ESE MOMENTO. Los ex-pagadores que ya habían churneado antes de la migración estaban
-- en 'free' con trial_estado NULL, así que:
--
--   · A los que tenían actividad reciente los agarró el paso 2 y les dio la cortesía de
--     30 días. Uno de ellos duró 78 minutos: checkPremiumExpiry lo barrió porque su
--     `premium_vence` de julio seguía ahí, le bajó el plan a 'free' y le mandó "tu plan
--     NETO Pro venció, ahora estás en el plan Free" — un plan que ya no existe. Quedó con
--     plan='free' y trial_estado='activo' a la vez, o sea con el banner de prueba y el
--     paywall en la misma pantalla.
--   · A los dormidos no los agarró nadie, y su próximo gasto les habría arrancado un
--     trial de 14 días que el mismo cron habría matado igual.
--
-- El código ya cerró las dos puntas (lib/trial.js limpia premium_vence al arrancar el
-- trial; checkPremiumExpiry excluye trial_estado='activo'). Esto arregla las filas.

-- 1) Sellar a los ex-pagadores que el paso 1 de la 052 no alcanzó. Tener premium_desde o
--    premium_vence es la huella de haber pagado alguna vez, y ese es el criterio: no vuelven
--    a tener trial, exactamente como dice la 052.
UPDATE usuarios
   SET trial_estado = 'convertido'
 WHERE trial_estado IS NULL
   AND (premium_desde IS NOT NULL OR premium_vence IS NOT NULL)
   AND (plan IS NULL OR plan <> 'premium');

-- 2) Devolverle sus 30 días al usuario cuya cortesía murió por el bug. Decisión de Favio:
--    se le prometió algo y se le quitó por un error nuestro, y es el ex-pagador con más
--    data de la base (87 transacciones) — el mejor candidato a win-back que hay. Se rompe
--    la regla del paso 1 a sabiendas y por una sola fila: esa regla existe contra el
--    farmeo, no para castigar a alguien que quedó en el medio de un bug.
--
--    `premium_vence = NULL` es la parte que impide que el cron vuelva a matarlo.
UPDATE usuarios
   SET plan          = 'premium',
       premium_vence = NULL,
       trial_estado  = 'activo'
 WHERE plan = 'free'
   AND trial_estado = 'activo'
   AND trial_vence >= (now() AT TIME ZONE 'America/Lima')::date;

-- 3) Red por si quedó alguna fila con el trial corriendo y un premium_vence viejo colgando:
--    con la 052 no debería, pero es la condición exacta que produjo el incidente y limpiarla
--    cuesta un UPDATE.
UPDATE usuarios
   SET premium_vence = NULL
 WHERE trial_estado = 'activo'
   AND premium_vence IS NOT NULL
   AND premium_vence < (now() AT TIME ZONE 'America/Lima')::date;
