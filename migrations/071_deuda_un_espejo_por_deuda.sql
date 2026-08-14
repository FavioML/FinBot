-- 071 — Una deuda compartida admite UN solo espejo.
--
-- S′10, la mitad estructural. `POST /api/debts/join` chequeaba "ya confirmada" filtrando
-- por `usuario_id`, o sea que solo impedía que la MISMA persona confirmara dos veces. Con
-- una deuda "me deben" —que por definición debe UNA contraparte— entraban N confirmantes,
-- y cada uno se llevaba una fila espejo con `deuda_vinculada_id`. Eso no es cosmético:
-- `PUT /api/debts` propaga desde el espejo hacia la deuda del ACREEDOR, así que cualquiera
-- de esos espejos podía marcarla pagada. Reproducido contra prod el 14-ago-2026 con
-- `qa-e2e/qa-invite-codes.mjs` (check `deuda_segundo_confirmante`).
--
-- El chequeo en la ruta se arregló, pero un `if` no puede sostener el invariante: dos
-- personas abriendo el mismo link a la vez pasan las dos por el SELECT antes de que
-- cualquiera inserte. El índice es lo que lo hace imposible; la ruta traduce el 23505 a
-- un 409.
--
-- PARCIAL (`where ... is not null`) porque el null es el caso normal: son las deudas que
-- no vienen de una invitación, y son casi todas. Un índice único a secas las colapsaría a
-- una sola fila en toda la tabla.
--
-- Medido ANTES de aplicarlo: cero deudas comparten `deuda_vinculada_id` (62 filas totales,
-- 1 espejo en toda la historia), así que no rechaza ningún dato existente. Y hay UN solo
-- sitio en todo el repo que escribe un valor no nulo en esa columna
-- (`webapp/src/app/api/debts/join/route.ts`), así que no hay otro flujo que esto rompa.
create unique index if not exists deudas_un_espejo_por_deuda
  on public.deudas (deuda_vinculada_id)
  where deuda_vinculada_id is not null;
