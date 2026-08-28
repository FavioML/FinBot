-- El id del mensaje EN META para el turno del admin (2026-08-28).
--
-- Hasta hoy `responderTicket` llamaba a `enviarWhatsapp` SIN `tipo`, y `registrarEntrega`
-- arranca con `if (!tipo) return`. O sea que la respuesta del admin no dejaba fila en
-- `notification_deliveries` y el callback de status de Meta no matcheaba nada: su desenlace
-- real no se sabia nunca. El panel decia "Respuesta enviada", y esa frase solo significaba
-- que Meta acepto el POST.
--
-- Cuanto pesa la diferencia, medido sobre 30 dias de esa tabla: **556 `sent`, 67 entregados,
-- 459 fallidos por callback** — 452 de ellos con codigo 131047, la ventana de 24h. Es el
-- hallazgo B23 otra vez, en la pantalla desde la que se le contesta a una persona.
--
-- El docblock de `registrarEntrega` declara una excepcion —"las respuestas interactivas del
-- webhook no se registran, siempre estan dentro de la ventana"— y NO cubre este caso: aca el
-- admin puede contestar dias despues, que es justo cuando la ventana ya cerro.
--
-- Nullable a proposito, y son dos casos distintos que se ven igual en la columna:
--   · el turno del USUARIO no tiene wamid nuestro (no es un mensaje que hayamos mandado);
--   · un envio que Meta rechazo sincronicamente tampoco llega a tener uno.
-- El panel los pinta como "sin dato de entrega", que es la verdad en los dos.

alter table public.tickets_mensajes add column if not exists wamid text;

-- Parcial: solo los turnos del admin lo llevan, y es por donde entra el join con el ledger.
create index if not exists idx_tickets_mensajes_wamid
  on public.tickets_mensajes (wamid) where wamid is not null;
