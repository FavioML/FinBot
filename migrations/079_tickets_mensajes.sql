-- El HILO de una conversacion de soporte (2026-08-28).
--
-- `tickets_soporte` guarda UN `mensaje_usuario` y UN `mensaje_admin`, y cada mensaje nuevo
-- PISA al anterior (`handlers/message-processor.js` y `lib/support-tickets.js` hacen UPDATE,
-- no INSERT). Para un ticket de un solo turno alcanzaba; para conversar no: el panel muestra
-- la ultima linea de cada lado y el resto no existio nunca. Nadie puede leer lo que se dijo
-- dos mensajes atras — ni el admin al retomar, ni el que audite despues.
--
-- **Por que una tabla nueva y no `conversaciones`, que ya es un hilo.** Se evaluo y se
-- descarto midiendo el consumidor, no por gusto: `obtenerHistorial` (helpers/db-helpers.js:37)
-- lee los ultimos 6 mensajes de `conversaciones` SIN filtrar por `rol` y se los pasa al LLM
-- como contexto. Meter ahi la conversacion de soporte le inyecta al bot las palabras del admin
-- como si fueran suyas. Y es justo la razon por la que hoy el modo soporte devuelve ANTES de
-- `guardarMensaje`: esos mensajes se dejan fuera a proposito.
--
-- **Sin FK a `usuarios`, a proposito.** El dueño del mensaje es el TICKET. Con
-- `on delete cascade` sobre `tickets_soporte`, el borrado de cuenta ya lo cubre:
-- `borrar_cuenta_total` (migracion 073d) hace `DELETE FROM tickets_soporte WHERE usuario_id =
-- ...`, y la cascada se lleva el hilo. Agregarle un `usuario_id` propio crearia una segunda
-- fuente de verdad sobre de quien es la conversacion, y una FK mas que el inventario de
-- `qa-borrado-estructura` tendria que clasificar para no decir nada nuevo.
--
-- **RLS activo y sin policies, como el resto de la superficie de admin** (ver migracion 033):
-- deny-all para `authenticated`, y el panel entra con service_role, que la bypassa. Nadie
-- consulta esta tabla desde el navegador del usuario.

create table if not exists public.tickets_mensajes (
  id         uuid primary key default gen_random_uuid(),
  ticket_id  uuid not null references public.tickets_soporte(id) on delete cascade,
  -- Quien habla. El CHECK es el que impide que un tercer rol entre sin que nadie decida como
  -- se pinta: el panel ramifica por estos dos valores.
  rol        text not null check (rol in ('usuario', 'admin')),
  mensaje    text not null,
  created_at timestamptz not null default now()
);

-- El unico acceso que existe: el hilo de UN ticket, en orden. Sin este indice el panel hace
-- seq scan por ticket abierto.
create index if not exists idx_tickets_mensajes_ticket
  on public.tickets_mensajes (ticket_id, created_at);

alter table public.tickets_mensajes enable row level security;

comment on table public.tickets_mensajes is
  'Hilo de una conversacion de soporte. Append-only desde el codigo. Se borra por cascada de tickets_soporte.';
