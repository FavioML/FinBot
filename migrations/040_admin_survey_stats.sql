-- Ola 2 auditoria panel admin (2026-07-30): agrega en SQL los stats de /api/admin/surveys.
--
-- Mismo bug de fondo que la Ola 1 (migracion 039), pero LATENTE en vez de activo: la ruta
-- leia `survey_events` ENTERA DOS VECES (una para el listado, otra para stats) y agregaba en
-- JavaScript. PostgREST corta la respuesta en 1000 filas (verificado en Ola 1: db-max-rows=1000
-- en esta instancia), asi que apenas la tabla pase de 1000 filas los stats empezarian a mentir
-- SIN ningun error visible, exactamente como el embudo. Hoy son 180 filas, pero 70 de ellas
-- (wake_up_*) ni siquiera se muestran: el reloj corre.
--
-- Esta funcion cuenta en SQL lo que la ruta contaba en JS. Devuelve UNA fila por event_type
-- (decenas de filas, no miles), asi que no queda nada que truncar. La ruta ya no hace la
-- segunda lectura de la tabla entera: arma los porcentajes desde estos conteos.
--
-- Diseno (igual que 039):
--   * SECURITY INVOKER (default). EXECUTE revocado de anon/authenticated; es uso admin
--     (service_role).
--   * Scopeada a los 9 event_type que el panel realmente renderiza. Los wake_up_inactive /
--     wake_up_onboarding (sistema legado, migraciones 010-013) no tienen tab ni label en la UI,
--     asi que quedan fuera para que `total` y los stats reflejen lo que se ve.
--   * Los conteos crudos salen en SQL; la rama "que tasa aplica a que tipo" (conv24 para
--     recordatorios, conv7 para invites) se queda en la ruta, donde es legible. Derivar un
--     porcentaje de dos conteos NO es "traer filas para contarlas": las filas ya se contaron.
--   * La conversion a Pro necesita el plan/fecha_pago del usuario -> LEFT JOIN usuarios. Los
--     filtros de Pro son inofensivos para los demas tipos (dan 0). Ventana de 30 dias y la
--     exclusion de "ya era Pro al enviar" replican exactamente la logica de route.ts.
--   * No lleva branch de Supabase previo (regla de .claude/rules/database.md): es un unico
--     CREATE FUNCTION, sin DDL sobre tablas ni lock sobre datos.

create or replace function public.admin_survey_stats()
returns table (
  event_type text,
  count_sent bigint,
  count_responded bigint,
  count_dismissed bigint,
  count_opted_out bigint,
  count_conv24 bigint,
  count_conv7 bigint,
  nps_sum_ease numeric,
  nps_sum_usefulness numeric,
  nps_sum_recommend numeric,
  nps_count bigint,
  upsell_denom bigint,
  count_converted_to_pro bigint
)
language sql
stable
set search_path = public, pg_temp
as $$
  select
    e.event_type::text as event_type,
    count(*) filter (where e.sent_at is not null)::bigint as count_sent,
    count(*) filter (where e.responded_at is not null)::bigint as count_responded,
    count(*) filter (where e.dismissed_at is not null)::bigint as count_dismissed,
    count(*) filter (where e.opted_out_after)::bigint as count_opted_out,
    count(*) filter (where e.sent_at is not null and e.conversion_within_24h)::bigint as count_conv24,
    count(*) filter (where e.sent_at is not null and e.conversion_within_7d)::bigint as count_conv7,
    -- NPS: solo nps_inapp respondido con las tres notas numericas. response_data guarda
    -- numeros JSON (verificado), asi que ->> + cast es exacto.
    coalesce(sum(
      case when e.event_type::text = 'nps_inapp' and e.responded_at is not null
                and jsonb_typeof(e.response_data->'ease') = 'number'
                and jsonb_typeof(e.response_data->'usefulness') = 'number'
                and jsonb_typeof(e.response_data->'recommend') = 'number'
           then (e.response_data->>'ease')::numeric end), 0) as nps_sum_ease,
    coalesce(sum(
      case when e.event_type::text = 'nps_inapp' and e.responded_at is not null
                and jsonb_typeof(e.response_data->'ease') = 'number'
                and jsonb_typeof(e.response_data->'usefulness') = 'number'
                and jsonb_typeof(e.response_data->'recommend') = 'number'
           then (e.response_data->>'usefulness')::numeric end), 0) as nps_sum_usefulness,
    coalesce(sum(
      case when e.event_type::text = 'nps_inapp' and e.responded_at is not null
                and jsonb_typeof(e.response_data->'ease') = 'number'
                and jsonb_typeof(e.response_data->'usefulness') = 'number'
                and jsonb_typeof(e.response_data->'recommend') = 'number'
           then (e.response_data->>'recommend')::numeric end), 0) as nps_sum_recommend,
    count(*) filter (where e.event_type::text = 'nps_inapp' and e.responded_at is not null
                and jsonb_typeof(e.response_data->'ease') = 'number'
                and jsonb_typeof(e.response_data->'usefulness') = 'number'
                and jsonb_typeof(e.response_data->'recommend') = 'number')::bigint as nps_count,
    -- Denominador de conversion a Pro: upsells enviados que NO eran Pro al momento del envio.
    count(*) filter (
      where e.event_type::text = 'pro_upsell_d28'
        and e.sent_at is not null
        and not (u.plan = 'premium' and u.fecha_pago is not null and u.fecha_pago < e.sent_at)
    )::bigint as upsell_denom,
    -- Convirtieron a Pro dentro de 30 dias post-envio (excluye los que ya eran Pro).
    count(*) filter (
      where e.event_type::text = 'pro_upsell_d28'
        and e.sent_at is not null
        and not (u.plan = 'premium' and u.fecha_pago is not null and u.fecha_pago < e.sent_at)
        and u.plan = 'premium'
        and u.fecha_pago is not null
        and u.fecha_pago >= e.sent_at
        and u.fecha_pago <= e.sent_at + interval '30 days'
    )::bigint as count_converted_to_pro
  from public.survey_events e
  left join public.usuarios u on u.id = e.user_id
  where e.event_type::text in (
    'reminder_d3', 'reminder_d7', 'reminder_d14', 'reminder_d30',
    'webapp_invite_10tx', 'feedback_open_30tx', 'nps_inapp',
    'inactivity_reminder', 'pro_upsell_d28'
  )
  group by e.event_type
$$;

comment on function public.admin_survey_stats() is
  'Panel admin: agregados de survey_events por event_type (enviados, respondidos, conversiones, '
  'NPS, conversion a Pro). Cuenta en SQL para no truncar a 1000 filas ni leer la tabla entera '
  'dos veces. Scopeada a los 9 tipos que el panel muestra (excluye wake_up_* legado).';

revoke all on function public.admin_survey_stats() from public, anon, authenticated;
grant execute on function public.admin_survey_stats() to service_role;
