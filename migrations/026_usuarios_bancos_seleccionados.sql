-- Bancos que el usuario (Pro) eligió leer al conectar su Gmail. Guarda los IDs del
-- catálogo de gmail.js (BANCOS_CATALOGO), ej: {'bcp','yape'}. El scan de correos
-- filtra REMITENTES_BANCARIOS por estos IDs en vez de usar el OR completo.
-- NULL o {} = leer todos los bancos (backward-compatible con usuarios que ya tenían
-- Gmail conectado antes de este cambio, y con "todos" en el selector).
-- Es función Pro: la selección solo se pide dentro del flujo de /conectar (gateado a Pro),
-- nunca en el onboarding Free.
alter table usuarios add column if not exists bancos_seleccionados text[];
