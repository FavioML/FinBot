-- Retencion de `notificaciones` (2026-08-27): la tabla no se podaba NUNCA.
--
-- Encontrado midiendo el item 2 del backlog de confiabilidad: la fila viva mas vieja era del
-- 2026-04-03 (146 dias) y seguia ahi. Un usuario acumulaba **786 filas** y otro 364. Eso no es
-- un problema de espacio (1848 filas en total): es que `total` no tiene techo, o sea que la
-- pregunta "¿la campana es ruidosa?" se vuelve incontestable — dentro de un año el numero lo
-- domina 2026 y no el mes que se quiera mirar. Y de paso, un aviso de abril que dice "tu deuda
-- vence en 7 dias" es ruido por definicion.
--
-- **Dos clausulas, porque miden cosas distintas.** Medido antes de elegir:
--
--   regla                | borra hoy | sin leer | usuarios tocados
--   ---------------------|-----------|----------|------------------
--   edad > 90 dias       |       352 |      104 | 7 (quedan en cero)
--   tope 100 por usuario |       950 |      263 | **2**
--   edad > 180 dias      |     **0** |        0 | 0
--
-- La edad limpia lo rancio de todos pero NO acota a los pesados: aun con el cap diario del
-- resumen de Gmail (commit anterior), el mayor sigue generando ~79 avisos al mes, o sea ~237
-- filas en regimen con corte de 90 dias. El tope acota a los dos que tienen el problema y no
-- toca a los otros 75. Ninguna de las dos sola alcanza. Un corte de 180 dias habria sido un
-- no-op el dia que se escribio, que es la forma mas facil de creer que algo quedo resuelto.
--
-- El tope se aplica DESPUES de la edad, sobre lo que sobrevivio: al reves el tope contaria
-- filas que la edad iba a borrar igual y dejaria menos de las declaradas.
--
-- **Los dos `raise` no son ceremonia.** Un `p_dias` nulo o cero convierte esto en un DELETE de
-- la tabla entera, y el modo de falla de un borrado con el filtro caido es que no falla: pasa
-- en silencio y se descubre cuando alguien pregunta por sus avisos. El piso de `p_tope` es 20
-- porque es lo que muestra el panel (`api/notifications/inbox` lista con `.limit(20)`): por
-- debajo de eso la retencion estaria borrando filas que el usuario SI puede ver.
--
-- SECURITY INVOKER y `EXECUTE` revocado de anon/authenticated, igual que la 076 y los agregados
-- del panel admin (039). La llama un cron con service_role.

create or replace function public.notificaciones_podar(p_dias int, p_tope int)
returns table (por_edad bigint, por_tope bigint)
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_edad bigint;
  v_tope bigint;
begin
  if p_dias is null or p_dias < 7 then
    raise exception 'notificaciones_podar: p_dias=% es un corte inseguro (minimo 7)', p_dias;
  end if;
  if p_tope is null or p_tope < 20 then
    raise exception 'notificaciones_podar: p_tope=% deja la campana por debajo de las 20 filas que muestra el panel (minimo 20)', p_tope;
  end if;

  with borradas as (
    delete from public.notificaciones
    where fecha < now() - make_interval(days => p_dias)
    returning 1
  ) select count(*) into v_edad from borradas;

  with sobrantes as (
    select id from (
      select id, row_number() over (partition by usuario_id order by fecha desc) as rn
      from public.notificaciones
    ) x where x.rn > p_tope
  ), borradas as (
    delete from public.notificaciones n using sobrantes s where n.id = s.id
    returning 1
  ) select count(*) into v_tope from borradas;

  return query select v_edad, v_tope;
end;
$$;

comment on function public.notificaciones_podar(int, int) is
  'Retencion de la campana: borra por edad y luego acota a las N mas nuevas por usuario. Devuelve cuantas borro cada clausula. La llama checkRetencionNotificaciones (cron diario).';

revoke all on function public.notificaciones_podar(int, int) from public, anon, authenticated;
grant execute on function public.notificaciones_podar(int, int) to service_role;
