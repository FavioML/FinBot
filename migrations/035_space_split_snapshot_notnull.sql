-- Migration 035: cerrar el modelo de division congelada.
--
-- Va DESPUES del deploy de la 034 + el codigo que escribe `split_snapshot`, no
-- antes: entre medio todavia podian entrar filas sin snapshot, y `split_type`
-- seguia siendo seleccionado por el backend desplegado.
--
-- Tres cosas:
--   1. La DB rechaza un snapshot que no conserve el total, venga del runtime que
--      venga. Es la unica defensa que no depende de que la app se acuerde.
--   2. Un gasto sin division es un gasto que nadie debe: NOT NULL para que falle
--      ruidosamente en vez de guardar plata mal repartida.
--   3. Se van `split_type` y `default_split_type`: constantes disfrazadas de
--      configuracion. Nada les escribio nunca otro valor que 'equal', y la unica
--      rama viva que las leia (services/shared-spaces.js) dividia
--      split_percentage/100 SIN normalizar -- con tres miembros al 50 debitaba el
--      150% del gasto.

-- 1. Conservacion de dinero, verificable por la DB.
-- El subquery vive dentro de una funcion IMMUTABLE porque un CHECK no admite
-- subqueries directamente. No referencia otras tablas, asi que no hay riesgo de
-- que quede desactualizado por un cambio en otro lado.
CREATE OR REPLACE FUNCTION space_shares_conserve(snapshot jsonb, amount numeric)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT snapshot IS NULL
      OR (
        jsonb_typeof(snapshot -> 'shares') = 'array'
        AND COALESCE((
          SELECT sum((s ->> 'cents')::bigint)
          FROM jsonb_array_elements(snapshot -> 'shares') s
        ), 0) = round(amount * 100)::bigint
      );
$$;

COMMENT ON FUNCTION space_shares_conserve(jsonb, numeric) IS
  'La suma de las partes congeladas de un gasto compartido tiene que dar el monto exacto en centavos. Si no, hay dinero fantasma que ningun settlement reconcilia.';

ALTER TABLE space_expenses
  ADD CONSTRAINT space_expenses_split_snapshot_conserva
  CHECK (space_shares_conserve(split_snapshot, amount));

-- 2. Todo gasto lleva su division.
ALTER TABLE space_expenses ALTER COLUMN split_snapshot SET NOT NULL;

-- 3. Fuera las columnas muertas.
ALTER TABLE space_expenses DROP COLUMN IF EXISTS split_type;
ALTER TABLE shared_spaces DROP COLUMN IF EXISTS default_split_type;
