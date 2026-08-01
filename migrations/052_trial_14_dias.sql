-- Trial de 14 días: el pago deja de ser a ciegas.
--
-- El baseline del 2026-07-31 midió que 5 de los últimos 6 pagos tienen
-- premium_desde = fecha de registro (compran la promesa, sin haber usado nada)
-- y que 4 de 10 pagadores churnearon. El límite de historial del free nunca fue
-- el problema: solo 9 usuarios lo topan y ninguno pagó. Así que el free-forever
-- se apaga y todo usuario estrena Pro completo por 14 días desde su PRIMER GASTO.
--
-- Decisión de modelado que hace esto barato: `plan` sigue teniendo dos valores
-- ('free' | 'premium') y durante el trial vale 'premium'. Así los ~40 sitios que
-- chequean `plan === 'premium'` entregan Pro al usuario en trial sin tocarse —
-- un gate olvidado le daría Free EN SILENCIO, que es el peor modo de falla.
-- Lo que cambia es qué significa 'free': deja de ser un plan gratuito para
-- siempre y pasa a ser el MURO (se puede escribir, no leer). El estado comercial
-- vive aparte, en trial_estado.

-- Cuándo arrancó el trial. No es created_at: el alta reordenada deja que alguien
-- tarde días en registrar su primer gasto, y un trial que corre sin que exista
-- data que mirar no puede producir un pago informado.
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS trial_inicio timestamptz;

-- Último día del trial (fecha Lima, inclusive). Deliberadamente SEPARADO de
-- premium_vence: checkPremiumExpiry filtra por premium_vence en sus tres queries
-- (= en3dias, = hoy, IS NOT NULL), así que dejándolo NULL durante el trial los
-- usuarios en prueba le son invisibles y no hay que tocar ese cron.
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS trial_vence date;

-- NULL = todavía no tuvo trial (y por lo tanto le corresponde uno).
--   activo     — corriendo ahora; plan='premium' y no cuenta como MRR.
--   vencido    — se acabó sin pagar; cayó al muro.
--   convertido — pagó, o fue pagador antes de que existiera el trial. Nunca
--                vuelve a tener uno: un ex-pagador que churnea no se gana una
--                prueba gratis.
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS trial_estado text
  CHECK (trial_estado IN ('activo', 'vencido', 'convertido'));

-- Índice parcial para el barrido horario de checkTrialExpiry: solo interesan los
-- que están corriendo, que siempre son un puñado frente a la tabla entera.
CREATE INDEX IF NOT EXISTS idx_usuarios_trial_activo
  ON usuarios (trial_vence)
  WHERE trial_estado = 'activo';


-- ─── Backfill. El ORDEN importa: el paso 1 protege a los pagadores del paso 2 ──

-- 1) Los Pro actuales quedan 'convertido'. Sin esto, el día que su suscripción
--    venza y checkPremiumExpiry los baje a free, su siguiente gasto les
--    arrancaría un trial de 14 días gratis.
UPDATE usuarios
   SET trial_estado = 'convertido'
 WHERE plan = 'premium'
   AND trial_estado IS NULL;

-- 2) Cortesía de 30 días (no 14) a los free que están vivos: tienen al menos una
--    transacción en los últimos 30 días. Son ~17 personas — los mejores usuarios
--    no pagadores que hay — y se les da ventana larga porque se la ganaron.
--
--    Se descartó el grandfathering: mantener "free legacy" obliga a arrastrar una
--    segunda clase de usuario en cada gate para siempre, y con 17 personas ese
--    costo supera la buena voluntad. Además, los que tienen 2+ meses de data son
--    justo quienes necesitan EXPERIMENTAR Pro para decidir; dejarlos en el free
--    actual es blindar el producto que ya falló 9 de 9 veces.
--
--    Los free DORMIDOS (con data pero sin actividad reciente) NO se tocan a
--    propósito: regalarles la cortesía ahora se la quema estando ausentes. Caen
--    en la regla general — su próximo gasto arranca 14 días —, lo que convierte
--    el muro en un "bienvenido de vuelta" en vez de una puerta cerrada. Es mejor
--    win-back que el 0% actual.
--
--    Los que nunca registraron nada tampoco necesitan caso especial: la regla
--    general los cubre igual.
UPDATE usuarios u
   SET trial_estado = 'activo',
       plan         = 'premium',
       trial_inicio = now(),
       trial_vence  = (now() AT TIME ZONE 'America/Lima')::date + 30
 WHERE u.trial_estado IS NULL
   AND (u.plan IS NULL OR u.plan <> 'premium')
   AND u.is_test_user = false
   AND EXISTS (
     SELECT 1 FROM transacciones t
      WHERE t.usuario_id = u.id
        AND t.fecha >= (now() AT TIME ZONE 'America/Lima')::date - 30
   );

-- 3) Todo lo demás queda trial_estado NULL = "todavía no tuvo trial". La
--    invariante que sostiene el modelo es que CUALQUIER usuario sin trial que
--    registre una transacción arranca sus 14 días (lib/trial.js), así que nadie
--    puede terminar en el muro sin haber tenido su prueba.
