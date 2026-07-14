-- Modo Manos Libres (opt-in): cuando esta activo, Neto envia un resumen diario de
-- gastos a las 9pm Lima sin que el usuario haga nada. Opt-in a proposito: el resto
-- de mensajes proactivos siguen la politica anti-fatiga (UPDATE-08), este NO se
-- prende solo. Es una funcion Pro (getUserPlanConfig().resumenDiario).
alter table usuarios add column if not exists manos_libres boolean not null default false;
