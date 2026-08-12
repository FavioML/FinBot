-- D8 — la validación de montos de deudas vivía SOLO en el código.
--
-- Las tres tablas de deudas tienen una policy `FOR ALL` para `public` cuyo `USING` scopea al
-- dueño. Postgres reusa ese `USING` como `WITH CHECK` cuando no hay uno explícito, así que
-- nadie puede escribir sobre filas ajenas — el hallazgo NO es de aislamiento. Lo que sí puede
-- hacer el dueño es escribir con SU anon key (que viaja en el browser) directo contra
-- PostgREST, salteando `validarMonto` y `lib/money.ts`: un `monto_original` negativo, un cero,
-- o un número que rompe los agregados del dashboard.
--
-- Se cierra en la DB y no apretando la policy, por dos razones:
--
--  1. La policy no puede expresar "el monto es válido": es una condición sobre la FILA, no
--     sobre el dueño. Apretarla rompería las lecturas legítimas de la webapp.
--  2. Un CHECK cubre además al service-role, que ignora RLS por completo. O sea que también
--     protege del próximo endpoint del backend que se olvide de validar — que es exactamente
--     la clase de bug que la auditoría del 10-ago encontró cuatro veces en rutas de edición
--     (ver `lib/money.ts` y el barrido de `qa-money-edge`).
--
-- Medido contra producción ANTES de aplicar (11-ago-2026): 62 deudas y 44 abonos, CERO filas
-- que violen cualquiera de los tres checks. No hay nada que limpiar y la migración no puede
-- fallar por datos existentes.
--
-- Los topes son los mismos que `validarMonto` (lib/validators.js): (0, 999999.99].
-- `monto_pendiente` admite 0 a propósito: es una deuda saldada, no un monto inválido.
-- Los NULL pasan el CHECK por definición de SQL; la columna que no puede ser nula ya lo
-- declara con NOT NULL, y no se toca acá para no cambiar la forma de la tabla en la misma
-- migración que agrega los rangos.

ALTER TABLE deudas
  DROP CONSTRAINT IF EXISTS deudas_monto_original_rango,
  ADD CONSTRAINT deudas_monto_original_rango
    CHECK (monto_original IS NULL OR (monto_original > 0 AND monto_original <= 999999.99));

ALTER TABLE deudas
  DROP CONSTRAINT IF EXISTS deudas_monto_pendiente_rango,
  ADD CONSTRAINT deudas_monto_pendiente_rango
    CHECK (monto_pendiente IS NULL OR (monto_pendiente >= 0 AND monto_pendiente <= 999999.99));

ALTER TABLE deuda_abonos
  DROP CONSTRAINT IF EXISTS deuda_abonos_monto_rango,
  ADD CONSTRAINT deuda_abonos_monto_rango
    CHECK (monto IS NULL OR (monto > 0 AND monto <= 999999.99));
