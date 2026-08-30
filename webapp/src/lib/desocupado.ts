/**
 * Correr algo cuando el navegador se desocupe, no cuando el componente monta.
 *
 * Para trabajo que no tiene urgencia pero sí prioridad de red: si arranca al montar,
 * compite con el arranque del dashboard por el ancho de banda y por las conexiones.
 * El caso que lo motivó (ítem 16 del backlog de confiabilidad, medido el 30-ago-2026):
 * la consulta a `usuarios` del `identify` de PostHog llegó a 3564 ms durante la carga
 * inicial, y era la petición más lenta de esa carga. Sirve igual un segundo después.
 *
 * **No sirve para nada que el usuario esté esperando.** Diferir algo que se ve es
 * empeorar la percepción, que es el problema de al lado.
 *
 * `requestIdleCallback` con `timeout` es el mecanismo correcto: corre en el primer
 * hueco, y si no hay hueco corre igual al vencer el tope. El fallback existe porque
 * Safari lo soportó recién en 2022 y todavía hay iOS viejos en el parque: ahí un
 * `setTimeout` corto es peor aproximación pero saca el trabajo del momento del montaje,
 * que es el 90% de lo que se busca.
 */
type ConIdle = typeof globalThis & {
  requestIdleCallback?: (cb: () => void, opciones?: { timeout: number }) => number;
};

export function cuandoSeDesocupe(fn: () => void, msTope = 3000): void {
  if (typeof window === 'undefined') return;
  const g = window as ConIdle;
  if (typeof g.requestIdleCallback === 'function') {
    g.requestIdleCallback(fn, { timeout: msTope });
    return;
  }
  window.setTimeout(fn, 1200);
}
