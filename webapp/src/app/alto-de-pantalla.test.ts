import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * Ninguna altura se mide en `vh`.
 *
 * En iOS (Safari, Brave, Chrome: todos son WebKit) `vh` vale el viewport GRANDE, el de las
 * barras del navegador escondidas, mientras que `position: fixed` se ubica en el área que se
 * VE con las barras puestas. El diálogo de Nuevo gasto llevaba `max-h-[92vh]` desde abril: en
 * un iPhone con las dos barras de Brave visibles medía ~733 px sobre ~648 visibles, centrado,
 * así que el título quedaba arriba de la pantalla y el pie con "Registrar" abajo, y el scroll
 * interno no los alcanzaba porque el pie es `sticky` al borde del propio diálogo (19-oct-2026,
 * lo reportó Favio desde su celular).
 *
 * Ningún navegador de escritorio ni la emulación móvil de Chromium lo ven: ahí `vh` es el alto
 * visible. Por eso el detector de `paleta-neto-capturas.mjs` y todas las capturas a 360/390
 * salían limpias. Lo que se ve en Chromium no prueba nada sobre esto; este test sí.
 *
 * Las unidades buenas: `dvh` para lo que se ajusta al alto que se ve (diálogos, sheets, el shell
 * del dashboard) y `svh` para mínimos de página, que así no saltan cuando la barra se esconde.
 *
 * Es estático: lee clases y estilos, no el pintado. Los comentarios no cuentan (este archivo y
 * algunos docblocks nombran las clases culpables).
 */

const SRC = join(process.cwd(), 'src');

function archivos(dir = SRC): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const ruta = join(dir, e.name);
    if (e.isDirectory()) return archivos(ruta);
    if (/\.test\.tsx?$/.test(e.name)) return [];
    return /\.(tsx?|css)$/.test(e.name) ? [ruta] : [];
  });
}

function sinComentarios(codigo: string): string {
  return codigo.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
}

/** `92vh`, `100vh`, `h-screen`, `min-h-screen`, `max-h-screen`. No `dvh`/`svh`/`lvh`. */
const ALTURA_EN_VH = /(?<![a-z])\d*\.?\d+vh\b|(?<![\w-])(?:min-|max-)?h-screen\b/g;

describe('alto de pantalla', () => {
  const lista = archivos();

  it('barre el árbol (antivacuidad)', () => {
    expect(lista.length).toBeGreaterThan(100);
    expect(lista.some((f) => f.endsWith(`components${sep}ui${sep}dialog.tsx`))).toBe(true);
  });

  it('ninguna altura usa vh ni h-screen', () => {
    const hallazgos = lista.flatMap((f) =>
      [...sinComentarios(readFileSync(f, 'utf8')).matchAll(ALTURA_EN_VH)].map(
        (m) => `${relative(SRC, f)}: ${m[0]}`,
      ),
    );
    expect(hallazgos).toEqual([]);
  });

  it('el patrón ve las formas que se usaban y deja pasar dvh/svh', () => {
    const ve = (s: string) => [...s.matchAll(ALTURA_EN_VH)].map((m) => m[0]);
    expect(ve('max-h-[92vh] min-h-[60vh] h-screen min-h-screen lg:max-h-[calc(100vh-7rem)]')).toEqual([
      '92vh', '60vh', 'h-screen', 'min-h-screen', '100vh',
    ]);
    expect(ve("minHeight: '100vh'")).toEqual(['100vh']);
    expect(ve('max-h-[92dvh] min-h-svh h-dvh max-h-[calc(100dvh-2rem)] min-h-[60svh]')).toEqual([]);
  });

  it('DialogContent nunca pasa del alto visible y scrollea por dentro', () => {
    const dialog = readFileSync(join(SRC, 'components', 'ui', 'dialog.tsx'), 'utf8');
    const popup = dialog.match(/data-slot="dialog-content"[\s\S]*?className=\{cn\(\s*"([^"]+)"/);
    expect(popup, 'no encontré las clases base de DialogContent').not.toBeNull();
    const clases = popup![1].split(/\s+/);
    expect(clases).toContain('max-h-[calc(100dvh-2rem)]');
    expect(clases).toContain('overflow-y-auto');
  });
});
