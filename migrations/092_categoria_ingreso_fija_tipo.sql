-- Mover una fila a la categoría "Ingreso" (o "Ingresos") la vuelve ingreso. (24-oct-2026)
--
-- Caso de producción: un usuario Pro mandó las capturas de Yape que le reenvían sus pacientes
-- ("¡Yapeaste! S/120 Jaime Car*", él es el destinatario). Vision las leyó como gasto. Él pidió
-- "siempre pon Jaime Car* en Ingreso" por WhatsApp y además las movió a la categoría "Ingreso"
-- en la webapp. Las tres puertas escribieron solo `categoria`, así que quedaron cuatro filas
-- con "📁 Ingreso" y `tipo = 'gasto'`, y el dashboard (que suma por `tipo`) las restaba.
--
-- Va en la base y no en cada llamador porque son al menos seis puertas que escriben `categoria`
-- (guardarTransaccion con la regla del comercio, retroaplicarRegla, recategorizarTransaccion,
-- las dos ramas inline de corregir_categoria y el diálogo de edición de la webapp, que no deja
-- cambiar el tipo). Un arreglo por llamador deja abierta la que se olvide.
--
-- Tres límites, los tres a propósito (revisión adversarial del mismo día):
--   · Actúa cuando la categoría CAMBIA (o en el insert), no en cualquier UPDATE. Así una corrección
--     explícita del tipo ("eso era un gasto", o el PUT de la webapp que reescribe la categoría
--     igual) gana sobre el trigger. Con `update of tipo` el bot contestaba "marcado como gasto"
--     y la fila seguía ingreso.
--   · Nombre EXACTO ("Ingreso", "Ingresos"), no prefijo: "Ingreso de mercadería" es una categoría
--     de gasto razonable para una bodega.
--   · Solo en un sentido: sacar un ingreso de "Ingreso" no lo vuelve gasto.
--
-- Medido antes de aplicar: 0 filas con categoría Ingreso/Ingresos y tipo 'gasto' en prod (las 4
-- del caso se corrigieron a mano el mismo día), así que esto no reescribe historia de nadie.

create or replace function public.transacciones_categoria_ingreso_fija_tipo()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  -- "ingres0" (con cero) aparece tal cual en el chat del caso.
  if new.categoria is not null
     and lower(btrim(new.categoria)) ~ '^ingres[o0]s?$'
     and (tg_op = 'INSERT' or new.categoria is distinct from old.categoria) then
    new.tipo := 'ingreso';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_categoria_ingreso_fija_tipo on public.transacciones;
create trigger trg_categoria_ingreso_fija_tipo
  before insert or update of categoria on public.transacciones
  for each row execute function public.transacciones_categoria_ingreso_fija_tipo();
