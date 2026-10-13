import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

/**
 * Ningún color escrito a mano en `src/`: todo sale de los tokens de `globals.css`.
 *
 * POR QUÉ EXISTE (12-oct-2026)
 *
 * La webapp tenía 2,640 hex literales en 109 de 149 componentes, más ~640 `rgba(...)` y ~280
 * `text-white`/`bg-black/NN`. Con eso no se podía tener un modo claro: no había un lugar único
 * donde cambiar la paleta, y cada color nuevo se copiaba del vecino. Se migró todo a tokens
 * semánticos (paleta B) y este archivo impide que vuelva a crecer.
 *
 * QUÉ CUENTA COMO COLOR A MANO
 *
 * - un hex (`#1D9E75`, `#fff`, `#F0EFE840`), en clase, `style`, prop de Recharts o constante;
 * - una función de color: `rgb(`, `hsl(`, `oklch(`, `oklab(`, `lab(`, `lch(`, `hwb(`, `color(`
 *   (`color-mix(` sí vale: es como se le pone alfa a un token);
 * - un color con nombre como valor (`fill="white"`, `color: 'red'`, `bg-[white]`);
 * - `text-white`, `bg-black/60` y la paleta de Tailwind (`text-red-400`, `bg-olive-500`). Las
 *   paletas se leen de `tailwindcss/theme.css`, así una versión nueva que agregue otra no se cuela.
 *
 * Barre `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs` y `.css` de `src/` salvo `globals.css` (donde viven
 * los tokens) y los `*.test.ts` (lo único que corre vitest). Los comentarios se quitan con el
 * parser de TypeScript, no con una regex: un `accept="image/*"` en un string se comía el código
 * hasta el siguiente `*\/` (lo encontró la revisión adversarial del 12-oct).
 *
 * LÍMITE DECLARADO: un color armado en tiempo de ejecución (`'#' + '1D9E75'`) no se ve. Una regex
 * no puede, y perseguirlo no vale lo que cuesta.
 *
 * SI ESTE TEST TE FRENA
 *
 * Usa un token: `text-muted-foreground`, `bg-positive/15 text-positive-ink`, `var(--negative)` en
 * JS; para alfa en JS, `conAlfa()` y `tinta()` de `lib/colores.ts`. Si de verdad no puede ser un
 * token (la marca de un tercero, un archivo que renderiza sin globals.css), agrégalo a EXCEPCIONES
 * anclado a su uso exacto. Una excepción exime SOLO el tramo que matchea, y una que deja de
 * matchear rompe el test.
 */

const SRC = join(process.cwd(), 'src');

type Excepcion = { archivo: string; patron: RegExp; motivo: string };

export const EXCEPCIONES: Excepcion[] = [
  { archivo: 'lib/tema.ts', patron: /THEME_COLOR: Record<TemaResuelto, string> = \{ light: '#EDF5F0', dark: '#07120E' \}/, motivo: 'theme-color de la barra del navegador: va en <meta>, donde no hay var(). tema.test.ts lo ata a --background.' },
  { archivo: 'app/global-error.tsx', patron: /light-dark\(#(?:EDF5F0, #07120E|0A1D15, #EEF8F3|486155, #9DBAAC|117C59, #3BE0A6|FFFFFF, #03211A)\)/, motivo: 'reemplaza al root layout: no carga globals.css ni el script de tema. Son los pares exactos de la paleta B.' },
  { archivo: 'app/login/page.tsx', patron: /viewBox="0 0 24 24" fill="#25D366"/, motivo: 'logo de WhatsApp: color de marca de un tercero.' },
  { archivo: 'components/dashboard/welcome-modal.tsx', patron: /iconColor: '#(?:25D366|4285F4)'/, motivo: 'íconos de WhatsApp y Gmail: colores de marca de terceros.' },
  { archivo: 'app/admin/operacion/page.tsx', patron: /whatsapp: 'bg-\[#25D366\]\/15 text-foreground'/, motivo: 'pastilla de origen "whatsapp": tinte de la marca (el texto va en token).' },
];

const PALETAS = [
  ...new Set(
    [...readFileSync(join(process.cwd(), 'node_modules/tailwindcss/theme.css'), 'utf8').matchAll(/--color-([a-z]+)-\d+:/g)].map((m) => m[1]),
  ),
];
const NOMBRES = 'white|black|red|green|blue|yellow|orange|purple|pink|gray|grey|brown|cyan|magenta|lime|navy|teal|olive|maroon|silver|gold|indigo|violet|rebeccapurple|crimson|coral|salmon|tomato';
const PREFIJOS = String.raw`(?:text|bg|border(?:-[trblxyse])?|ring(?:-offset)?|inset-ring|inset-shadow|divide|from|to|via|fill|stroke|outline|decoration|placeholder|caret|accent|shadow|drop-shadow|text-shadow)`;

const PATRONES: RegExp[] = [
  // hex: no precedido de letra/dígito (`&#9733;` es una entidad, `a#123` es una URL)
  /(?<![&0-9A-Za-z])#(?:[0-9A-Fa-f]{8}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{3,4})(?![0-9A-Za-z-])/g,
  // funciones de color (CSS no distingue mayúsculas); `_` vale como separador de Tailwind
  /(?<![A-Za-z0-9-])(?:rgba?|hsla?|oklch|oklab|lab|lch|hwb|color)\(/gi,
  // color con nombre como valor de un prop/estilo de color
  new RegExp(String.raw`\b(?:fill|stroke|stopColor|color|background|backgroundColor|border(?:Top|Right|Bottom|Left)?Color|outlineColor|textDecorationColor|caretColor|fillStyle|strokeStyle)\s*[:=]\s*\{?\s*(["'\`])(?:${NOMBRES})\1`, 'gi'),
  // nombre dentro de un valor arbitrario de Tailwind o de un color-mix
  new RegExp(String.raw`-\[(?:color:)?(?:${NOMBRES})\]|_(?:${NOMBRES})\]|color-mix\([^)]*?\b(?:${NOMBRES})\b`, 'gi'),
  // utilidades de Tailwind con blanco/negro o una paleta
  new RegExp(String.raw`(?<![\w-])${PREFIJOS}-(?:white|black)(?![\w-])`, 'g'),
  new RegExp(String.raw`(?<![\w-])${PREFIJOS}-(?:${PALETAS.join('|')})-\d{2,3}(?![\w-])`, 'g'),
];

const borrarConservandoLineas = (s: string) => s.replace(/[^\n]/g, ' ');

/** Quita comentarios conservando posiciones y saltos de línea. TS/JS con el parser; CSS con regex. */
export function sinComentarios(src: string, archivo: string): string {
  if (archivo.endsWith('.css')) return src.replace(/\/\*[\s\S]*?\*\//g, borrarConservandoLineas);
  const kind = /\.(tsx|jsx)$/.test(archivo) ? ts.ScriptKind.TSX : /\.m?js$/.test(archivo) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(archivo, src, ts.ScriptTarget.Latest, true, kind);
  const out = src.split('');
  const visitar = (n: ts.Node) => {
    // Un `//` dentro del texto de JSX es texto, no un comentario.
    // La trivia en `n.pos` es de `n`. TS la parte en "trailing" (hasta el primer salto de línea,
    // que `getLeadingCommentRanges` NO devuelve) y "leading" (desde ahí): hacen falta las dos.
    if (n.kind !== ts.SyntaxKind.JsxText) {
      const rangos = [...(ts.getTrailingCommentRanges(src, n.pos) ?? []), ...(ts.getLeadingCommentRanges(src, n.pos) ?? [])];
      for (const r of rangos) {
        for (let i = r.pos; i < r.end; i++) if (out[i] !== '\n') out[i] = ' ';
      }
    }
    n.getChildren(sf).forEach(visitar);
  };
  visitar(sf);
  return out.join('');
}

/** Tramos [inicio, fin) de la línea que cubre alguna excepción de este archivo. */
function tramosExentos(rel: string, linea: string): Array<[number, number]> {
  return EXCEPCIONES.filter((e) => e.archivo === rel).flatMap((e) =>
    [...linea.matchAll(new RegExp(e.patron.source, 'g'))].map((m) => [m.index!, m.index! + m[0].length] as [number, number]),
  );
}

export function hallazgos(rel: string, src: string): string[] {
  const out: string[] = [];
  sinComentarios(src, rel)
    .split('\n')
    .forEach((linea, i) => {
      const exentos = tramosExentos(rel, linea);
      for (const patron of PATRONES) {
        for (const m of linea.matchAll(patron)) {
          const ini = m.index!;
          const exenta = exentos.some(([a, b]) => ini >= a && ini + m[0].length <= b);
          if (!exenta) out.push(`${rel}:${i + 1} — ${m[0]}`);
        }
      }
    });
  return out;
}

function archivos(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return archivos(p);
    if (!/\.(m?[jt]sx?|css)$/i.test(n) || /\.test\.ts$/.test(n) || n.endsWith('.d.ts') || n === 'globals.css') return [];
    return [p];
  });
}

const rel = (p: string) => relative(SRC, p).split('\\').join('/');
const TODOS = archivos(SRC);

describe('colores por token', () => {
  it('el barrido ve el árbol entero (antivacuidad)', () => {
    const rels = TODOS.map(rel);
    expect(rels.length).toBeGreaterThan(150);
    for (const esperado of ['components/dashboard/kpi-cards.tsx', 'app/admin/operacion/page.tsx', 'app/login/page.tsx', 'lib/budget-status.ts']) {
      expect(rels).toContain(esperado);
    }
    // Las paletas salen de Tailwind: si theme.css cambiara de forma y la lista quedara vacía,
    // el patrón de paletas no detectaría nada.
    expect(PALETAS).toEqual(expect.arrayContaining(['red', 'amber', 'neutral', 'olive']));
  });

  it('ningún archivo de src/ escribe un color a mano', () => {
    const todos = TODOS.flatMap((p) => hallazgos(rel(p), readFileSync(p, 'utf8')));
    expect(todos, `Colores escritos a mano (usa un token de globals.css):\n${todos.join('\n')}`).toEqual([]);
    // Parsear ~200 archivos con TypeScript tarda de 1 a 6 s según la carga de la suite completa.
  }, 30_000);

  it('cada excepción sigue haciendo falta', () => {
    for (const e of EXCEPCIONES) {
      const src = sinComentarios(readFileSync(join(SRC, e.archivo), 'utf8'), e.archivo);
      expect(e.patron.test(src), `${e.archivo}: la excepción ya no matchea nada — bórrala`).toBe(true);
    }
  });

  it('detecta las formas que tiene que detectar', () => {
    const casos = [
      'className="text-[#123456]"',
      "style={{ color: '#abc' }}",
      "const X = '#1D9E75';",
      'tick={{ fill: "#F0EFE840" }}',
      'const s = `0 0 4px rgba(0,0,0,.5)`;',
      'className="shadow-[0_8px_24px_rgba(0,0,0,0.35)]"',
      'className="shadow-[0_0_0_1px_#fff]"',
      "style={{ color: 'oklch(0.7 0.15 160)' }}",
      "style={{ outlineColor: 'RGBA(0,0,0,.4)' }}",
      'className="bg-black/60"',
      'className="text-white"',
      'className="ring-offset-white"',
      'className="text-red-400"',
      'className="bg-olive-500"',
      'className="border-s-red-500"',
      'className="hover:bg-amber-500/15"',
      'className="text-[white]"',
      '<Icon fill="white" stroke="black" />',
      "style={{ borderColor: 'red' }}",
      "const m = 'color-mix(in srgb, white 50%, transparent)';",
    ];
    for (const c of casos) expect(hallazgos('x.tsx', c), c).not.toEqual([]);
  });

  it('un /* o un // que no son comentarios no esconden código', () => {
    const casos = [
      `<input accept="image/*" />\n<p style={{ color: '#ff0000' }} />\n{/* fin */}`,
      `const sep = 'a//b'; const C = '#ff0000';`,
      `const el = <span>Hoy // mañana<b style={{ color: '#ff0000' }} /></span>;`,
    ];
    for (const c of casos) expect(hallazgos('x.tsx', c), c).not.toEqual([]);
  });

  it('no confunde lo que no es un color', () => {
    const casos = [
      '// React #310 rompió el render',
      '/* el elevado (#1C1C19) */',
      'const a = 1; {/* un #fff en un comentario de JSX */}',
      '<span>&#9733;</span>',
      'href="#perfil"',
      'const id = `url(#${gradId})`;',
      'className="text-foreground bg-card/50 text-positive-ink"',
      "const url = 'https://x.dev/a#123';",
      "const fondo = 'color-mix(in srgb, var(--primary) 12%, transparent)';",
      'const textColor = useColor(x);',
    ];
    for (const c of casos) expect(hallazgos('x.tsx', c), c).toEqual([]);
  });

  it('una excepción exime su tramo, no la línea', () => {
    const linea = `<svg width="20" height="20" viewBox="0 0 24 24" fill="#25D366" stroke="#ff0000">`;
    expect(hallazgos('app/login/page.tsx', linea)).toEqual(['app/login/page.tsx:1 — #ff0000']);
  });
});
