-- Rediseño del programa de referidos a un modelo de DOS LADOS.
--
-- Antes (modelo viejo):
--   * referidos.activo = el referido registró >=3 transacciones (uso de la app).
--   * Premio al referrer = floor(activos / 3) meses de Pro. Disparo por polling
--     (gmail-scanner por cada correo bancario + webhook al recibir "hola neto ref:CODE").
--
-- Ahora (modelo nuevo, DOS LADOS):
--   * El referido se hace Pro PAGADO con 50% off su primer mes (S/5 en vez de S/10).
--   * Esa conversión pagada le da al referrer 1 mes de Pro gratis (cada conversión = 1 mes).
--   * Disparo por conversión Pro pagada dentro de activarPro (fuente única), NO por uso.
--
-- referidos tiene 0 filas en producción (verificado 2026-07-31: select count(*) = 0), así
-- que el rename NO arrastra datos y convertido_pro=false es el valor correcto para toda
-- fila futura. Sin backfill.

-- 1. Semántica del lado del referrer: activo -> convertido_pro.
--    "convertido_pro" = el referido se convirtió a Pro PAGADO (dispara el premio).
--    convertido_pro_at deja rastro de CUÁNDO convirtió (auditoría; la idempotencia real
--    la da el claim atómico false->true sobre esta misma columna en services/referrals.js).
alter table public.referidos rename column activo to convertido_pro;
alter table public.referidos add column if not exists convertido_pro_at timestamptz;
comment on column public.referidos.convertido_pro is
  'El referido se convirtió a Pro PAGADO (dispara 1 mes gratis al referrer). Antes se llamaba "activo" (>=3 tx). Rediseño dos-lados 2026-07-31.';
comment on column public.referidos.convertido_pro_at is
  'Timestamp de la conversión a Pro del referido. Auditoría; la idempotencia la da el claim false->true en referrals.js.';

-- 2. Descuento del lado del referido: 50% off su primer mes de Pro, con caducidad.
--    Se setea al vincular el referido (registrarReferido). Vencido = precio normal.
--    Solo aplica al plan mensual (el anual es lump sum, no hay "primer mes").
alter table public.usuarios add column if not exists referido_dscto_pct smallint;
alter table public.usuarios add column if not exists referido_dscto_vence date;
comment on column public.usuarios.referido_dscto_pct is
  'Descuento de referido pendiente (50 = 50%% off primer mes Pro mensual). NULL = sin descuento.';
comment on column public.usuarios.referido_dscto_vence is
  'Fecha (Lima, YYYY-MM-DD) hasta la que aplica referido_dscto_pct. Vencida = precio normal. Ventana: 7 días desde el registro.';

-- referidos_meses_otorgados (migración 036) se CONSERVA: sigue siendo el claim atómico
-- anti-doble-otorgamiento (CAS .eq sobre el valor leído) cuando varios referidos del mismo
-- referrer convierten a Pro casi a la vez. Sin él, dos conversiones concurrentes leerían el
-- mismo premium_vence y el last-write-wins otorgaría 1 mes en vez de 2.
