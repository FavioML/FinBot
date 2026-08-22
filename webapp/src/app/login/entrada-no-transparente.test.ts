import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `/login` no puede pintar su primera pantalla vacía de contenido.
 *
 * El 22-ago-2026 la tarjeta del login llevaba `fade-in`, o sea que nacía en
 * `opacity: 0`. En móvil esa tarjeta ES todo lo que hay sobre la línea de flote,
 * así que el primer pintado era el fondo y nada más. Chrome no cuenta como
 * *contentful* lo que está totalmente transparente: medido contra producción, 8
 * corridas móviles, el `first-contentful-paint` aparecía en 1 de 8. Sin la clase,
 * 8 de 8, y siempre igual al first-paint. Ése era el origen del `NO_FCP` con que
 * PageSpeed rechazaba app.neto.pe en sus cuatro combinaciones.
 *
 * Lo que este guard exige NO es "que no diga fade-in": es que ninguna clase que
 * ponga opacidad en cero se aplique AL MONTAR. La distinción que decide es el
 * prefijo de variante. `data-open:fade-in-0` es correcto y abunda en
 * `components/ui/` — se dispara cuando un diálogo se abre, no en la primera
 * pintada. La clase pelada, no.
 *
 * LO QUE ESTE GUARD NO CUBRE, y no es un olvido:
 *
 * - Solo mira `login/page.tsx`. Las pantallas de `join` y `onboarding` tienen
 *   `initial` de `motion` con opacidad cero, que es la misma clase de problema
 *   por otro mecanismo. NO están medidas: además esperan un fetch, así que su
 *   primer pintado depende de otra cosa y el arreglo no se deduce de éste.
 * - Es estático: lee el archivo, no el pintado. Lo que de verdad prueba el
 *   invariante es medir el FCP contra producción después del deploy.
 */

const FUENTE = join(process.cwd(), 'src', 'app', 'login', 'page.tsx');

/** Clases de Tailwind/tw-animate-css que dejan un elemento totalmente transparente. */
const OPACIDAD_CERO = /^(fade-in(-0)?|opacity-0)$/;

/**
 * Variantes que NO son "al montar": la clase se aplica cuando cambia un estado.
 * Las de breakpoint (lg, md) sí montan, así que no entran acá a propósito — una
 * tarjeta transparente solo en desktop sigue rompiendo el FCP de desktop.
 */
const VARIANTE_POR_ESTADO = /^(data-|group-|peer-|aria-|hover|focus|active|open|closed)/;

/**
 * Los comentarios NO son código. El docblock de `page.tsx` explica este bug y
 * nombra la clase varias veces entre backticks: sin este paso el guard se
 * disparaba con su propia documentación, que es la versión más tonta de un guard
 * que no mira lo que dice mirar.
 */
function sinComentarios(codigo: string): string {
  return codigo.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
}

/** Toda clase aplicada al montar, con su variante ya resuelta. */
function clasesDeMontaje(codigo: string): string[] {
  const literales = sinComentarios(codigo).match(/(['"`])[^'"`]*\1/g) ?? [];
  return literales
    .flatMap((lit) => lit.slice(1, -1).split(/\s+/))
    .filter(Boolean)
    .filter((token) => {
      const variantes = token.split(':').slice(0, -1);
      return !variantes.some((v) => VARIANTE_POR_ESTADO.test(v));
    })
    .map((token) => token.split(':').pop() as string);
}

describe('/login: nada sobre la línea de flote nace transparente', () => {
  const fuente = readFileSync(FUENTE, 'utf8');

  it('no aplica al montar ninguna clase de opacidad cero', () => {
    const culpables = clasesDeMontaje(fuente).filter((c) => OPACIDAD_CERO.test(c));
    expect(
      culpables,
      `clases que dejan el primer pintado sin contenido: ${culpables.join(', ')}`
    ).toEqual([]);
  });

  it('tampoco arranca en opacidad cero por `motion` ni por estilo inline', () => {
    const codigo = sinComentarios(fuente);
    expect(/initial=\{\{[^}]*opacity:\s*0/.test(codigo)).toBe(false);
    expect(/opacity:\s*['"]?0['"]?\s*[,}]/.test(codigo)).toBe(false);
  });

  /**
   * El guard tiene que fallar con la regresión real y NO con el uso legítimo.
   * Sin esto, un cambio que rompa `clasesDeMontaje` deja los dos tests de arriba
   * en verde por vacuidad — que es exactamente cómo se ve un guard que no mira.
   */
  it('atrapa la regresión, y deja pasar la variante por estado y la prosa', () => {
    const regresion = `const ENTRADA = 'animate-in fade-in fill-mode-both';`;
    expect(clasesDeMontaje(regresion).filter((c) => OPACIDAD_CERO.test(c))).toEqual(['fade-in']);

    const legitimo = `className="data-open:animate-in data-open:fade-in-0 data-closed:fade-out-0"`;
    expect(clasesDeMontaje(legitimo).filter((c) => OPACIDAD_CERO.test(c))).toEqual([]);

    const escondite = `className="lg:fade-in"`;
    expect(clasesDeMontaje(escondite).filter((c) => OPACIDAD_CERO.test(c))).toEqual(['fade-in']);

    const prosa = '/** el `fade-in` de antes dejaba `opacity-0` al montar */';
    expect(clasesDeMontaje(prosa).filter((c) => OPACIDAD_CERO.test(c))).toEqual([]);
  });
});
