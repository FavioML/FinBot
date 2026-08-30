'use client';

import { useEffect, useState } from 'react';

/**
 * Le da voz al esqueleto cuando la carga se estira.
 *
 * La queja original era *"no sale ningún cargando"*, y medirla la desmintió: el
 * esqueleto aparece antes de los 700 ms y nunca hay pantalla en blanco (capturas a
 * 700 ms, 1.5 s, 3 s y 5 s, 30-ago-2026). Lo que pasa es otra cosa: ese esqueleto se
 * queda entre 3 y 5 segundos sin decir nada, y un rectángulo que brilla en loop sin
 * más información se lee como *"se colgó"*, no como *"está cargando"*.
 *
 * Esto NO acelera nada. Es el arreglo de percepción, y es independiente de los de
 * velocidad (la región y el ruido del cliente, ítem 16 del backlog de confiabilidad).
 * Sigue haciendo falta después de esos dos porque el cold start de Vercel no se fue:
 * en la tanda del 30-ago, con producción ya en `gru1`, la carga en frío seguía dando
 * 7.8 s contra ~1.3 s de las calientes.
 *
 * ## Tres decisiones que no son cosméticas
 *
 * **Ocupa el renglón del SUBTÍTULO del esqueleto, y por eso recibe un `placeholder`.**
 * La primera versión lo ponía debajo del esqueleto, razonando que ahí aparecer no empuja
 * nada. Cierto y **inútil**: verificado contra el dev server con `/api/dashboard`
 * retrasado 9 s y viewport de 430x900, el esqueleto del overview mide más que una
 * pantalla, así que el mensaje nacía **fuera del pliegue** y no lo veía nadie. Un aviso
 * invisible no arregla ninguna percepción. Acá reemplaza en el sitio a una barra que ya
 * estaba, con la misma altura: se ve arriba de todo y no mueve nada.
 *
 * **Antes del primer umbral muestra el `placeholder`, no un hueco.** Una carga caliente
 * resuelve en ~1.3 s; un "cargando" que parpadea 300 ms y desaparece es peor que el
 * silencio. El umbral está por encima de la mediana caliente a propósito: si el texto se
 * ve, es porque de verdad se está tardando.
 *
 * **El segundo umbral dice que está tardando, y no promete un tiempo.** Prometer "unos
 * segundos más" es una afirmación que este componente no puede sostener: no sabe si el
 * arranque está en cold start, en la base o caído.
 */

/**
 * Los umbrales se cuentan desde que se MONTA la espera, no desde que arrancó la
 * navegación. Es a propósito: `performance.now()` mide desde la carga de la página y
 * seguiría creciendo entre pantallas, así que una navegación interna a los 30 segundos
 * de abierta la app mostraría el aviso al instante. "Cuánto lleva ESTA espera" es la
 * pregunta correcta, y esa se cuenta desde el montaje.
 *
 * El costo: en la primera carga el shell hidrata algo después de la navegación, así que
 * el primer mensaje sale ~1 s más tarde de lo que el usuario lleva esperando. Cae del
 * lado bueno — es lo que evita que la carga caliente lo vea.
 */
const UMBRALES = [
  { ms: 2500, texto: 'Cargando tus datos' },
  { ms: 7000, texto: 'Está tardando más de lo normal. Seguimos intentando' },
] as const;

export function AvisoCargaLenta({ placeholder = null }: { placeholder?: React.ReactNode }) {
  const [nivel, setNivel] = useState(-1);

  useEffect(() => {
    const timers = UMBRALES.map((u, i) => window.setTimeout(() => setNivel(i), u.ms));
    return () => timers.forEach((t) => window.clearTimeout(t));
  }, []);

  return (
    <div
      // `polite` y no `assertive`: es información de estado, no una alerta. Un lector
      // de pantalla la anuncia cuando termina lo que está diciendo.
      role="status"
      aria-live="polite"
      // Altura fija en las dos ramas: es lo que hace que aparecer el texto no corra
      // nada de lo que está debajo. h-5 y no h-4 porque es la altura real del subtítulo
      // que el esqueleto está imitando (`text-sm`), así que además queda más parecido.
      className="flex h-5 items-center gap-2"
    >
      {nivel < 0 ? (
        placeholder
      ) : (
        <>
          <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-[#1D9E75] animate-pulse-dot" />
          <span className="text-sm text-[#8A877D]">{UMBRALES[nivel].texto}</span>
        </>
      )}
    </div>
  );
}
