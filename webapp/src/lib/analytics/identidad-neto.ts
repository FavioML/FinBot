/**
 * El `usuarios.id` de quien está usando la app, publicado por quien ya lo tuvo que
 * pedir, para que analytics no lo pida otra vez.
 *
 * PostHog identifica con el id de la tabla `usuarios` (no con el de Supabase Auth) para
 * que el funnel una landing -> WhatsApp -> webapp bajo una sola identidad. Conseguirlo
 * costaba una consulta directa a PostgREST en cada carga, y esa consulta competía con el
 * arranque del dashboard: medida en 3003 ms en la carga en frío del 30-ago-2026.
 *
 * **Diferirla no alcanzaba, y eso se midió.** La primera versión la mandaba a
 * `requestIdleCallback`: el navegador se desocupa JUSTAMENTE mientras espera la red, así
 * que el hueco llegaba a los ~1000 ms y la consulta seguía cayendo dentro del arranque
 * (el dato aparece a los ~1450 ms). Un diferido y un borrado se leen igual en un conteo
 * de peticiones; lo que los separa es cuándo arranca cada una, que es lo que reporta
 * `qa-e2e/diag-arranque.mjs`.
 *
 * Acá la consulta no se mueve: **deja de existir**. `/api/dashboard` ya trae `user.id`,
 * así que el bootstrap lo publica y analytics lo consume. Cero peticiones nuevas en la
 * pantalla que importa.
 *
 * Fuera del dashboard (login, onboarding, /join) nadie publica nada y el consumidor cae
 * a su consulta de siempre, ya sin prisa. Por eso esto es un canal y no un parámetro:
 * `PostHogProvider` vive en el root layout y el bootstrap adentro del shell, así que no
 * hay árbol de React que los una.
 */

let idPublicado: string | null = null;
const suscriptores = new Set<(id: string) => void>();

/** Lo llama el bootstrap del dashboard cuando siembra la caché. */
export function publicarIdNeto(id: string): void {
  if (!id || idPublicado === id) return;
  idPublicado = id;
  for (const fn of suscriptores) fn(id);
}

/**
 * Avisa cuando se sepa el id. Si ya se sabe, llama en el acto (síncrono) — el consumidor
 * puede montarse antes o después que el bootstrap y las dos órdenes tienen que funcionar.
 * Devuelve la función para desuscribirse.
 *
 * La suscripción NO se cancela sola al primer aviso. Si se cancelara, un cierre de sesión
 * seguido de otro ingreso en la misma pestaña dejaría a la segunda persona sin
 * identificar: el bootstrap volvería a publicar y ya no habría nadie escuchando.
 */
export function alSaberIdNeto(fn: (id: string) => void): () => void {
  if (idPublicado) fn(idPublicado);
  suscriptores.add(fn);
  return () => suscriptores.delete(fn);
}

/**
 * Olvida el id publicado. Lo llama el cierre de sesión: ese id era de OTRA persona, y
 * dejarlo puesto hace que el `publicarIdNeto` de la sesión siguiente se descarte por el
 * corto de "ya es el mismo" cuando vuelve a entrar la misma cuenta.
 */
export function olvidarIdNeto(): void {
  idPublicado = null;
}

/** Solo para tests: devuelve el módulo a su estado inicial. */
export function _resetIdNeto(): void {
  idPublicado = null;
  suscriptores.clear();
}
