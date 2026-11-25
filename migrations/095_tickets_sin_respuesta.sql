-- 095: un ticket que nadie contestó ya no desaparece cuando la persona sale del modo soporte.
--
-- `cerrarSesion` ponía `estado = 'cerrado'` viniera de donde viniera, y `/tickets`, la cola y el
-- panel leen sólo los estados abiertos. El bot le sugiere a la persona escribir `/salir`, así que
-- el camino normal de un ticket era salir de toda cola sin una respuesta: 0050aef0 escribió el
-- 30-oct y mandó /salir 13 segundos después; e6a8c313, igual, el 06-nov.
--
-- `sin_respuesta` es "habló la persona, nadie contestó, y la sesión ya terminó". NO es un estado
-- activo (lib/support-tickets.js: SESSION_ACTIVE_STATES), así que sus mensajes vuelven al bot.
-- SÍ está en `/tickets`, en `/responder <número>`, en el panel y en el aviso diario de las 9am.
--
-- Orden de despliegue: ESTA migración va antes del código. El código nuevo escribe
-- 'sin_respuesta'; contra el CHECK viejo ese UPDATE se rechaza y `/salir` contestaría "no pude
-- cerrar el modo soporte" dejando la sesión viva. El código viejo nunca escribe el estado nuevo,
-- así que aplicarla primero no rompe nada.

alter table public.tickets_soporte drop constraint if exists tickets_soporte_estado_check;
alter table public.tickets_soporte add constraint tickets_soporte_estado_check
  check (estado = any (array['esperando_mensaje', 'pendiente', 'respondido', 'sin_respuesta', 'cerrado']));

-- Backfill: sólo los tickets que NUNCA tuvieron una respuesta del admin. Los que tuvieron una y
-- terminan con un mensaje de la persona pueden terminar en un "gracias": esos los decide el
-- admin, no esta migración. `updated_at` no se toca: el aviso diario muestra desde cuándo esperan.
--
-- El criterio no distingue "salió la persona" de "lo descartó el admin sin contestar", así que se
-- midió antes de aplicar (25-nov-2026): de 6 tickets en la tabla, lo cumplen 2 (0050aef0 del
-- 30-oct y e6a8c313 del 06-nov), y los dos se cerraron por /salir segundos después de escribir,
-- no por un /cerrar. El nombre del CHECK también se verificó en `pg_constraint` (es
-- `tickets_soporte_estado_check`), así que el `drop ... if exists` no es un no-op.
update public.tickets_soporte t
   set estado = 'sin_respuesta'
 where t.estado = 'cerrado'
   and exists (select 1 from public.tickets_mensajes m where m.ticket_id = t.id and m.rol = 'usuario')
   and not exists (select 1 from public.tickets_mensajes m where m.ticket_id = t.id and m.rol = 'admin');
