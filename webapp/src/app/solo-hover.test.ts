import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Nada que se toque puede aparecer SOLO con hover.
 *
 * Editar y borrar una deuda, una meta, un gasto compartido o un gasto de espacio nacen en
 * `opacity-0` y se revelan con `group-hover:opacity-100`. Para el celular se agregó en su día
 * `max-sm:opacity-100`, que decide por el ANCHO y no por el puntero: un iPhone en horizontal mide
 * 844 px (más que `sm`, 640) y una tablet también, y ahí los botones quedaban invisibles. Un toque
 * a ciegas sobre un ícono invisible no es una interacción (19-oct-2026, auditoría de WebKit).
 *
 * La regla: si un elemento se esconde (`opacity-0` / `invisible`, con o sin variante delante) y se
 * revela con hover (`hover:`, `group-hover:` o `group-hover/nombre:`), también se revela con
 * `pointer-coarse:` (Tailwind 4, `@media (pointer: coarse)`).
 *
 * Cómo lee, y por qué así: la unidad es la EXPRESIÓN entera de cada `className` (el string, o las
 * llaves balanceadas de `className={...}`), partida en tokens. Emparejar comillas fallaba con
 * `cn("…", "opacity-0", "group-hover:…")`, con un ternario de comillas simples dentro de un template
 * y con un apóstrofo en un atributo anterior: la primera versión de este test pasaba verde con las
 * tres (revisión adversarial del mismo día, 10 evasiones de 11). En `.ts` no hay `className`: ahí
 * se mira cada string, que es donde vive una constante de clases reutilizada.
 */

const SRC = join(process.cwd(), 'src');

function archivos(dir = SRC): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const ruta = join(dir, e.name);
    if (e.isDirectory()) return archivos(ruta);
    return /\.tsx?$/.test(e.name) && !/\.test\./.test(e.name) ? [ruta] : [];
  });
}

/** Decorativo, declarado por archivo Y elemento: no se toca, así que no hace falta verlo con el dedo. */
const EXENTOS: Record<string, { elemento: string; motivo: string }> = {
  'components/dashboard/global-search.tsx': { elemento: 'ArrowRight', motivo: 'la flecha de un resultado; el botón es la fila entera' },
};

const ESCONDE = /^(?:[\w/[\]-]+:)*(?:opacity-0|invisible)$/;
const REVELA_HOVER = /^(?:[\w/[\]-]+:)*(?:group-hover(?:\/[\w-]+)?|hover):(?:opacity-100|visible)$/;
const REVELA_TACTIL = /^(?:[\w/[\]-]+:)*pointer-coarse:(?:opacity-100|visible)$/;

/** Cada `className` con el nombre del elemento que lo lleva. */
function classNames(codigo: string): { elemento: string; expr: string }[] {
  const salida: { elemento: string; expr: string }[] = [];
  for (const m of codigo.matchAll(/className=/g)) {
    const desde = m.index! + m[0].length;
    const abre = codigo[desde];
    let expr = '';
    if (abre === '"' || abre === "'") {
      expr = codigo.slice(desde + 1, codigo.indexOf(abre, desde + 1));
    } else if (abre === '{') {
      let prof = 0, i = desde;
      for (; i < codigo.length; i++) {
        if (codigo[i] === '{') prof++;
        else if (codigo[i] === '}' && --prof === 0) break;
      }
      expr = codigo.slice(desde + 1, i);
    } else continue;
    const elemento = codigo.slice(0, m.index).match(/<([A-Za-z][\w.]*)[^<]*$/)?.[1] ?? '?';
    salida.push({ elemento, expr });
  }
  return salida;
}

/** Las clases de una expresión, cada una con su prefijo de variantes (`sm:group-hover/card:opacity-100`). */
function clases(expr: string): string[] {
  return [...expr.matchAll(/[\w/[\]-]+(?::[\w/[\]-]+)*/g)].map((m) => m[0]);
}

function escondidoSoloConHover(expr: string): boolean {
  const cs = clases(expr);
  return cs.some((c) => ESCONDE.test(c)) && cs.some((c) => REVELA_HOVER.test(c)) && !cs.some((c) => REVELA_TACTIL.test(c));
}

describe('nada interactivo aparece solo con hover', () => {
  const lista = archivos();

  it('barre el árbol y encuentra los que había (antivacuidad)', () => {
    const conRevelado = lista.filter((f) =>
      classNames(readFileSync(f, 'utf8')).some(({ expr }) => clases(expr).some((c) => REVELA_HOVER.test(c))),
    );
    expect(conRevelado.length).toBeGreaterThanOrEqual(5);
  });

  it('todo revelado por hover se ve con puntero táctil', () => {
    const malos = lista.flatMap((f) => {
      const rel = relative(SRC, f).split('\\').join('/');
      const codigo = readFileSync(f, 'utf8');
      const exp = rel.endsWith('.tsx')
        ? classNames(codigo)
        : [...codigo.matchAll(/(["'`])((?:(?!\1)[^\\]|\\.)*)\1/g)].map((m) => ({ elemento: '(string)', expr: m[2] }));
      return exp
        .filter(({ elemento }) => EXENTOS[rel]?.elemento !== elemento)
        .filter(({ expr }) => escondidoSoloConHover(expr))
        .map(({ elemento, expr }) => `${rel} <${elemento}>: ${expr.replace(/\s+/g, ' ').slice(0, 100)}`);
    });
    expect(malos).toEqual([]);
  });

  it('ve las formas que evadían la primera versión, y deja pasar el arreglo', () => {
    const ve = (jsx: string) => classNames(jsx).filter(({ expr }) => escondidoSoloConHover(expr)).length;
    expect(ve('<div className="flex opacity-0 group-hover:opacity-100 max-sm:opacity-100">')).toBe(1);
    expect(ve('<div className={cn("flex", "opacity-0", "group-hover:opacity-100 max-sm:opacity-100")}>')).toBe(1);
    expect(ve("<div className={`a ${c ? 'sm:col-span-2' : 'b'} opacity-0 group-hover:opacity-100`}>")).toBe(1);
    expect(ve('<div className="opacity-0 group-hover/card:opacity-100">')).toBe(1);
    expect(ve('<div className="sm:opacity-0 sm:group-hover:opacity-100">')).toBe(1);
    expect(ve('<div className="opacity-0 hover:opacity-100">')).toBe(1);
    expect(ve('<div className="invisible group-hover:visible max-sm:visible">')).toBe(1);
    expect(ve(`<b title="de 'Deuda'" className="opacity-0 group-hover:opacity-100">`)).toBe(1);
    expect(ve('<div className={"a opacity-0 " +\n "group-hover:opacity-100"}>')).toBe(1);
    expect(ve('<div className="opacity-0 group-hover:opacity-100 pointer-coarse:opacity-100">')).toBe(0);
    expect(ve('<div className="opacity-50 group-hover:opacity-100">')).toBe(0);
    expect(classNames('<ArrowRight className="x" />')[0].elemento).toBe('ArrowRight');
  });
});
