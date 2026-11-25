-- 094 — un movimiento siempre tiene categoría. NULL o vacío se guarda como "Otros". (25-nov-2026)
--
-- Caso de producción: un pagador borró sus raíces Alimentación, Transporte y Otros desde
-- "Gestionar categorías" para rehacerlas. El borrado de una raíz (cascadeRootDelete en la
-- webapp) dejaba sus movimientos en "Por revisar" con `categoria = null`, y la webapp entera
-- da por hecho que `categoria` es un string: `getCategoriaEmoji(null)` hace
-- `null.toLowerCase()` en el QuickAddButton del shell, que vive en todas las pantallas del
-- dashboard. Resultado: cada pantalla caía a "Algo se rompió de nuestro lado". Su ticket
-- dice "dejó de funcionar". Reproducido con el usuario QA por `qa-e2e/qa-raiz-borrada-render.mjs`.
--
-- Medido antes de aplicar: 39 filas con `categoria IS NULL` en 5619, TODAS de ese usuario (la
-- única forma de fabricarlas era ese borrado), y 0 con categoría vacía.
--
-- Por qué en la base y no solo en el cascade (que también se arregló, para no depender de
-- esto): hay más escritores que podían mandar null (el POST/PUT de la webapp pasa
-- `body.categoria` tal cual, el PATCH en lote convierte '' en null) y uno solo alcanza para
-- tumbar la app de esa persona. Es el mismo argumento de la 092.
--
-- Por qué un trigger que CORRIGE y no solo `NOT NULL`: un NOT NULL a secas convertiría un
-- escritor descuidado en un gasto que no se guarda (el insert falla), y en WhatsApp eso es
-- plata perdida en silencio. Con el trigger delante, el NOT NULL no puede fallar nunca: queda
-- como declaración del invariante en el esquema.
--
-- Por qué "Otros": es la forma que ya escribe la importación (`categoria || 'Otros'`) y es
-- canónica (está en la lista hardcodeada de la webapp y del backend), así que existe aunque
-- el usuario haya borrado su raíz "Otros". El centinela de subcategoría que enciende
-- "Por revisar" no se toca: esas filas siguen en "Por revisar".

create or replace function public.transacciones_categoria_nunca_nula()
returns trigger
language plpgsql
set search_path to ''
as $$
begin
  if new.categoria is null or btrim(new.categoria) = '' then
    new.categoria := 'Otros';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_categoria_nunca_nula on public.transacciones;
create trigger trg_categoria_nunca_nula
  before insert or update of categoria on public.transacciones
  for each row execute function public.transacciones_categoria_nunca_nula();

-- Las 39 del caso. Pasa por el trigger de la 092 (no matchea "Ingreso") y por el de la 070
-- (subcategoria 'Sin_categoria' queda igual).
update public.transacciones set categoria = 'Otros'
 where categoria is null or btrim(categoria) = '';

alter table public.transacciones alter column categoria set not null;

-- Verificación post-aplicación:
--   select count(*) from transacciones where categoria is null;            -- 0
--   select is_nullable from information_schema.columns
--    where table_name = 'transacciones' and column_name = 'categoria';     -- NO
--   select tgname from pg_trigger where tgrelid = 'public.transacciones'::regclass
--    and not tgisinternal;   -- incluye trg_categoria_nunca_nula
