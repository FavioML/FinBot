import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Total exacto e inventario completo de tipos de la campana de un usuario.
 *
 * **Por que no sale del listado.** El panel de notificaciones lista con `.limit(20)` (acota el
 * dropdown, que no tiene paginacion ni virtualizacion), y hasta el 2026-08-27 el evento
 * `notifications_opened` derivaba `total` y `tipos` de esa lista capada mientras `unreadCount`
 * contaba exacto. El resultado eran aperturas reales en PostHog con `total: 20, no_leidas: 22`:
 * el campo que mide el RUIDO saturaba justo arriba, o sea en el unico usuario del muestreo con
 * volumen de verdad, y nadie lo veia porque 20 es un numero plausible.
 *
 * **Des-capar la lista no era el arreglo.** Medido en produccion el 27-ago: 8 de 77 usuarios
 * superan el cap, el mayor con **786 filas** (todas vivas desde el 2026-04-03; nada poda esta
 * tabla) y el segundo con 364. Mandarle eso a un dropdown de 400px cada 60 segundos cambia un
 * sesgo de medicion por un problema de peso que solo crece.
 *
 * **`tipos` era el peor de los dos, y no por magnitud sino por CONTENIDO.** De esos 8 usuarios,
 * **6 pierden al menos un tipo** en la vista capada, y lo que se pierde es lo viejo:
 * `deuda_vence` era invisible en los dos usuarios mas grandes, y `deuda_vence` es exactamente
 * el tipo sobre el que se decide si va a plantilla HSM.
 *
 * Devuelve `null` en los dos campos si la funcion falla. **No cero**: cero es un valor legitimo
 * (usuario sin avisos) y confundirlos reintroduce el mismo defecto que este helper arregla, con
 * la lectura sesgada hacia abajo. `null` dice "no se midio".
 */
export interface ResumenNotificaciones {
  /** Cuantas filas tiene el usuario en total, sin el cap del listado. `null` si no se pudo medir. */
  total: number | null;
  /** Inventario completo de `tipo`, sin el cap del listado. `null` si no se pudo medir. */
  tipos: string[] | null;
}

const NO_MEDIDO: ResumenNotificaciones = { total: null, tipos: null };

export async function resumenNotificaciones(
  svc: SupabaseClient,
  userId: string,
): Promise<ResumenNotificaciones> {
  try {
    const { data, error } = await svc
      .rpc('notificaciones_resumen', { p_usuario_id: userId })
      .maybeSingle<{ total: number; tipos: string[] }>();

    // supabase-js NUNCA lanza por un error de la base: si esto no se mira, un fallo de la
    // funcion se ve identico a un usuario sin avisos. Por eso va a `null` y no a `?? 0`.
    if (error || !data) return NO_MEDIDO;

    return { total: Number(data.total), tipos: data.tipos ?? [] };
  } catch {
    // El `try` no es ceremonia: la ruta que mas usa este helper es el fast-path
    // `api/dashboard`, que corre TODAS sus queries en un `Promise.all`. Ahi una excepcion no
    // devuelve un campo vacio, tumba el request entero — o sea que un dato de telemetria
    // podria dejar el dashboard en 500. El precio de no medir una apertura es cero.
    return NO_MEDIDO;
  }
}
