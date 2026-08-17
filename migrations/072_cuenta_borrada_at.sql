-- 072 — Marca de baja declarada: el usuario pidió borrar TODOS sus datos.
--
-- Por qué existe (medido el 2026-08-17): dos de los cinco Pro pagados usaron el flujo
-- "Quiero eliminar mi cuenta" → borrado total, y siguen contando como ingreso recurrente.
-- Uno pagó el plan ANUAL y su `premium_vence` es 2027-07-01, así que iba a inflar el MRR
-- durante catorce meses más. El wipe borra transacciones, categorías y presupuestos, pero
-- NUNCA tocó `plan`, `premium_desde`, `premium_vence` ni `estado_pago`.
--
-- Es la ÚNICA baja declarada que existe en el producto. Todo lo demás (inactividad,
-- vencimiento) es una inferencia; esto lo pidió la persona con todas las letras, así que
-- es la señal más fuerte de churn que hay y no la estaba mirando nadie.
--
-- NO se baja el plan a 'free' a propósito: la persona pagó y si vuelve tiene derecho a su
-- Pro hasta que venza. Esto es una marca para las MÉTRICAS, no un cambio de entitlement.
-- `esProPagado()` y los gates siguen viendo exactamente lo mismo que antes.

ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS cuenta_borrada_at timestamptz;

COMMENT ON COLUMN usuarios.cuenta_borrada_at IS
  'HECHO: cuándo el usuario pidió borrar todos sus datos (wipe total por WhatsApp). NO se '
  'limpia nunca; "¿está de baja hoy?" se deriva comparándolo contra un pago posterior. Hoy '
  'sólo se ESCRIBE (handlers/onboarding.js): el consumidor de métricas está pendiente, ver '
  'el comentario de completarAlta. NO toca el entitlement.';

-- Backfill de los casos históricos.
--
-- LO QUE ESTA SENTENCIA *NO* HACE, y el comentario anterior afirmaba que sí: no fija el
-- sujeto por id. No hay ningún id acá. El sujeto es quien matchee el `ILIKE` sobre
-- `conversaciones`, y la única condición que de verdad acota es el `NOT EXISTS`. Se corrió
-- con un SELECT del mismo predicado delante y devolvió exactamente los dos casos medidos
-- (c5ee415f el 03-ago, 500f5643 el 09-ago); hacerlo así, y no confiar en el texto, es el
-- procedimiento.
--
-- `MAX(borrado_at)` NO es "la fecha del wipe": el trigger de la 055 escribe en cada borrado
-- duro, incluido un `deshacer_ultimo` posterior. Por eso se acota a la ventana del wipe,
-- tomando el borrado MASIVO (el que se lleva varias filas de una) más reciente. Sin esto,
-- alguien que borró su cuenta, volvió y después deshizo un gasto quedaba fechado el día del
-- deshacer, con una fecha falsa y una marca que ya no le correspondía.
--
-- NO es idempotente por sí sola frente a un retorno: el `IS NULL` protege mientras la marca
-- siga puesta. Se deja igual a propósito porque la marca ya no se limpia nunca (es un HECHO,
-- ver 072b), así que re-correrla no puede volver a marcar a nadie.
--
-- HUECO CONOCIDO, no tapado: el `HAVING count(*) > 1` define wipe como "varias filas en el
-- mismo instante", así que a quien se dio de baja con UNA sola transacción no lo alcanza.
-- Los otros dos predicados lo identificarían pero la subquery no produce su fila. Hoy no
-- muerde (los dos casos reales tienen 42 y 131 filas) y se deja escrito en vez de ampliar
-- el predicado a ciegas.
UPDATE usuarios u SET cuenta_borrada_at = b.momento
FROM (
  SELECT usuario_id, MAX(borrado_at) AS momento
  FROM (
    -- Un wipe borra varias filas en el MISMO instante; un deshacer, una sola.
    SELECT usuario_id, borrado_at
    FROM borrados_auditoria
    WHERE tabla = 'transacciones'
    GROUP BY usuario_id, borrado_at
    HAVING count(*) > 1
  ) masivos
  GROUP BY usuario_id
) b
WHERE u.id = b.usuario_id
  AND u.cuenta_borrada_at IS NULL
  AND EXISTS (
    SELECT 1 FROM conversaciones c
    WHERE c.usuario_id = u.id AND c.rol = 'neto'
      AND (c.mensaje ILIKE '%Cuenta limpia%' OR c.mensaje ILIKE '%Datos eliminados%')
  )
  AND NOT EXISTS (SELECT 1 FROM transacciones t WHERE t.usuario_id = u.id);
