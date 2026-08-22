/**
 * La entrada de una pantalla que alguien abre desde WhatsApp: se desliza, no se funde.
 *
 * Nada que ocupe la primera pantalla puede nacer en `opacity: 0`. Chrome no cuenta como
 * *contentful* lo que está totalmente transparente, así que mientras el contenido siga en
 * cero el navegador pinta el fondo y nada más: el `first-contentful-paint` llega tarde o no
 * llega. Ya pasó en `/login` con la clase `fade-in` de CSS, y era el origen del `NO_FCP` con
 * que PageSpeed rechazaba app.neto.pe.
 *
 * En `/join/*` y `/onboarding` el mismo error era **más caro**, porque el mecanismo era otro.
 * El wrapper venía de `motion` (`initial={{ opacity: 0, y: 20 }}`), y `motion` no puede
 * devolverle la opacidad a nada hasta que su bundle baje, parsee e hidrate. El `fade-in` de
 * CSS del login duraba 600ms fijos; éste duraba lo que tardara la hidratación. Medido contra
 * producción el 22-ago-2026, 5 corridas móviles (412×823, 1.6 Mbps, CPU 4×):
 *
 *   /join/gasto  first-paint 1780ms → FCP 2888ms   **gap de 1108-1196ms en blanco**, 5 de 5
 *   /login       first-paint 1648ms → FCP 1648ms   gap 0ms, 5 de 5
 *
 * Ese gap es pantalla negra con el usuario mirando, y crece con lo lento que sea el teléfono.
 * En `/join/*` cae sobre el que llega desde una invitación de WhatsApp, que es gente que
 * todavía no tiene cuenta: es la peor pantalla posible para no mostrar nada.
 *
 * El deslizamiento es `transform`: no afecta al pintado ni al CLS, y se queda. Lo que se fue
 * es el fundido, que era lo único que exigía empezar invisible.
 *
 * Lo cuida `src/app/entrada-no-transparente.test.ts`, que barre las pantallas públicas
 * enteras — no sólo este archivo. Una constante correcta no sirve de nada si una página
 * escribe el `opacity: 0` a mano al lado.
 */
export const ENTRADA_TARJETA =
  'animate-in fill-mode-both slide-in-from-bottom-[20px] ease-[cubic-bezier(0.25,0.46,0.45,0.94)]';
