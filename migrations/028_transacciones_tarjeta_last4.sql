-- Últimos 4 dígitos de la tarjeta/cuenta origen de la transacción.
--
-- Contexto: hoy una transacción tiene `metodo_pago` (Crédito/Débito/Yape...) y
-- `banco`, pero no un identificador de la tarjeta concreta. Dos consumos del mismo
-- monto, comercio y día pagados con DOS tarjetas distintas del mismo banco eran
-- indistinguibles y el dedup los podía colapsar en una sola fila.
--
-- Se extrae de forma determinística en los parsers (services/parsers.js
-- extraerLast4 sobre el texto del correo bancario) y desde la visión de imágenes
-- (handlers/webhook.js, el modelo emite `tarjeta_last4`). NULL cuando la fuente no
-- expone la tarjeta (Yape/Plin son wallets, registro manual sin dato, etc.).
--
-- Usos:
--   1) Refina el dedup de ventana (services/transactions.js): un candidato solo
--      cuenta como duplicado si el last4 coincide o alguno de los dos es NULL.
--   2) Agrupa cuentas/tarjetas de la misma fuente en el dashboard (donut de
--      métodos de pago y lista de transacciones en app.neto.pe).
--
-- RLS: la tabla `transacciones` ya tiene RLS habilitado; una columna nueva hereda
-- las políticas existentes, no requiere policy adicional.
alter table transacciones add column if not exists tarjeta_last4 text;

-- Exactamente 4 dígitos o NULL. Idempotente (PG no soporta ADD CONSTRAINT IF NOT EXISTS).
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'transacciones_tarjeta_last4_chk'
  ) then
    alter table transacciones
      add constraint transacciones_tarjeta_last4_chk
      check (tarjeta_last4 is null or tarjeta_last4 ~ '^[0-9]{4}$');
  end if;
end $$;

-- Índice para agrupar/consultar por tarjeta dentro de un usuario. Parcial: solo
-- filas con tarjeta conocida (la mayoría de Yape/Plin/manual quedan NULL).
create index if not exists idx_transacciones_usuario_last4
  on transacciones (usuario_id, tarjeta_last4)
  where tarjeta_last4 is not null;
