import { PRO_PRICE_MONTHLY_PEN } from './constants';

/**
 * Lo que `/admin/pagos` devuelve como contexto de referido, y lo que el panel tiene que
 * mostrarle al admin ANTES de aprobar un comprobante.
 *
 * ─── Por qué esto es una función pura y no JSX ──────────────────────────────────────────
 *
 * Los tests de la webapp corren en `node` sin jsdom (ver `vitest.config.ts`): no renderizan
 * componentes. Con la decisión adentro del JSX lo único posible era un guard estático sobre el
 * fuente, y un guard de forma no puede ver lo que acá importa, que es **qué se muestra cuando
 * la lectura falló**. Sacándola a una función se puede ejercitar el caso de verdad.
 *
 * ─── El defecto que esto arregla, y por qué toca plata ──────────────────────────────────
 *
 * `resumenReferidoParaAdmin` (backend) devuelve `parcial: true` cuando no pudo leer, y su
 * default —0% de descuento, sin referrer— es **idéntico** al de un usuario sin referido. El
 * aviso de Telegram ya imprime la advertencia (`lib/pro-payment.js`); la pantalla donde el
 * admin efectivamente aprueba, no. Peor: el bloque entero se renderizaba sólo si
 * `descuentoPct > 0 || referrerNombre`, que es exactamente falso en el caso `parcial`, así que
 * la pantalla no mostraba **nada** justo cuando había algo que decir.
 *
 * Lo que se pierde con ese silencio es dinero en las dos direcciones: se puede rechazar un
 * pago legítimo de S/5 creyendo que se esperaban S/10, o aprobar sin saber que alguien gana
 * un mes gratis.
 *
 * ─── `parcial` NO significa que lo demás sea el default ─────────────────────────────────
 *
 * La primera versión de esta función devolvía **sólo** la advertencia y cortaba, con el
 * argumento de que al lado de "no pude leer" un monto se lee como dato. Estaba mal, y lo
 * encontró una revisión adversarial: el flag se enciende desde **tres sitios independientes**
 * de `resumenReferidoParaAdmin` (la lectura del descuento, la de la fila de `referidos`, y su
 * catch), así que hay entradas alcanzables donde una mitad se leyó perfecto:
 *
 *   · falla la fila de `referidos` y el descuento se leyó → `{descuentoPct: 50, parcial: true}`
 *   · falla la lectura del descuento y el referrer se leyó → `{referrerNombre: 'Ana', parcial: true}`
 *
 * Cortar ahí **borraba justo el dato que evita el daño** que el párrafo de arriba describe. Y
 * el texto mentía: decía que no se pudo leer el descuento Y el referrer. Ahora se muestra la
 * advertencia **más** lo que sí se leyó, que es lo que el aviso de Telegram viene haciendo
 * desde que se escribió — tres `if` independientes, no una cascada.
 *
 * ─── Lo que NO hace, a propósito ────────────────────────────────────────────────────────
 *
 * No bloquea la aprobación. El aviso de Telegram dice "reintenta antes de aprobar" y no corta
 * nada; bloquear el botón sería una decisión de producto distinta —y dejaría al admin sin
 * poder cobrar cuando Supabase tiene un hipo—, así que las dos superficies avisan igual.
 */
export type ResumenReferido = {
  descuentoPct: number;
  referrerNombre: string | null;
  yaPremiado: boolean;
  /**
   * El id del referrer. Va en el tipo aunque el panel casi nunca lo pinte, porque
   * `resumenReferidoParaAdmin` deja `referrerNombre` en null —sin marcar `parcial`— cuando no
   * pudo leer el nombre, y su comentario declara textualmente que "el consumidor lo imprime
   * cuando falta el nombre". Eso era cierto para Telegram y **falso para esta pantalla**, que
   * es un segundo consumidor: sin el id no había con qué imprimir nada y el admin no se
   * enteraba de que había un referrer. También pasa con un `usuarios.nombre` simplemente NULL,
   * que no requiere ningún error.
   */
  referrerId?: string | null;
  /** El backend lo manda; el panel lo ignoraba. Opcional porque una respuesta vieja no lo trae. */
  parcial?: boolean;
};

export type AvisoReferido = {
  /** `advertencia` pinta en ámbar y va primero: es lo que puede hacer perder plata. */
  tono: 'advertencia' | 'info';
  texto: string;
};

/** El monto que se espera cobrar con un descuento de referido, en soles. */
export function montoEsperado(descuentoPct: number, precioMensual = PRO_PRICE_MONTHLY_PEN): number {
  return (precioMensual * (100 - descuentoPct)) / 100;
}

/**
 * Los avisos a mostrar sobre el contexto de referido de un usuario, en orden de importancia.
 *
 * Devuelve `[]` cuando no hay nada que decir (usuario sin referido y lectura sana), que es el
 * caso normal: el bloque no se pinta y la pantalla no gana ruido.
 */
export function avisosReferido(
  referido: ResumenReferido | null | undefined,
  precioMensual = PRO_PRICE_MONTHLY_PEN,
): AvisoReferido[] {
  if (!referido) return [];
  const avisos: AvisoReferido[] = [];

  // Primero, pero NO en lugar de lo demás. El texto no dice cuál de las lecturas falló porque
  // esta función no puede saberlo: el backend enciende un solo flag para tres sitios.
  if (referido.parcial) {
    avisos.push({
      tono: 'advertencia',
      texto: 'No se pudo leer parte del contexto de referido. Lo que falta se ve igual que un usuario sin referido, así que reintenta antes de aprobar.',
    });
  }

  if (referido.descuentoPct > 0) {
    avisos.push({
      tono: 'info',
      texto: `Referido con ${referido.descuentoPct}% off — se espera S/ ${montoEsperado(referido.descuentoPct, precioMensual).toFixed(2)} (no S/ ${precioMensual.toFixed(2)})`,
    });
  }
  // El nombre si lo hay, el id si no. Mismo orden que el aviso de Telegram: lo que importa es
  // que el admin sepa que HAY un referrer que gana un mes al aprobar, no cómo se llama.
  const quien = referido.referrerNombre || referido.referrerId;
  if (quien) {
    avisos.push({
      tono: 'info',
      texto: `Referido de ${quien} — ${referido.yaPremiado ? 'ya recibió su mes' : 'gana 1 mes gratis al aprobar'}`,
    });
  }
  return avisos;
}
