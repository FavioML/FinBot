/**
 * Los cuatro estados en los que puede estar la conexión de Gmail de un usuario.
 *
 * Vive acá y no dentro del componente por la misma razón que `pantallaPro` en `plan.ts`: la
 * decisión es la parte que se puede equivocar, y la webapp solo corre tests de módulos de
 * servidor (ver `vitest.config.ts`: sin jsdom, sin testing-library). Un guard sobre el JSX
 * sería un regex; sobre esto es un test de verdad.
 */
export type EstadoGmail =
  /** No paga y no tiene nada conectado: la capability está detrás del muro de Pro pagado. */
  | 'bloqueado'
  /** Puede conectar y todavía no lo hizo. */
  | 'sin-conectar'
  /** Conectada y leyendo. NO lleva ninguna acción encima: un CTA acá contradice el "conectado". */
  | 'sano'
  /** Conectada en nuestros libros pero Google dejó de aceptar el token. Único estado con CTA. */
  | 'caido';

export function estadoGmail(e: {
  conectado: boolean;
  necesitaReconexion: boolean;
  proPagado: boolean;
}): EstadoGmail {
  // `caido` gana sobre `sano` y se evalúa primero: los dos tienen conectado=true, y el orden
  // inverso dejaría el estado roto inalcanzable — que es exactamente el bug que esto cierra.
  if (e.conectado) return e.necesitaReconexion ? 'caido' : 'sano';
  return e.proPagado ? 'sin-conectar' : 'bloqueado';
}

/**
 * Si el estado admite que el usuario dispare el flujo de OAuth.
 *
 * Un no-pagador con una cuenta conectada (o caída) no puede: `/pro/gmail-auth-url` le responde
 * 403, así que ofrecerle el botón sería mandarlo a un error. Se le muestra el estado, no la
 * acción.
 */
export function puedeAccionar(estado: EstadoGmail, proPagado: boolean): boolean {
  if (estado === 'bloqueado' || estado === 'sano') return false;
  return proPagado;
}
