-- 087 · Vaciar pg_stat_statements cada semana (28-sep-2026)
--
-- Supabase avisó el 26-sep que el proyecto se estaba quedando sin presupuesto de Disk IO.
-- La base pesa 31 MB y está entera en caché (1.812 lecturas de disco contra 364 M de hits),
-- así que no eran nuestras consultas. Era esto, medido sobre producción el 28-sep:
--   · 570 GB escritos en archivos temporales desde febrero (215 mil archivos) y +3,5 GB en las
--     10 h previas al arreglo: un archivo de ~4,5 MB cada ~47 s.
--   · pg_stat_statements con 4.906 de 5.000 entradas (2,6 MB de texto de consultas). Leerlo con
--     ORDER BY no entra en work_mem (4 MB) y se derrama a disco: mis propias lecturas volcaron
--     entre 378 y 552 bloques. Las herramientas de Supabase que lo leen cada minuto se esconden
--     con `set pg_stat_statements.track = none` (604 llamadas registradas), por eso no aparecen.
--   · Prueba: `pg_stat_statements_reset()` a las 15:49:24 UTC. En los 10 min siguientes, 0
--     archivos temporales nuevos (a la tasa previa, ~13).
--
-- El registro se vuelve a llenar solo (tardó de marzo a septiembre), así que el reset va
-- programado. Lunes 08:00 UTC = 03:00 Lima, la hora más muerta del bot. Lo que se pierde: el
-- historial de rendimiento por consulta más viejo que una semana. Si hace falta mirar una
-- consulta lenta, el dato de la semana en curso sigue ahí.
--
-- Idempotente: cron.schedule con nombre reemplaza el job si ya existe.

create extension if not exists pg_cron with schema pg_catalog;

grant usage on schema cron to postgres;

select cron.schedule(
  'reset-pg-stat-statements-semanal',
  '0 8 * * 1',
  $$select extensions.pg_stat_statements_reset()$$
);
