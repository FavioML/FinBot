import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { esSubSinClasificar, subcategoriaUtil, SUB_SENTINEL_REVISAR } from './subcategoria';

/**
 * Guard contra el falso negativo que produjo este bug.
 *
 * `transacciones.subcategoria` pasa por un trigger de Postgres que capitaliza la primera
 * letra (`app/migrations/070`), así que el centinela que el código escribe en minúscula
 * vuelve de la DB como `'Sin_categoria'`. Al 2026-08-12 son 503 de 2234 filas (22.5%) las que
 * lo llevan capitalizado y CERO las que lo llevan en minúscula: una comparación literal
 * case-sensitive **nunca acierta**, así que el centinela no se filtraba y la webapp lo
 * pintaba como si fuera una subcategoría de verdad. Eran 16 call-sites.
 *
 * Arreglar los 16 no es el fix: el fix es que el 17 no pueda nacer igual. Dos reglas, y la
 * segunda existe porque la primera se puede evadir escribiendo otra grafía del mismo
 * centinela (`'null'`, que también vive en prod capitalizado como `'Null'`).
 *
 * El hermano de este guard es `app/tests/subcategoria-centinela.test.js`. Son dos porque el
 * MISMO defecto vivía en los dos canales —la confirmación de WhatsApp decía
 * `✅ S/20 en Otros > Sin_categoria`— y cerrar sólo el árbol donde se encontró es la clase
 * `barrido-de-un-solo-arbol` de `docs/DEFECTOS.md`, que ya cobró antes en este repo.
 */

/** El único archivo que puede nombrar el centinela: es su dueño. */
const DUENO = 'lib/subcategoria.ts';

/** Comparación (en cualquiera de los dos órdenes) contra el literal del centinela. */
const COMPARACION = /(?:[!=]==?\s*['"`]sin_categoria['"`])|(?:['"`]sin_categoria['"`]\s*[!=]==?)/i;

/** El literal, en cualquier capitalización, aparezca donde aparezca. */
const LITERAL = /['"`]sin_categoria['"`]/i;

const SRC = join(process.cwd(), 'src');

function archivos(dir: string): string[] {
  return readdirSync(dir).flatMap((nombre) => {
    const full = join(dir, nombre);
    if (statSync(full).isDirectory()) return archivos(full);
    return /\.tsx?$/.test(full) && !/\.test\.tsx?$/.test(full) ? [full] : [];
  });
}

const fuentes = archivos(SRC).map((full) => ({
  rel: relative(SRC, full).replace(/\\/g, '/'),
  contenido: readFileSync(full, 'utf-8'),
}));

const bytesLeidos = fuentes.reduce((n, f) => n + f.contenido.length, 0);

describe('el centinela de subcategoría se compara en un solo sitio', () => {
  // Antivacuidad. Cuenta BYTES y archivos, no ocurrencias del defecto: un contador
  // anclado a que el problema siga existiendo se rompe justo cuando se arregla
  // (clase `antivacuidad-anclada-al-defecto`, ya pagada en este repo).
  it('el barrido mira algo (no puede quedar vacío en silencio)', () => {
    expect(fuentes.length).toBeGreaterThan(100);
    expect(bytesLeidos).toBeGreaterThan(200_000);
    expect(fuentes.map((f) => f.rel)).toContain(DUENO);
  });

  // Control positivo del detector: si el regex deja de matchear, las dos reglas de abajo
  // pasan verdes sin comprobar nada. Se prueba contra la forma EXACTA que tenía el bug.
  it('el detector reconoce la forma que produjo el bug, y no la forma correcta', () => {
    expect(COMPARACION.test("tx.subcategoria !== 'sin_categoria'")).toBe(true);
    expect(COMPARACION.test('tx.subcategoria !== "Sin_categoria"')).toBe(true);
    expect(COMPARACION.test("'sin_categoria' === sub")).toBe(true);
    expect(COMPARACION.test('subcategoriaUtil(tx.subcategoria)')).toBe(false);
    expect(LITERAL.test("subs: ['viaje', SUB_SENTINEL_REVISAR]")).toBe(false);
  });

  it('nadie compara contra el literal — se usa subcategoriaUtil/esSubSinClasificar', () => {
    const culpables = fuentes
      .filter((f) => f.rel !== DUENO)
      .flatMap((f) =>
        f.contenido
          .split('\n')
          .map((linea, i) => ({ ref: `${f.rel}:${i + 1}`, linea }))
          .filter((l) => COMPARACION.test(l.linea))
          .map((l) => `${l.ref}  ${l.linea.trim()}`)
      );

    expect(culpables, 'usa subcategoriaUtil() o esSubSinClasificar() de @/lib/subcategoria').toEqual([]);
  });

  // Más estricta que la anterior y a propósito: sin literales sueltos, la grafía `'null'`
  // tampoco tiene dónde nacer, porque el único módulo que la conoce es el dueño. En el
  // backend esta regla NO aplica —los prompts de `services/parsers.js` le dictan el
  // vocabulario al modelo y ahí el literal es contenido, no código— y por eso aquel guard
  // sólo lleva la regla de comparación.
  it('el literal sólo lo escribe su dueño (los demás importan la constante)', () => {
    const conLiteral = fuentes
      .filter((f) => f.rel !== DUENO && LITERAL.test(f.contenido))
      .map((f) => f.rel);

    expect(conLiteral, `importa SUB_SENTINEL_REVISAR de @/lib/${DUENO.replace('lib/', '')}`).toEqual([]);
  });
});

/**
 * La tabla de casos de los predicados. Es la MISMA en el espejo CommonJS del backend
 * (`app/tests/subcategoria-centinela.test.js`): si tocas una, toca la otra.
 */
describe('predicados del centinela', () => {
  it('reconoce el centinela venga como venga de la DB', () => {
    for (const v of ['sin_categoria', 'Sin_categoria', 'SIN_CATEGORIA', ' Sin_categoria ', 'null', 'Null']) {
      expect(esSubSinClasificar(v), v).toBe(true);
      expect(subcategoriaUtil(v), v).toBeNull();
    }
  });

  it('vacío y ausente no son el centinela, pero tampoco son mostrables', () => {
    for (const v of ['', '   ', null, undefined]) {
      // Distinción deliberada: "nunca se asignó subcategoría" es un estado normal y
      // distinto de "la NLP falló". `needsReview` los trata distinto según la categoría.
      expect(esSubSinClasificar(v), String(v)).toBe(false);
      expect(subcategoriaUtil(v), String(v)).toBeNull();
    }
  });

  it('una subcategoría real sobrevive, recortada', () => {
    expect(subcategoriaUtil('Delivery')).toBe('Delivery');
    expect(subcategoriaUtil('  delivery  ')).toBe('delivery');
    expect(subcategoriaUtil('sin_categoria_propia')).toBe('sin_categoria_propia');
    expect(esSubSinClasificar('Delivery')).toBe(false);
  });

  it('la constante es la forma del CÓDIGO (minúscula), no la de la DB', () => {
    expect(SUB_SENTINEL_REVISAR).toBe(SUB_SENTINEL_REVISAR.toLowerCase());
    expect(esSubSinClasificar(SUB_SENTINEL_REVISAR)).toBe(true);
  });
});
