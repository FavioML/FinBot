import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Ningún texto de la webapp por debajo de 12px.
 *
 * POR QUÉ EXISTE (13-oct-2026)
 *
 * La webapp se usa como app en el celular. Medido en producción a 390 px el 12-oct: había texto a
 * 9px (el contador de la campana), 10px (111 usos, Planes y Presupuestos) y 11px (la barra
 * inferior, visible en todas las pantallas). Se subió todo a 12px como piso (`text-xs`), y el
 * `text-sm` de lectura pasa de 14 a 15px en celular (`--text-sm` en `globals.css`, bajo `md`).
 *
 * QUÉ MIRA, sobre cada `.ts`, `.tsx` y `.css` de `src/` (no los tests):
 *
 * 1. Tamaños arbitrarios de Tailwind: `text-[10px]`, `text-[0.6rem]`, `text-[0.7em]`.
 * 2. `fontSize` en JS: los ticks de Recharts (`tick={{ fontSize: 10 }}`), `fontSize={11}`,
 *    `style={{ fontSize: '10px' }}`.
 * 3. `font-size` en CSS y los tokens `--text-*` del tema.
 * 4. La excepción: `text-badge` (11px) es SOLO para el número de un contador sobre un ícono, y sólo
 *    en los archivos de `USOS_BADGE`. Agregar uno es una decisión: el contador no se lee como texto,
 *    una etiqueta sí.
 *
 * LÍMITES DECLARADOS
 *
 * - Un tamaño que llega por variable (`fontSize: tam`) o se calcula (`calc()`, `clamp()`) no se ve.
 * - `scale-*` o un `transform` que encoge texto tampoco.
 * - Los tamaños por defecto de una librería (Recharts sin `fontSize` usa 14px, Sonner los suyos).
 * Para eso está la medición en navegador: `products/neto/docs/paleta-neto-capturas.mjs` imprime los
 * caracteres por tamaño de cada pantalla y lista todo lo que quede bajo 12px.
 *
 * SI ESTE TEST TE FRENA: usa `text-xs` (12px) o más. Si es el número de un contador, `text-badge` y
 * agrega el archivo a `USOS_BADGE` con el motivo.
 */

const SRC = join(process.cwd(), 'src');
const PISO_PX = 12;
const USOS_BADGE: Record<string, string> = {
  'components/dashboard/notification-bell.tsx': 'el "9+" de no leídas sobre la campana',
};

function archivos(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return archivos(p);
    return /\.(tsx?|css)$/.test(n) && !/\.test\.tsx?$/.test(n) ? [p] : [];
  });
}

const aPx = (n: string, u = 'px') => Number(n) * (u === 'px' ? 1 : 16);

/** Tamaños bajo el piso en un texto fuente. Exportado para probar el detector. */
export function tamanosChicos(src: string, esCss: boolean): string[] {
  const out: string[] = [];
  const ver = (m: RegExpMatchArray, n: string, u?: string) => {
    if (aPx(n, u) < PISO_PX) out.push(m[0]);
  };
  for (const m of src.matchAll(/(?<![\w-])text-\[(\d*\.?\d+)(px|rem|em)\]/g)) ver(m, m[1], m[2]);
  for (const m of src.matchAll(/fontSize\s*[:=]\s*\{?\s*['"`]?(\d*\.?\d+)(px|rem|em)?/g)) ver(m, m[1], m[2]);
  if (esCss) {
    for (const m of src.matchAll(/font-size\s*:\s*(\d*\.?\d+)(px|rem|em)/g)) ver(m, m[1], m[2]);
    for (const m of src.matchAll(/--text-([a-z0-9-]+)\s*:\s*(\d*\.?\d+)(px|rem|em)/g)) {
      if (m[1] === 'badge' || m[1].endsWith('--line-height')) continue;
      ver(m, m[2], m[3]);
    }
  }
  return out;
}

const todos = archivos(SRC).map((p) => ({ rel: relative(SRC, p).replace(/\\/g, '/'), src: readFileSync(p, 'utf8') }));

describe('letra mínima de 12px', () => {
  it('ningún archivo de src/ declara texto bajo 12px', () => {
    const hallazgos = todos.flatMap(({ rel, src }) => tamanosChicos(src, rel.endsWith('.css')).map((t) => `${rel}: ${t}`));
    expect(hallazgos).toEqual([]);
  });

  it('text-badge sólo en los contadores declarados', () => {
    const usos = todos.filter(({ src }) => /(?<![\w-])text-badge(?![\w-])/.test(src)).map(({ rel }) => rel);
    expect(usos.sort()).toEqual(Object.keys(USOS_BADGE).sort());
  });

  it('el token del badge es de 10-11px y el text-sm sube a 15px en celular', () => {
    const css = todos.find(({ rel }) => rel === 'app/globals.css')!.src;
    const badge = css.match(/--text-badge\s*:\s*(\d*\.?\d+)rem/);
    expect(badge).not.toBeNull();
    expect(aPx(badge![1], 'rem')).toBeGreaterThanOrEqual(10);
    expect(css).toMatch(/@media \(width < 48rem\)\s*\{\s*:root\s*\{\s*--text-sm:\s*0\.9375rem;/);
  });

  it('el detector ve las formas que dice ver', () => {
    const casos = [
      "className='text-[10px]'",
      'className="sm:text-[11px]"',
      "className='text-[0.6rem]'",
      'tick={{ fill: "x", fontSize: 10 }}',
      'fontSize={11}',
      "style={{ fontSize: '9px' }}",
    ];
    for (const c of casos) expect(tamanosChicos(c, false), c).toHaveLength(1);
    expect(tamanosChicos('.a { font-size: 10px; }', true)).toHaveLength(1);
    expect(tamanosChicos('--text-mini: 0.625rem;', true)).toHaveLength(1);
    for (const c of ['text-[12px]', 'text-[12.5px]', 'text-[0.8rem]', 'fontSize: 12', "fontSize: '14px'", 'text-[40px]']) {
      expect(tamanosChicos(c, false), c).toEqual([]);
    }
  });
});
