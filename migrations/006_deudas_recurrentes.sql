-- 006_deudas_recurrentes.sql
-- Soporte para "compromisos recurrentes": una deuda que se repite cada periodo
-- (mensual / quincenal / semanal / anual). Ej: "Juan me paga S/15 todos los meses".
--
-- Modelo:
--   - es_recurrente   : marca la deuda como recurrente
--   - frecuencia      : cadencia del pago esperado
--   - fecha_fin       : fecha límite del compromiso (NULL = indefinido)
--   - proxima_fecha   : siguiente fecha esperada de pago/cobro
--   - periodos_pagados: cuántos periodos ya completó el deudor (informativo)
--
-- Comportamiento al recibir un pago completo (monto_pendiente llega a 0):
--   - Si es_recurrente=false  → deuda pasa a 'pagada' (igual que antes).
--   - Si es_recurrente=true   → se calcula proxima_fecha, se reinicia
--                               monto_pendiente = monto_original, y la deuda
--                               sigue 'activa'. Si proxima_fecha > fecha_fin
--                               entonces sí se marca 'pagada' (terminada).
-- La lógica vive en /api/debts (PUT action=abonar) y en services/debts.js.

ALTER TABLE deudas
  ADD COLUMN IF NOT EXISTS es_recurrente    boolean      NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS frecuencia       text,
  ADD COLUMN IF NOT EXISTS fecha_fin        date,
  ADD COLUMN IF NOT EXISTS proxima_fecha    date,
  ADD COLUMN IF NOT EXISTS periodos_pagados integer      NOT NULL DEFAULT 0;

-- Validación de frecuencia (solo si la deuda es recurrente)
ALTER TABLE deudas DROP CONSTRAINT IF EXISTS deudas_frecuencia_check;
ALTER TABLE deudas
  ADD CONSTRAINT deudas_frecuencia_check
  CHECK (
    es_recurrente = false
    OR frecuencia IN ('semanal', 'quincenal', 'mensual', 'anual')
  );

-- Índice para listar próximos compromisos recurrentes pendientes
CREATE INDEX IF NOT EXISTS idx_deudas_recurrentes_proxima
  ON deudas (usuario_id, proxima_fecha)
  WHERE es_recurrente = true AND estado = 'activa';
