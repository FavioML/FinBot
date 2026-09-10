/**
 * DE DÓNDE VINO UN ALTA WEB. El tramo que le faltaba a la cadena de atribución.
 *
 * Medido el 2026-09-10: `usuarios.origen` solo lo escribía el primer mensaje de WhatsApp
 * (`app/lib/atribucion.js`), y el alta web ya era el 60% de las altas de septiembre. El link de la
 * landing llegaba a app.neto.pe con el UTM puesto y nadie lo guardaba, así que el techo de
 * atribución bajaba cada mes (95,5% en julio, 64,6% en agosto, 40% en los primeros días de
 * septiembre).
 *
 * **Por qué una cookie y no sessionStorage, que es lo que usa la landing.** El consumidor es
 * distinto. En la landing quien lee el origen es JS de cliente (arma los links al montar); acá
 * quien lo lee es `/auth/callback`, una route de SERVIDOR que corre después del viaje a Google y de
 * vuelta, y esa query ya no existe cuando llega. Es el mismo problema que el `?ref` de referidos, y
 * esta webapp ya lo resolvió así: el middleware lo guarda apenas lo ve y el callback lo consume al
 * crear la cuenta. Mismo mecanismo, misma vida útil de la captura.
 *
 * LA SEMÁNTICA ES LA DEL LADO DE WHATSAPP, y no es opcional porque las dos puertas escriben las
 * mismas dos columnas y se leen en el mismo `GROUP BY`:
 *
 *   · **Primer toque.** La cookie no se pisa (la escribe el primer UTM que se ve) y el callback solo
 *     la usa en la rama que CREA la fila. Una fila que ya existe —la de WhatsApp que vincula su
 *     cuenta, la de una activación— no se toca: su origen lo decidió su propia alta.
 *   · **`'directo'` y NULL no son lo mismo.** Un alta web sin cookie se midió y no traía pista, así
 *     que va `'directo'`. NULL queda reservado para "alta anterior a la medición" (migración 084).
 *   · **Mismo saneado que la landing** (`landing/src/lib/atribucion.ts`, `sanear`): minúsculas,
 *     `[a-z0-9._-]`, tope de 40. El tope no es estética: es el `usuarios_origen_largo_chk`, y un
 *     valor que lo violara haría fallar el INSERT de la cuenta entera, no solo la atribución.
 *
 * **`origen_cta = 'web'`, no NULL, y este es el motivo.** NULL en esa columna dice "no vino por un
 * CTA de la landing", y un alta web que entró desde el hero SÍ vino por uno: lo que no sabemos es
 * cuál, porque la posición viaja solo en el texto de WhatsApp. `'web'` nombra la PUERTA sin inventar
 * un botón. Y sobrevive al merge: la 085 mueve el par junto, así que una cuenta web que después
 * vincula su WhatsApp sigue diciendo por dónde entró, cosa que un NULL no podría.
 *
 * Este archivo es PURO a propósito: lo importa el middleware, que corre en el Edge.
 */

export const COOKIE_ORIGEN = 'neto_origen';

/** 30 días: el alta casi siempre ocurre en la misma visita, pero primer toque es primer toque. */
export const COOKIE_ORIGEN_MAX_AGE = 60 * 60 * 24 * 30;

export const ORIGEN_DIRECTO = 'directo';
export const ORIGEN_CTA_WEB = 'web';

export type AtribucionAlta = { origen: string; origen_cta: string };

/**
 * Copia de `sanear` de la landing. Está duplicada a propósito, no por descuido: son repositorios
 * distintos y el CI de cada uno solo hace checkout del suyo (misma decisión que `verify-claims.mjs`
 * y su hermano de acá). Devuelve `''` si no queda nada utilizable.
 */
export const sanearOrigen = (v: string | null | undefined): string =>
  (v ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '')
    .slice(0, 40);

/**
 * El origen que trae ESTA URL, o `''`. Solo `utm_source`: es lo único que la landing garantiza
 * (siempre lo pone, real o derivado del referrer) y lo único que mapea a un canal. `utm_medium`,
 * `utm_campaign` y compañía los sigue viendo PostHog en el pageview; acá no tienen columna.
 */
export const origenDeLaUrl = (params: URLSearchParams): string => sanearOrigen(params.get('utm_source'));

/**
 * El par que se escribe en la fila que crea el alta web. Re-sanea lo que venga de la cookie: el
 * middleware ya lo saneó, pero una cookie la puede escribir cualquiera, y lo que sale de acá va a un
 * INSERT con CHECK que, si falla, se lleva puesta la cuenta.
 */
export function atribucionDelAlta(cookie: string | null | undefined): AtribucionAlta {
  return { origen: sanearOrigen(cookie) || ORIGEN_DIRECTO, origen_cta: ORIGEN_CTA_WEB };
}
