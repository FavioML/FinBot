-- 069 — unificar las dos grafías de una MISMA categoría (auditoría CTO 2026-08-10, hallazgo B30).
--
-- QUÉ PASÓ. La categoría de una regla por comercio PISA la que dedujo el clasificador
-- (`services/transactions.js`, una línea después de `resolverCategoriaPersistida`), y entraba
-- cruda. O sea que `reglas_comercio` era una tercera puerta que escribía
-- `transacciones.categoria` sin pasar por el invariante de B28. El código ya está arreglado;
-- esto limpia lo que la puerta alcanzó a escribir.
--
-- EL DAÑO, medido contra prod el 2026-08-12 antes de escribir esto. El usuario
-- `d049f587` tenía sus gastos de comida partidos exactamente en dos, y la línea del corte era
-- la regla:
--
--   5 filas en 'Alimentacion'  ← los comercios CON regla ('Berny', 'restaurante')
--   5 filas en 'Alimentación'  ← los comercios SIN regla ('almuerzo', 'broaster')
--
-- En su donut, sus reportes y su presupuesto eso son dos categorías distintas.
--
-- ALCANCE DELIBERADO: SOLO LOS ALIAS ORTOGRÁFICOS. `CATEGORIA_MAP` mezcla dos cosas muy
-- distintas, y esta migración toca una sola:
--
--   · alias  ('Alimentacion' → 'Alimentación')  = la misma palabra mal escrita. Sin pérdida.
--   · colapso con pérdida ('Viajes' → 'Otros', 'Auto' → 'Transporte') = conceptos distintos
--     que se funden. NO se tocan acá.
--
-- Las 31 reglas de colapso vivas son todas de UN usuario (Favio), que además tiene raíces
-- ACTIVAS llamadas 'Auto' y 'Viajes': resolverlas mandaría sus 40 filas de Viajes a 'Otros' y
-- sus 72 de Auto a 'Transporte', dejándole dos categorías vacías. Es peor para el único
-- afectado que dejarlo como está. Decisión de Favio con los números delante (12-ago-2026);
-- ver `memory/audits/2026-08-12_medicion_b31-b32_categorias.md`.
--
-- Y las 77 reglas no canónicas de 13 usuarios ('Freelance', 'Gastos Hormiga', 'Separación')
-- tampoco se tocan: son categorías libres legítimas, que es exactamente lo que B28 vino a
-- permitir. Normalizarlas las mandaría a 'Otros'.
--
-- QUÉ TABLAS. Se verificó columna por columna (`information_schema`) en vez de confiar en la
-- lista: hay SEIS tablas que referencian una categoría por nombre — `transacciones`,
-- `presupuestos`, `reglas_comercio`, `gastos_compartidos`, `space_expenses` y
-- `spending_alerts`, más las columnas `subcategoria`. Las tres últimas y todas las
-- `subcategoria` dieron CERO filas con estas grafías, así que no aparecen abajo.
--
-- LA RAÍZ DEL ÁRBOL SE RENOMBRA, y no es opcional: dos de los tres usuarios tienen una raíz
-- ACTIVA llamada 'Alimentacion' y NO tienen la canónica. Mover sólo las filas les dejaría los
-- gastos en una categoría que `/categorias` no lista y que el selector de presupuestos no
-- ofrece. El `not exists` protege del 23505 del índice único de la migración 067: hay un
-- usuario (`e4332f63`) con las DOS raíces activas, sin reglas ni filas mal escritas, y esta
-- migración tiene que dejarlo intacto en vez de reventar.
--
-- Recomprobar antes de aplicar, en vez de creerle a estos números:
--   select categoria, count(*), count(distinct usuario_id)
--   from reglas_comercio where categoria in ('Alimentacion','Educacion') group by 1;

begin;

-- 1. La raíz del árbol, sólo donde no exista ya la canónica del mismo usuario.
update public.categorias_usuario c
   set nombre = 'Alimentación'
 where c.padre_id is null and c.nombre = 'Alimentacion'
   and not exists (select 1 from public.categorias_usuario o
                    where o.usuario_id = c.usuario_id and o.padre_id is null and o.nombre = 'Alimentación');

update public.categorias_usuario c
   set nombre = 'Educación'
 where c.padre_id is null and c.nombre = 'Educacion'
   and not exists (select 1 from public.categorias_usuario o
                    where o.usuario_id = c.usuario_id and o.padre_id is null and o.nombre = 'Educación');

-- 2. Las reglas, que son la puerta que produjo todo esto.
update public.reglas_comercio set categoria = 'Alimentación' where categoria = 'Alimentacion';
update public.reglas_comercio set categoria = 'Educación'    where categoria = 'Educacion';

-- 3. Las filas que la puerta ya escribió.
update public.transacciones set categoria = 'Alimentación' where categoria = 'Alimentacion';
update public.transacciones set categoria = 'Educación'    where categoria = 'Educacion';

commit;

-- Verificación post-aplicación (debe dar 0 filas en las tres tablas):
--   select 'regla' t, count(*) from reglas_comercio where categoria in ('Alimentacion','Educacion')
--   union all select 'tx', count(*) from transacciones where categoria in ('Alimentacion','Educacion')
--   union all select 'raiz', count(*) from categorias_usuario
--     where padre_id is null and nombre in ('Alimentacion','Educacion');
-- La fila 'raiz' NO da 0, y está bien: quedan las DOS que el `not exists` saltea a propósito,
-- porque sus dueños ya tienen la canónica y renombrar reventaría contra el índice de la 067.
-- Una es la raíz INACTIVA de Favio (una categoría que él borró: reactivarla por la puerta de
-- atrás contradice la decisión de B26(b)) y la otra es la de `e4332f63`, que tiene las dos
-- activas y ninguna regla ni fila mal escrita — ese es el hallazgo de los casi-duplicados que
-- la migración 067 ya dejó anotado, y no es este.
