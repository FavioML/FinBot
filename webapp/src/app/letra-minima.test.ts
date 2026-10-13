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
 * QUÉ MIRA, sobre cada `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs` y `.css` de `src/` (no los tests):
 *
 * 1. Tamaños arbitrarios de Tailwind: `text-[10px]`, `text-[length:10px]`, `text-[0.6rem]`,
 *    `text-[x-small]`, con cualquier variante o modificador delante o detrás.
 * 2. `fontSize` en JS, con o sin comillas en la clave: los ticks de Recharts
 *    (`tick={{ fontSize: 10 }}`), `fontSize={11}`, `fontSize="10"`, `style={{ fontSize: '10px' }}` y
 *    CADA literal de la expresión (`fontSize: isMobile ? 10 : 12`). Un literal que multiplica o
 *    divide (`fontSize * 0.4`) no es un tamaño y no cuenta; `0` (ocultar los ticks) tampoco.
 * 3. CSS en cualquier archivo (también un string de HTML o un objeto con `'font-size'`):
 *    `font-size: 10px`, el shorthand `font: 600 10px/1 ...`, y en `.css` los tokens `--text-*`.
 * 4. Relativos que encogen: `em` bajo 1 y `%` bajo 100, y las palabras `small`, `x-small`,
 *    `xx-small`, `smaller`. Política, no medición: dependen del padre y acá no se pueden juzgar.
 *    Usa un tamaño de la escala.
 * 5. La excepción: `text-badge` / `--text-badge` (11px, nunca bajo 10) es SOLO para el número de
 *    un contador sobre un ícono, y sólo en los archivos de `USOS_BADGE`; en `globals.css` sólo se
 *    DECLARA. Agregar un uso es una decisión: el contador no se lee como texto, una etiqueta sí.
 *
 * LÍMITES DECLARADOS
 *
 * - Un tamaño que llega por variable (`fontSize: tam`, `` `text-${t}` ``) o se calcula (`calc()`,
 *   `clamp()`, `Math.max`) no se ve. Tampoco una variable CSS con otro nombre que `--text-*`.
 * - `scale-*` o un `transform` que encoge texto tampoco.
 * - Texto SVG en unidades de un `viewBox`: el literal se juzga como px aunque se dibuje escalado.
 *   Si hace falta, va en una constante con la cuenta del tamaño en pantalla (ver `score-gauge.tsx`).
 * - Un comentario que nombra un tamaño chico (`// antes era text-[10px]`) se cuenta: falso positivo
 *   aceptado, se reescribe el comentario.
 * - Los tamaños por defecto de una librería (Recharts sin `fontSize` usa 14px, Sonner los suyos).
 * Para todo eso está la medición en navegador: `products/neto/docs/paleta-neto-capturas.mjs` imprime
 * los caracteres por tamaño de cada pantalla y lista lo que quede bajo 12px.
 *
 * Atacado antes del push (13-oct): de 55 intentos de colar texto chico, 21 pasaban en verde con la
 * primera versión (ternarios en `fontSize`, `font:`, `text-[length:]`, `em`, `%`, `var(--text-badge)`
 * desde otro archivo, CSS dentro de strings, archivos `.js`). Los casos están en el último `it`.
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
    return /\.(tsx?|jsx?|mjs|css)$/.test(n) && !/\.test\.[jt]sx?$/.test(n) ? [p] : [];
  });
}

const PALABRAS_CHICAS = /^(?:xx-small|x-small|small|smaller)$/;

/** ¿Este valor de tamaño queda bajo el piso? `null` si no es un tamaño que se pueda juzgar. */
function esChico(valor: string): boolean | null {
  const v = valor.trim().replace(/^['"`]|['"`]$/g, '');
  if (PALABRAS_CHICAS.test(v)) return true;
  const m = v.match(/^(\d*\.?\d+)(px|rem|em|%)?$/);
  if (!m) return null;
  const n = Number(m[1]);
  switch (m[2]) {
    case 'rem': return n * 16 < PISO_PX;
    case 'em': return n < 1;
    case '%': return n < 100;
    default: return n > 0 && n < PISO_PX; // px o número suelto (`fontSize: 10`); 0 oculta
  }
}

/** Tamaños bajo el piso en un texto fuente. Exportado para probar el detector. */
export function tamanosChicos(src: string, esCss: boolean): string[] {
  const out: string[] = [];
  // 1. Tailwind arbitrario.
  for (const m of src.matchAll(/(?<![\w-])text-\[(?:length:)?([^\]\s]+)\]/g)) {
    if (esChico(m[1])) out.push(m[0]);
  }
  // 2. `fontSize` en JS: cada literal de la expresión, salvo los que multiplican o dividen.
  for (const m of src.matchAll(/['"]?fontSize['"]?\s*[:=]\s*\{?([^,}\n;]+)/g)) {
    for (const l of m[1].matchAll(/(^|[^\w.*/\s])\s*(['"`]?\d*\.?\d+(?:px|rem|em|%)?['"`]?)(?![\w.])/g)) {
      if (esChico(l[2])) out.push(m[0].trim());
    }
  }
  // 3. CSS en cualquier archivo: `font-size` y el shorthand `font`.
  for (const m of src.matchAll(/(?<![\w-])font-size['"]?\s*:\s*['"]?([^;'"}\n)]+)/g)) {
    if (esChico(m[1])) out.push(m[0]);
  }
  for (const m of src.matchAll(/(?<![\w-])['"]?font['"]?\s*:\s*['"`]?([^;'"`}\n]+)/g)) {
    // El tamaño es el primer token con unidad o palabra clave: `600 10px/1` lleva el peso delante.
    const tam = m[1].split(/\s+/).map((t) => t.split('/')[0]).find((t) => /(?:px|rem|em|%)$/.test(t) || PALABRAS_CHICAS.test(t));
    if (tam && esChico(tam)) out.push(m[0]);
  }
  // Tokens del tema: 12px de piso, salvo el del badge (10px de piso).
  if (esCss) {
    for (const m of src.matchAll(/--text-([a-z0-9]+(?:-[a-z0-9]+)*)\s*:\s*(\d*\.?\d+)(px|rem|em|%)/g)) {
      const px = m[3] === 'rem' ? Number(m[2]) * 16 : Number(m[2]);
      const chico = m[1] === 'badge' ? m[3] === 'em' || m[3] === '%' || px < 10 : esChico(m[2] + m[3]);
      if (chico) out.push(m[0]);
    }
  }
  return out;
}

/** Usos de `text-badge` en cualquier forma (clase, `var(--text-badge)`, `text-(length:--text-badge)`)
 * que no son su declaración en el tema. */
export function usosDeBadge(src: string): number {
  const todos = src.match(/text-badge/g)?.length ?? 0;
  const declaraciones = src.match(/--text-badge(?:--line-height)?\s*:/g)?.length ?? 0;
  return todos - declaraciones;
}

const todos = archivos(SRC).map((p) => ({ rel: relative(SRC, p).replace(/\\/g, '/'), src: readFileSync(p, 'utf8') }));

describe('letra mínima de 12px', () => {
  it('ningún archivo de src/ declara texto bajo 12px', () => {
    const hallazgos = todos.flatMap(({ rel, src }) => tamanosChicos(src, rel.endsWith('.css')).map((t) => `${rel}: ${t}`));
    expect(hallazgos).toEqual([]);
  });

  it('text-badge sólo en los contadores declarados', () => {
    const usos = todos.filter(({ src }) => usosDeBadge(src) > 0).map(({ rel }) => rel);
    expect(usos.sort()).toEqual(Object.keys(USOS_BADGE).sort());
  });

  it('el text-sm sube a 15px en celular', () => {
    const css = todos.find(({ rel }) => rel === 'app/globals.css')!.src;
    expect(css).toMatch(/@media \(width < 48rem\)\s*\{\s*:root\s*\{\s*--text-sm:\s*0\.9375rem;/);
  });

  it('el detector ve las formas que dice ver', () => {
    const chicos = [
      "className='text-[10px]'",
      'className="sm:text-[11px]"',
      'className="!text-[10px]/4"',
      "className='text-[0.6rem]'",
      "className='text-[length:10px]'",
      "className='text-[x-small]'",
      "className='text-[80%]'",
      "<sup className='text-[0.8em]'>50</sup>",
      'tick={{ fill: "x", fontSize: 10 }}',
      'tick={{ fontSize: isMobile ? 10 : 12 }}',
      '<text fontSize={compact ? 10 : 12}>',
      'fontSize={11}',
      'fontSize="10"',
      "style={{ fontSize: '9px' }}",
      '{ "fontSize": 10 }',
      "{ 'font-size': '10px' }",
      'const html = `<td style="font-size:10px">`',
      "style={{ font: '600 10px/1 var(--font-sans)' }}",
    ];
    for (const c of chicos) expect(tamanosChicos(c, false), c).not.toEqual([]);
    const cssChico = [
      '.a { font-size: 10px; }',
      '.a{font-size:.6rem}',
      '.a { font: 600 10px/1 x; }',
      '.a { font-size: 75%; }',
      '--text-mini: 0.625rem;',
      '@media (width < 48rem) { :root { --text-badge: 0.5rem; } }',
    ];
    for (const c of cssChico) expect(tamanosChicos(c, true), c).not.toEqual([]);
    const legitimos = [
      'text-[12px]', 'text-[12.5px]', 'text-[0.8rem]', 'text-[40px]', 'fontSize: 12', "fontSize: '14px'",
      'tick={{ fontSize: 0 }}', 'fontSize: fontSize * 0.4', 'fontSize: tam', 'font: inherit', 'fontFamily: x',
    ];
    for (const c of legitimos) expect(tamanosChicos(c, false), c).toEqual([]);
    const cssLegitimo = ['--text-badge: 0.6875rem;', '--text-badge--line-height: 1;', '.a { font-size: 0.75rem; }', '.a { font-weight: 600; }'];
    for (const c of cssLegitimo) expect(tamanosChicos(c, true), c).toEqual([]);
    expect(usosDeBadge('.x { font-size: var(--text-badge); }')).toBe(1);
    expect(usosDeBadge("className='text-(length:--text-badge)'")).toBe(1);
    expect(usosDeBadge('--text-badge: 0.6875rem;\n  --text-badge--line-height: 1;')).toBe(0);
  });
});
