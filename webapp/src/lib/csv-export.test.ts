import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { toCsv } from './csv-export';

/**
 * Dos guards del export CSV, y el segundo es el que importa.
 *
 * EL DEFECTO (F5, auditoría 10-ago-2026). `admin/operacion` armaba su CSV a mano y le hacía
 * `.replace()` a cada celda. `usuarios.whatsapp` es NULLABLE desde la identidad dual (migración
 * 046: quien nace en la web no tiene número; hay dos así en prod), así que el export moría con
 * un TypeError y **no bajaba ningún archivo** — no fallaba la columna, fallaba el CSV entero.
 * El compilador no lo veía porque `AdminUser.whatsapp` estaba tipado `string` (F9), justo en la
 * columna que la identidad dual volvió nullable.
 *
 * Arreglar la instancia es una línea. Lo que no arregla es la CLASE: el escape correcto ya
 * existía en `csv-export.ts` y la página lo había reimplementado igual. Por eso el segundo test
 * no mira el bug, mira la duplicación: quien vuelva a escribir un escape de CSV a mano rompe el
 * build, y el mensaje le dice dónde está la función que ya lo hace bien.
 */

const SRC = join(import.meta.dirname, '..');

// El escape a mano: la firma inconfundible de un CSV reimplementado. Se busca esta y no
// `new Blob([...text/csv])` porque el Blob es inofensivo (`downloadCsv` lo hace igual); lo que
// duele es el escape, que es donde vive el null.
const ESCAPE_A_MANO = /\.replace\(\s*\/"\/g\s*,\s*'""'\s*\)/;

/**
 * Los sitios que legítimamente contienen ese escape. Es una lista, no un patrón, por la misma
 * razón que el inventario de qa-e2e: un patrón de nombre lo evade quien elija otro nombre.
 *
 * · `lib/csv-export.ts` ES la implementación buena. Tiene que estar.
 * · `dashboard/transacciones/page.tsx` es el export del usuario, todavía a mano. Hoy no está
 *   roto —cada celda pasa por `(x || '')`, así que el null nunca llega al `.replace()`— pero
 *   depende de que quien agregue una columna se acuerde de ese `|| ''`. Migrarlo a `toCsv`
 *   quedó fuera del alcance de la Ola 2 (es otra pantalla y otro usuario); esta entrada existe
 *   para que la deuda esté escrita y no se descubra sola.
 */
const CSV_A_MANO_PERMITIDO = new Set([
  'lib/csv-export.ts',
  'app/dashboard/transacciones/page.tsx',
]);

function archivosFuente(dir: string, out: string[] = []): string[] {
  for (const entrada of readdirSync(dir)) {
    if (entrada === 'node_modules' || entrada.startsWith('.')) continue;
    const p = join(dir, entrada);
    if (statSync(p).isDirectory()) archivosFuente(p, out);
    else if (/\.tsx?$/.test(entrada) && !/\.test\.tsx?$/.test(entrada)) out.push(p);
  }
  return out;
}

describe('toCsv: el escape es null-safe', () => {
  it('una celda null o undefined sale vacía, no rompe', () => {
    // Es exactamente la forma de la fila que reventaba: un usuario web-first sin número.
    expect(toCsv(['a', 'b', 'c'], [[null, undefined, 'ok']])).toBe('a,b,c\r\n,,ok');
  });

  it('escapa comas, comillas y saltos de línea', () => {
    expect(toCsv(['x'], [['a,b']])).toBe('x\r\n"a,b"');
    expect(toCsv(['x'], [['di "hola"']])).toBe('x\r\n"di ""hola"""');
    expect(toCsv(['x'], [['dos\nlíneas']])).toBe('x\r\n"dos\nlíneas"');
  });

  it('no convierte los números a texto por el camino largo', () => {
    expect(toCsv(['n'], [[0]])).toBe('n\r\n0');
  });
});

describe('guard: nadie reimplementa el escape de CSV', () => {
  it('el escape a mano solo vive en los archivos declarados', () => {
    const archivos = archivosFuente(SRC);
    // Anti-vacuidad: si el barrido deja de ver archivos, todo pasaría verde.
    expect(archivos.length, 'el barrido no encontró fuentes').toBeGreaterThan(50);

    const infractores = archivos
      .filter((f) => ESCAPE_A_MANO.test(readFileSync(f, 'utf8')))
      .map((f) => relative(SRC, f).replace(/\\/g, '/'))
      .filter((f) => !CSV_A_MANO_PERMITIDO.has(f))
      .sort();

    expect(
      infractores,
      'Estos archivos escapan CSV a mano:\n' + infractores.map((f) => '  - ' + f).join('\n') +
      '\n\nUsá `toCsv` / `downloadCsv` de lib/csv-export.ts. El escape a mano se rompe con la ' +
      'primera celda null, y la mitad de las columnas de `usuarios` lo son desde la identidad ' +
      'dual: el resultado no es una celda fea, es que no baja ningún archivo (F5).',
    ).toEqual([]);
  });

  it('la lista de permitidos no tiene entradas muertas', () => {
    // Una excepción que ya no aplica invita a la próxima sesión a razonar sobre algo que no
    // pasa, igual que en el guard de columnas del merge.
    const vivas = archivosFuente(SRC)
      .map((f) => relative(SRC, f).replace(/\\/g, '/'))
      .filter((f) => CSV_A_MANO_PERMITIDO.has(f))
      .filter((f) => ESCAPE_A_MANO.test(readFileSync(join(SRC, f), 'utf8')));

    expect([...CSV_A_MANO_PERMITIDO].filter((f) => !vivas.includes(f)).sort(),
      'entradas de CSV_A_MANO_PERMITIDO que ya no escapan a mano: sacalas').toEqual([]);
  });
});
