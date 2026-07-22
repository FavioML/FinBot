-- Ledger de meses de Pro ya otorgados por referidos.
-- Antes, services/referrals.js calculaba floor(activos/3) y sumaba esos meses a
-- premium_vence en CADA invocación, sin registrar lo ya pagado. Como la base era el
-- propio premium_vence (una fecha futura tras el primer otorgamiento), el guard
-- `venceStr !== venceActual` nunca frenaba nada: 5 llamadas con los mismos 3 referidos
-- activos daban 5 meses. gmail-scanner.js la invoca por cada correo bancario procesado
-- de un referido, así que la inflación era proporcional al uso del referido.
-- Con esta columna el otorgamiento es un delta (meses ganados menos meses ya dados) y
-- el UPDATE la usa como claim atómico (.eq sobre el valor leído) para que dos
-- ejecuciones concurrentes no otorguen dos veces.
alter table usuarios add column if not exists referidos_meses_otorgados smallint not null default 0;

-- Sin backfill: la tabla referidos tiene 0 filas, así que ningún usuario recibió Pro
-- por esta vía y 0 es el valor correcto para todos.
