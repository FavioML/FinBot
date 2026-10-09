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
  | 'caido'
  /**
   * Conectó una cuenta de Google que NO TIENE Gmail (creada con un Hotmail u Outlook): el token
   * anda pero no hay bandeja que leer (migración 090). Sin CTA: reconectar esa cuenta no cambia
   * nada y otra gasta un cupo de Google y choca con la regla de una cuenta. Va por soporte.
   */
  | 'sin-buzon';

export function estadoGmail(e: {
  conectado: boolean;
  necesitaReconexion: boolean;
  proPagado: boolean;
  /** Opcional para no romper a quien no lo manda: ausente = no se sabe que falte el buzón. */
  sinBuzon?: boolean;
}): EstadoGmail {
  // `sin-buzon` va antes que `caido`: si la cuenta no tiene Gmail, pedirle que reconecte es
  // mandarlo a un arreglo que no arregla nada. `caido` gana sobre `sano` por el mismo motivo
  // de orden: los tres tienen conectado=true, y el orden inverso los dejaría inalcanzables.
  if (e.conectado) {
    if (e.sinBuzon) return 'sin-buzon';
    return e.necesitaReconexion ? 'caido' : 'sano';
  }
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
  if (estado === 'bloqueado' || estado === 'sano' || estado === 'sin-buzon') return false;
  return proPagado;
}
