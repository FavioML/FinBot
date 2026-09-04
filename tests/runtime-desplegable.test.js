import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { leerPatrones, crearPredicado } from '../qa-e2e/lib/railway-watch.mjs';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * GUARD DE CLASE: todo archivo que el runtime carga POR RUTA tiene que estar observado
 * por `build.watchPatterns` de `railway.json`.
 *
 * ── POR QUÉ EXISTE ──────────────────────────────────────────────────────────────
 *
 * El 04-sep-2026 una auditoría documental encontró que los dos prompts que el backend
 * lee al arrancar vivían en `docs/`, que `railway.json` excluye con el motivo escrito
 * "no los ejecuta nadie". Editar el system prompt maestro de Neto NO disparaba redeploy:
 * producción seguía sirviendo el prompt anterior, sin error y sin aviso, hasta que otro
 * archivo de backend cambiara por casualidad.
 *
 * La cadena que lo produjo tiene tres eslabones y ninguno fue un descuido puntual:
 *   1. `7941cb0` (31-mar-2026), un commit de *limpieza de docs*, movió
 *      `NETO_recomendaciones_prompt.md` de `prompts/` a `docs/`. Runtime aterrizó en una
 *      carpeta de documentación porque la limpieza ordenaba por NOMBRE de archivo.
 *   2. Ese mismo movimiento dejó la constante apuntando al directorio viejo, el ENOENT
 *      cayó en un `catch` que devolvía `null`, y `generarRecomendaciones` devolvió `null`
 *      en el 100% de las llamadas durante ~4 meses (ver el docblock de
 *      `services/recommendations.js`).
 *   3. El 22-jul-2026 nació `railway.json` excluyendo `docs/**` porque "no los ejecuta
 *      nadie" — razonando sobre lo que el nombre de la carpeta prometía, sin revalidar
 *      la premisa en su destino.
 *
 * O sea: una justificación heredada de un commit de limpieza, nunca revalidada. Este
 * test es la revalidación, y corre en cada suite.
 *
 * ── POR QUÉ NO ES UN TEST DE CADENA ─────────────────────────────────────────────
 *
 * Lo que había antes acá cerca era `expect(PROMPT_PATH).toContain('/docs/...')` en
 * `tests/lib/neto-prompt.test.js`: un test que FIJABA la ubicación equivocada y que,
 * lejos de atrapar el bug, lo blindaba. Cambiarlo por `'/prompts/'` habría sido el mismo
 * error con otra cadena: seguiría sin saber nada sobre deployabilidad, y el día que
 * alguien agregue `!prompts/**` a `railway.json` pasaría en verde.
 *
 * Acá no hay ninguna ruta escrita a mano del lado de la respuesta. Las DOS mitades se
 * derivan:
 *   - la pregunta  → escaneando el código de runtime (qué carga por ruta);
 *   - la respuesta → de `railway.json`, vía el mismo modelo de globs que usa el canary
 *     (`qa-e2e/lib/railway-watch.mjs`), cuyo dialecto está medido contra Railway con
 *     deploys de control y vigilado por `qa-e2e/backend-watchpatterns-real.mjs`.
 *
 * Se prueba por mutación en las dos direcciones, y las dos tienen que MATARLO:
 *   a) devolver una constante a `docs/`      → muere por "no existe" y/o "no observado";
 *   b) agregar `!prompts/**` a railway.json  → muere por "no observado".
 *
 * ── QUÉ VE Y QUÉ NO ─────────────────────────────────────────────────────────────
 *
 * Ve `path.join(__dirname, ...)` y `path.resolve(__dirname, ...)` con TODOS los segmentos
 * literales, dentro de los directorios de runtime. No ve una ruta armada con una variable
 * — y por eso no la deja pasar: si aparece una, el test falla pidiendo que se le enseñe.
 * Un `continue` silencioso ahí sería exactamente el fallo que esto viene a evitar.
 *
 * No alcanza con chequear que el directorio padre esté observado: en este dialecto
 * `!docs/**` NO está anclado a la raíz (medido el 09-ago-2026, `6de1392`), así que
 * `handlers/docs/x` quedaría excluido aunque `handlers/` esté observado. Por eso cada
 * ruta se evalúa entera, y un directorio se evalúa archivo por archivo.
 */

// Los mismos directorios que `tests/copy-sin-voseo.test.js` llama runtime. `scripts/`
// queda afuera a propósito: son utilidades que se corren a mano, no las carga el server.
const DIRS_RUNTIME = ['handlers', 'services', 'lib', 'cron', 'routes', 'helpers'];

// ANTI-VACUIDAD. Si el escáner deja de ver (se renombra un directorio, cambia la forma de
// escribir las cargas, se rompe la expresión), este test pasaría en verde sin mirar nada.
// El ancla es por MÓDULO y no por ruta de destino, a propósito: fija que estos archivos
// SIGUEN cargando algo por ruta, sin volver a fijar DÓNDE — que es justo la libertad que
// el guard existe para vigilar.
const MODULOS_QUE_CARGAN_POR_RUTA = [
  'lib/neto-prompt.js',           // system prompt maestro
  'services/recommendations.js',  // prompt de recomendaciones
  'handlers/intent-registry.js',  // el directorio de intents
];

const RE_JOIN = /path\.(?:join|resolve)\(\s*__dirname\s*,([^)]*)\)/g;
const RE_SEGMENTO_LITERAL = /^\s*(?:'([^']*)'|"([^"]*)")\s*$/;

function archivosJs(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) archivosJs(p, acc);
    else if (/\.(js|mjs|cjs)$/.test(e.name)) acc.push(p);
  }
  return acc;
}

/** Todo archivo bajo `p`, recursivo, en rutas relativas a la raíz del repo y POSIX. */
function archivosBajo(p, acc = []) {
  for (const e of fs.readdirSync(p, { withFileTypes: true })) {
    if (e.name === 'node_modules') continue;
    const hijo = path.join(p, e.name);
    if (e.isDirectory()) archivosBajo(hijo, acc);
    else acc.push(path.relative(RAIZ, hijo).replace(/\\/g, '/'));
  }
  return acc;
}

/** Las cargas por ruta que declara el runtime, derivadas del código fuente. */
function cargasDeRuntime() {
  const cargas = [];
  const dinamicas = [];

  for (const dir of DIRS_RUNTIME) {
    for (const archivo of archivosJs(path.join(RAIZ, dir))) {
      const fuente = fs.readFileSync(archivo, 'utf8');
      const modulo = path.relative(RAIZ, archivo).replace(/\\/g, '/');

      for (const m of fuente.matchAll(RE_JOIN)) {
        const segmentos = [];
        let literal = true;
        for (const crudo of m[1].split(',')) {
          const s = crudo.match(RE_SEGMENTO_LITERAL);
          if (!s) { literal = false; break; }
          segmentos.push(s[1] ?? s[2]);
        }
        const expresion = m[0].replace(/\s+/g, ' ');
        if (!literal) { dinamicas.push({ modulo, expresion }); continue; }

        const absoluta = path.resolve(path.dirname(archivo), ...segmentos);
        cargas.push({
          modulo,
          expresion,
          absoluta,
          relativa: path.relative(RAIZ, absoluta).replace(/\\/g, '/'),
        });
      }
    }
  }
  return { cargas, dinamicas };
}

describe('lo que el runtime carga por ruta se redespliega', () => {
  const { cargas, dinamicas } = cargasDeRuntime();
  const observado = crearPredicado(leerPatrones());

  it('el escáner sigue viendo: los módulos que cargan por ruta aparecen', () => {
    // Sin esto, cualquier rotura del escáner deja los tests de abajo iterando sobre una
    // lista vacía y contestando que todo está bien.
    const vistos = new Set(cargas.map((c) => c.modulo));
    for (const modulo of MODULOS_QUE_CARGAN_POR_RUTA) {
      expect(
        vistos.has(modulo),
        `el escáner no encontró ninguna carga por ruta en ${modulo}. O el módulo dejó de ` +
          `cargar un archivo (entonces sacalo de MODULOS_QUE_CARGAN_POR_RUTA, a mano y a ` +
          `sabiendas), o el escáner se quedó ciego y este guard está pasando en falso.`,
      ).toBe(true);
    }
  });

  it('ninguna carga de runtime arma la ruta con una variable', () => {
    // No es celo de estilo: una ruta dinámica NO se puede evaluar contra watchPatterns, y
    // dejarla pasar en silencio reabre el agujero. Si hace falta una, el arreglo es
    // enseñarle a este guard cómo acotarla, no ignorarla.
    expect(
      dinamicas,
      'hay cargas por ruta que este guard no puede evaluar:\n' +
        dinamicas.map((d) => `  ${d.modulo}: ${d.expresion}`).join('\n'),
    ).toEqual([]);
  });

  it('cada archivo que el runtime carga existe y está observado por railway.json', () => {
    expect(cargas.length).toBeGreaterThan(0);

    const noExisten = [];
    const noObservados = [];

    for (const carga of cargas) {
      if (!fs.existsSync(carga.absoluta)) {
        // El runtime tira al arrancar si el archivo falta, así que esto no es higiene:
        // es el backend que no levanta.
        noExisten.push(`${carga.modulo} → ${carga.relativa}  (${carga.expresion})`);
        continue;
      }
      // Un directorio se evalúa archivo por archivo: que el padre esté observado NO
      // implica que los hijos lo estén (`!docs/**` matchea a cualquier profundidad).
      const objetivos = fs.statSync(carga.absoluta).isDirectory()
        ? archivosBajo(carga.absoluta)
        : [carga.relativa];

      for (const f of objetivos) if (!observado(f)) noObservados.push(`${carga.modulo} → ${f}`);
    }

    expect(
      noExisten,
      `el runtime carga rutas que no existen (el proceso NO arranca):\n${noExisten.join('\n')}`,
    ).toEqual([]);

    expect(
      noObservados,
      'estos archivos los CARGA el runtime pero `railway.json` no los observa, así que ' +
        'editarlos no redespliega el backend y producción sigue sirviendo la versión vieja ' +
        `sin error y sin aviso:\n${noObservados.join('\n')}\n\n` +
        'Arreglo: movelos a un directorio observado. NO intentes re-incluirlos en ' +
        'watchPatterns (`["**", "!docs/**", "docs/x.txt"]`): la precedencia de Railway ' +
        'nunca se midió y `verificarForma()` se niega a compilar esa lista a propósito.',
    ).toEqual([]);
  });
});
