import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const {
  SUB_SENTINEL_REVISAR,
  esSubSinClasificar,
  subcategoriaUtil,
} = require('../lib/subcategoria');

/**
 * Espejo del guard de `webapp/src/lib/subcategoria-callsites.test.ts`. Barre el runtime del
 * BACKEND, que es lo que aquél no puede ver — y el defecto vivía en los dos canales.
 *
 * EL BUG. `transacciones.subcategoria` pasa por un trigger de Postgres que capitaliza la
 * primera letra (`migrations/070_normalize_subcategoria_trigger.sql`), y `guardarTransaccion`
 * devuelve la fila con `.select()`, o sea DESPUÉS del trigger. El centinela que el código
 * inserta como `'sin_categoria'` vuelve como `'Sin_categoria'`, así que
 * `sub !== 'sin_categoria'` nunca acierta y la confirmación de todo gasto sin clasificar
 * decía por WhatsApp: `✅ S/20 en Otros > Sin_categoria`. Al 2026-08-12, 503 de 2234 filas
 * (22.5%) llevan un centinela capitalizado y CERO lo llevan en minúscula.
 *
 * POR QUÉ SÓLO LA REGLA DE COMPARACIÓN, y su hermano de la webapp tiene una segunda más
 * estricta ("el literal sólo lo escribe su dueño"): acá el literal aparece legítimamente
 * DENTRO de los prompts de `services/parsers.js` y `handlers/message-processor.js`, donde
 * `sin_categoria` es vocabulario que se le dicta al modelo, no código que compara. Prohibirlo
 * entero obligaría a interpolar constantes dentro de los prompts para nada. Lo que no puede
 * existir en ninguno de los dos árboles es la COMPARACIÓN.
 */

/** El único archivo que puede nombrar el centinela en posición de comparación: su dueño. */
const DUENO = 'lib/subcategoria.js';

/** Comparación (en cualquiera de los dos órdenes) contra el literal del centinela. */
const COMPARACION = /(?:[!=]==?\s*['"`]sin_categoria['"`])|(?:['"`]sin_categoria['"`]\s*[!=]==?)/i;

/**
 * Mismo alcance que `codigos-seguros.test.js`, y por el mismo motivo: la RAÍZ va incluida.
 * Un barrido que lista sólo los subdirectorios deja fuera `gmail.js`, `index.js` y otros
 * ocho archivos de runtime. `qa-e2e/` queda afuera a propósito — ahí las comparaciones
 * bajan a minúscula a mano contra la DB, que es la forma correcta para un oráculo.
 */
const RUNTIME = ['handlers', 'lib', 'services', 'routes', 'cron', 'helpers', 'scripts'];

function archivosJs(dir) {
  const out = [];
  const abs = path.join(projectRoot, dir);
  if (!fs.existsSync(abs)) return out;
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    if (e.isDirectory()) out.push(...archivosJs(path.join(dir, e.name)));
    else if (/\.(js|mjs|cjs)$/.test(e.name)) out.push(path.join(dir, e.name));
  }
  return out;
}

function archivosRaiz() {
  return fs.readdirSync(projectRoot, { withFileTypes: true })
    .filter((e) => e.isFile() && /\.(js|mjs|cjs)$/.test(e.name))
    .map((e) => e.name);
}

const fuentes = [...RUNTIME.flatMap(archivosJs), ...archivosRaiz()]
  .map((p) => p.replace(/\\/g, '/'))
  .map((rel) => ({ rel, contenido: fs.readFileSync(path.join(projectRoot, rel), 'utf-8') }));

const bytesLeidos = fuentes.reduce((n, f) => n + f.contenido.length, 0);

describe('el centinela de subcategoría se compara en un solo sitio (backend)', () => {
  // Antivacuidad por BYTES y por archivos, no por ocurrencias del defecto: un contador
  // atado a que el problema siga existiendo se rompe justo cuando se arregla.
  it('el barrido mira algo (no puede quedar vacío en silencio)', () => {
    expect(fuentes.length).toBeGreaterThan(50);
    expect(bytesLeidos).toBeGreaterThan(200_000);
    expect(fuentes.map((f) => f.rel)).toContain(DUENO);
    // La raíz entra: sin esto el barrido volvería a dejar fuera `gmail.js` e `index.js`.
    expect(fuentes.map((f) => f.rel)).toContain('index.js');
  });

  // Control positivo del detector. Sin esto, un regex que dejó de matchear deja la regla
  // de abajo verde sin comprobar nada.
  it('el detector reconoce la forma que produjo el bug, y no la forma correcta', () => {
    expect(COMPARACION.test("sub && sub !== 'sin_categoria'")).toBe(true);
    expect(COMPARACION.test('subLibre !== "Sin_categoria"')).toBe(true);
    expect(COMPARACION.test("'sin_categoria' === sub")).toBe(true);
    expect(COMPARACION.test('subcategoriaUtil(t.subcategoria)')).toBe(false);
    // El literal dentro de un prompt NO es una comparación y tiene que seguir pasando.
    expect(COMPARACION.test("Otros: regalo|donacion|multa|viaje|sin_categoria")).toBe(false);
    expect(COMPARACION.test("subcategoria: datos.subcategoria || 'sin_categoria',")).toBe(false);
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

    expect(culpables, "usa subcategoriaUtil() o esSubSinClasificar() de lib/subcategoria").toEqual([]);
  });
});

/**
 * La MISMA tabla de casos que el espejo de la webapp
 * (`webapp/src/lib/subcategoria-callsites.test.ts`). Si tocas una, toca la otra: son dos
 * implementaciones del mismo predicado en dos lenguajes, no una copia con su test.
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
      // distinto de "la NLP falló".
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
