-- 032: CHECK constraints de rango en las tablas de dinero de Espacios.
--
-- Defensa en profundidad para el money-path de finanzas compartidas (CTO audit
-- 2026-07-20, hallazgo D3). La validacion vive en las API routes, pero un monto
-- negativo que se cuele invierte los balances del grupo (una deuda se convierte
-- en credito) y un split_percentage fuera de 0-100 distorsiona las fracciones.
-- Estas tablas se escriben solo con service-role, asi que la DB es el ultimo
-- backstop que queda.
--
-- Verificado antes de aplicar: 0 filas en violacion.

ALTER TABLE space_expenses
  DROP CONSTRAINT IF EXISTS space_expenses_amount_positive;
ALTER TABLE space_expenses
  ADD CONSTRAINT space_expenses_amount_positive CHECK (amount > 0);

ALTER TABLE space_settlements
  DROP CONSTRAINT IF EXISTS space_settlements_amount_positive;
ALTER TABLE space_settlements
  ADD CONSTRAINT space_settlements_amount_positive CHECK (amount > 0);

ALTER TABLE space_members
  DROP CONSTRAINT IF EXISTS space_members_split_percentage_range;
ALTER TABLE space_members
  ADD CONSTRAINT space_members_split_percentage_range
  CHECK (split_percentage IS NULL OR (split_percentage >= 0 AND split_percentage <= 100));
