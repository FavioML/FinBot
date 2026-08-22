import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * Ninguna pantalla de entrada puede pintar su primera vista vacía de contenido.
 *
 * Chrome no cuenta como *contentful* lo que está totalmente transparente. Mientras lo que
 * ocupa la primera pantalla siga en `opacity: 0`, el navegador pinta el fondo y nada más:
 * el `first-contentful-paint` llega tarde, o no llega y PageSpeed aborta con `NO_FCP`.
 *
 * Este guard nació el 22-ago-2026 mirando SOLO `login/page.tsx`, donde una clase `fade-in`
 * de CSS dejaba la tarjeta invisible 600ms. En su propio docblock quedó anotado el hueco que
 * dejaba abierto: «las pantallas de `join` y `onboarding` tienen `initial` de `motion` con
 * opacidad cero, que es la misma clase de problema por otro mecanismo. NO están medidas».
 *
 * Se midieron, y el hueco era peor que el bug original. `motion` no puede devolverle la
 * opacidad a nada hasta que su bundle baje, parsee e hidrate, así que el blanco no duraba
 * 600ms fijos: duraba lo que tardara la hidratación. Contra producción, 5 corridas móviles
 * (412×823, 1.6 Mbps, CPU 4×):
 *
 *   /join/gasto  first-paint 1780ms → FCP 2888ms   gap de 1108-1196ms, 5 de 5
 *   /login       first-paint 1648ms → FCP 1648ms   gap 0ms, 5 de 5
 *
 * De ahí que el alcance ya no sea un archivo. Un invariante que sólo se verifica donde ya
 * explotó no es un invariante: es una cicatriz.
 *
 * QUÉ MIRA Y QUÉ NO
 *
 * - Barre las pantallas de entrada en FRÍO: todo `page.tsx` de `src/app` que no cuelgue de
 *   `dashboard/` ni de `admin/`. El alcance se DERIVA del árbol, así que una ruta pública
 *   nueva entra sola. Si la derivación se rompe, el primer test falla en vez de dejar los
 *   demás verdes por vacuidad.
 * - `dashboard/` y `admin/` quedan fuera a propósito, y no por ser menos importantes: ahí
 *   `initial={{ opacity: 0 }}` es legítimo y abunda, porque son paneles y filas que montan
 *   cuando el usuario los abre, no en la primera pintada. Prohibirlo ahí daría falsos
 *   positivos, y un guard que grita se termina apagando.
 * - Es estático: lee el archivo, no el pintado. Lo que de verdad prueba el invariante es
 *   medir el FCP contra producción después del deploy — con `first-paint` al lado, porque
 *   el número que delata es la DISTANCIA entre los dos, no el FCP solo.
 */

const APP = join(process.cwd(), 'src', 'app');
const GATEADAS = ['dashboard', 'admin'];

/** Todo `page.tsx` que un visitante puede abrir sin sesión previa. */
function pantallasDeEntrada(dir = APP): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const ruta = join(dir, e.name);
    if (e.isDirectory()) {
      return GATEADAS.includes(e.name) && dir === APP ? [] : pantallasDeEntrada(ruta);
    }
    return e.name === 'page.tsx' ? [ruta] : [];
  });
}

/**
 * Los comentarios NO son código. Este mismo archivo, y el docblock de `lib/entrada.ts`,
 * nombran las clases culpables entre backticks: sin este paso el guard se dispararía con su
 * propia documentación, que es la versión más tonta de un guard que no mira lo que dice mirar.
 */
function sinComentarios(codigo: string): string {
  return codigo.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
}

/** Clases de Tailwind/tw-animate-css que dejan un elemento totalmente transparente. */
const OPACIDAD_CERO = /^(fade-in(-0)?|opacity-0)$/;

/**
 * Variantes que NO son "al montar": la clase se aplica cuando cambia un estado.
 * `data-open:fade-in-0` es correcto y abunda en `components/ui/` — se dispara cuando un
 * diálogo se abre, no en la primera pintada. La clase pelada, no. Las de breakpoint (`lg:`,
 * `md:`) sí montan, así que no entran acá a propósito: una tarjeta transparente sólo en
 * desktop sigue rompiendo el FCP de desktop.
 */
const VARIANTE_POR_ESTADO = /^(data-|group-|peer-|aria-|hover|focus|active|open|closed)/;

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

/**
 * Las tres formas de nacer invisible: clase de CSS, `initial` de `motion`, estilo inline.
 *
 * Los dos últimos se anclan a SU atributo (`initial=`, `style=`) y no a un `opacity: 0`
 * suelto, porque lo que decide no es el valor cero: es CUÁNDO se aplica. `animate={{opacity:
 * 0}}` y `exit={{opacity: 0}}` también dicen `opacity: 0` y son correctos — animan HACIA
 * cero, con el elemento ya pintado. Un detector suelto los marcaba a los dos, y de paso
 * marcaba el `initial` de `motion` dos veces, dando la razón correcta por la vía equivocada.
 */
function culpables(codigo: string): string[] {
  const limpio = sinComentarios(codigo);
  const hallazgos = clasesDeMontaje(codigo).filter((c) => OPACIDAD_CERO.test(c));
  if (/initial=\{\{[^}]*opacity:\s*0/.test(limpio)) hallazgos.push('motion initial opacity:0');
  if (/style=\{\{[^}]*opacity:\s*0/.test(limpio)) hallazgos.push('estilo inline opacity:0');
  return hallazgos;
}

const PANTALLAS = pantallasDeEntrada();
const ruta = (p: string) => relative(APP, p).split(sep).join('/');

describe('nada sobre la línea de flote nace transparente', () => {
  /**
   * Sin esto, un cambio que rompa `pantallasDeEntrada` (un rename de carpeta, un cwd
   * distinto) deja el barrido corriendo sobre una lista vacía y todo verde.
   */
  it('deriva el alcance del árbol y encuentra las pantallas que ya conocemos', () => {
    const encontradas = PANTALLAS.map(ruta);
    expect(encontradas).toEqual(
      expect.arrayContaining([
        'login/page.tsx',
        'onboarding/page.tsx',
        'join/gasto/[code]/page.tsx',
        'join/deuda/[code]/page.tsx',
        'join/meta/[code]/page.tsx',
        'join/space/[code]/page.tsx',
        'activar/page.tsx',
      ])
    );
    expect(encontradas.some((r) => r.startsWith('dashboard/'))).toBe(false);
    expect(encontradas.some((r) => r.startsWith('admin/'))).toBe(false);
  });

  it.each(PANTALLAS.map((p) => [ruta(p), p]))(
    '%s no arranca en opacidad cero',
    (nombre, archivo) => {
      const hallazgos = culpables(readFileSync(archivo, 'utf8'));
      expect(
        hallazgos,
        `${nombre} deja el primer pintado sin contenido: ${hallazgos.join(', ')}`
      ).toEqual([]);
    }
  );

  /**
   * El guard tiene que fallar con la regresión REAL y no con el uso legítimo. Sin esto, un
   * cambio que rompa `clasesDeMontaje` o `culpables` deja el barrido de arriba en verde por
   * vacuidad — que es exactamente cómo se ve un guard que no mira nada.
   */
  it('atrapa las tres formas de la regresión, y deja pasar lo legítimo', () => {
    // Las dos que de verdad pasaron en este repo, tal cual estaban escritas.
    expect(culpables(`const ENTRADA = 'animate-in fade-in fill-mode-both';`)).toEqual(['fade-in']);
    expect(
      culpables(`<motion.div className="w-full max-w-sm"
        initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} />`)
    ).toEqual(['motion initial opacity:0']);
    expect(culpables(`<div style={{ opacity: 0 }} />`)).toEqual(['estilo inline opacity:0']);

    // Lo legítimo NO se rechaza — y por la razón correcta, no por otra condición.
    expect(culpables(`className="data-open:animate-in data-open:fade-in-0 data-closed:fade-out-0"`)).toEqual([]);
    expect(culpables(`className="opacity-0 group-hover:opacity-100"`)).toEqual(['opacity-0']);
    expect(culpables(`className="group-hover:opacity-0"`)).toEqual([]);
    expect(culpables(`animate={{ opacity: 0 }}`)).toEqual([]);
    expect(culpables(`exit={{ opacity: 0 }}`)).toEqual([]);

    // Un escondite que sí monta: la variante de breakpoint no salva la clase.
    expect(culpables(`className="lg:fade-in"`)).toEqual(['fade-in']);

    // La prosa que documenta el bug no es el bug.
    expect(culpables('/** el `fade-in` de antes dejaba `opacity-0` al montar */')).toEqual([]);
    expect(culpables('// initial={{ opacity: 0 }} era el wrapper viejo')).toEqual([]);
  });
});
