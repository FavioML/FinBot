-- Migration 034: congelar la division de cada gasto compartido.
--
-- Hasta ahora la division de un gasto se recalculaba EN VIVO desde
-- shared_spaces.split_rules y space_members.split_percentage. Consecuencia:
-- cambiar una regla hoy reescribia lo que cada quien debia en gastos de hace
-- meses (dinero real moviendose entre personas en silencio), y los tres lugares
-- que hacian ese calculo no coincidian entre si.
--
-- `split_snapshot` guarda la division con la que el gasto se registro:
--   { "v": 1,
--     "source": "rule" | "default",
--     "rule_id": "<id de la regla, solo si source = rule>",
--     "shares": [ { "user_id": "...", "cents": 7000 }, ... ] }
--
-- Centavos ENTEROS, no fracciones: el invariante que hay que garantizar es que
-- la suma de las partes de el total exacto, y eso solo se expresa exacto en
-- enteros. Con fracciones, S/100 en tres partes da 33.33 x 3 = 99.99 y el
-- centavo perdido reaparece como dinero fantasma que ningun settlement
-- reconcilia.
--
-- Esta migracion deja la columna NULLABLE a proposito: el codigo que la escribe
-- todavia no esta desplegado. El NOT NULL, el CHECK de conservacion y el drop de
-- split_type van en la 035, despues del deploy.

ALTER TABLE space_expenses ADD COLUMN IF NOT EXISTS split_snapshot JSONB;

COMMENT ON COLUMN space_expenses.split_snapshot IS
  'Division congelada al registrar el gasto (v1: source, rule_id, shares[].cents). Las reglas aplican solo a gastos futuros; esta columna es la autoridad de los balances.';

-- Backfill de los gastos que ya existian (al momento de aplicar: 1 fila).
-- El valor se calculo con el motor real (services/spaces-split.js -> buildSplitSnapshot)
-- sobre los miembros y reglas vigentes, que es exactamente la division que el
-- dashboard ya le venia mostrando al usuario. No se re-implementa la matematica
-- en SQL a proposito: seria un cuarto motor de division.
UPDATE space_expenses
SET split_snapshot = '{"v":1,"source":"rule","rule_id":"rule-1775247900225","shares":[{"user_id":"5e3e05c8-c84b-4ea8-8093-bdb655b2f746","cents":10000}]}'::jsonb
WHERE id = '542f1652-e343-4f8f-856c-2c5ab1b79a7a'
  AND split_snapshot IS NULL;

-- Guarda de forma. La conservacion (suma de shares = amount) se agrega en la 035,
-- cuando ya no puedan entrar filas sin snapshot.
ALTER TABLE space_expenses
  ADD CONSTRAINT space_expenses_split_snapshot_shape
  CHECK (
    split_snapshot IS NULL
    OR jsonb_typeof(split_snapshot -> 'shares') = 'array'
  );
