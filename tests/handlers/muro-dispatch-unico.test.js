import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import { readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';

const require = createRequire(import.meta.url);
const RAIZ = path.resolve(new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), '../..');

/**
 * El otro lado de `muro-dispatch.test.js`. Ese prueba que los cuatro call-sites de HOY
 * gatean; este impide que aparezca un quinto.
 *
 * Por qué un guard estático alcanza ACÁ, cuando el CLAUDE.md dice que no alcanza en
 * general: la pregunta no es de comportamiento ("¿esta rama hace lo correcto?", que un grep
 * no puede responder — no distingue `if (x)` de `if (!x)`), sino de PRESENCIA de una
 * llamada. Eso sí lo decide un barrido de texto sin ambigüedad. Es la misma forma que
 * `gmail-oauth-gates.test.js` ("cero `generarUrlAutorizacion` en handlers/") y
 * `notificaciones-duales.test.js`.
 *
 * Si agregás un redirect nuevo y este test se pone rojo, la respuesta NO es sumar tu
 * archivo a la lista: es usar `dispatchIntent`, que trae el gate del muro puesto.
 *
 * **Lo que este guard NO puede ver, escrito para que nadie lo lea como hermético.** Vigila
 * dos formas: `getHandler(` y `.handle(`. Una tercera —destructurar (`const { handle } =
 * require('./intents/reportes'); handle(args)`)— se le escapa. No se agrega una regla más
 * porque el juego es infinito: lo que de verdad sostiene el invariante es el gate viviendo
 * DENTRO del dispatch, y esto es la red que atrapa el atajo distraído, no al adversario.
 * La forma que la revisión adversarial encontró viva (`.handle(`) sí está cubierta.
 */

// Dónde vive código que corre en producción. `tests/` y `qa-e2e/` quedan fuera a propósito:
// un harness que llama handlers directo (qa-handler-directo, qa-deshacer-restaura) está
// ejercitando el handler, no despachando el mensaje de un usuario.
//
// `''` es la RAÍZ del repo (index.js, gmail.js, reporte_html.js): la primera versión de
// esta lista la olvidaba, y un dispatch desde ahí quedaba invisible.
const DIRS_PRODUCCION = ['', 'handlers', 'services', 'routes', 'cron', 'lib', 'helpers', 'scripts', 'tasks'];

// El único archivo que puede repartir handlers: es donde vive el gate.
const DUENO = path.join('handlers', 'intent-registry.js');

// La raíz no se recorre recursivamente: ahí cuelgan node_modules, webapp/, tests/ y
// qa-e2e/, que no son este código. Los subdirectorios nombrados sí, enteros.
function archivosJs(dir, recursivo = true) {
  const salida = [];
  const abs = path.join(RAIZ, dir);
  let entradas;
  try { entradas = readdirSync(abs); } catch { return salida; }
  for (const e of entradas) {
    const p = path.join(abs, e);
    if (statSync(p).isDirectory()) {
      if (recursivo) salida.push(...archivosJs(path.join(dir, e)));
    } else if (e.endsWith('.js')) salida.push(path.join(dir, e));
  }
  return salida;
}

describe('el muro tiene un solo camino de dispatch', () => {
  const archivos = DIRS_PRODUCCION.flatMap((d) => archivosJs(d, d !== ''));

  it('el barrido encuentra archivos (si esto falla, el resto es verde por vacuidad)', () => {
    expect(archivos.length).toBeGreaterThan(40);
    expect(archivos).toContain(DUENO);
    expect(archivos).toContain('index.js');            // la raíz entra
    expect(archivos).toContain(path.join('cron', 'checks.js'));
  });

  // Busca la forma de LLAMADA, no la mención: los comentarios de los cuatro call-sites
  // nombran `getHandler` para explicar por qué ya no lo usan. Y NO se quitan los comentarios
  // antes de buscar, a propósito: un stripper ingenuo se come el resto de la línea después
  // de un `https://` y ahí el guard se vuelve ciego, que es la dirección peligrosa. Un falso
  // positivo por un comentario es barato (se reformula); un falso negativo no se ve.
  const LLAMADA = /\bgetHandler\s*\(/;

  it('el patrón sí detecta una llamada (guard no vacuo)', () => {
    expect(LLAMADA.test('const h = getHandler(intencion);')).toBe(true);
    expect(LLAMADA.test('const h = getHandler (x)')).toBe(true);
    expect(LLAMADA.test('// vía dispatchIntent, no `getHandler`')).toBe(false);
  });

  it('ningún archivo de producción llama a getHandler salvo el registry', () => {
    const culpables = archivos.filter(
      (f) => f !== DUENO && LLAMADA.test(readFileSync(path.join(RAIZ, f), 'utf8'))
    );
    expect(culpables).toEqual([]);
  });

  // La otra puerta, y la encontró una revisión adversarial evadiendo la de arriba: no hace
  // falta el registry para despachar un intent — alcanza con
  // `require('./intents/reportes').handle({ intencion: 'ver_reporte', … })`. Con solo el
  // guard de `getHandler(` eso pasaba en verde y entregaba una lectura sin gate.
  //
  // `.handle(` tiene HOY cero apariciones en producción (`premiumIntents` se usa por una
  // función con nombre propio, no por `handle`), así que la regla no le cuesta nada a nadie.
  const INVOCACION_HANDLE = /\.handle\s*\(/;

  it('el patrón de .handle sí detecta una invocación directa (guard no vacuo)', () => {
    expect(INVOCACION_HANDLE.test("require('./intents/reportes').handle({ intencion: 'x' })")).toBe(true);
    expect(INVOCACION_HANDLE.test('mod.handle (args)')).toBe(true);
    expect(INVOCACION_HANDLE.test('const { handle } = mod;')).toBe(false);
  });

  it('ningún archivo de producción invoca .handle() de un módulo de intents', () => {
    const culpables = archivos.filter(
      (f) => f !== DUENO && INVOCACION_HANDLE.test(readFileSync(path.join(RAIZ, f), 'utf8'))
    );
    expect(culpables).toEqual([]);
  });

  it('los cuatro dispatches conocidos siguen pasando por dispatchIntent', () => {
    const esperado = {
      [path.join('handlers', 'message-processor.js')]: 2,      // primario + continuación
      [path.join('handlers', 'intents', 'transacciones.js')]: 2, // los dos redirects
      [path.join('handlers', 'intents', 'presupuestos.js')]: 1,  // ver_balance → ver_presupuesto
    };
    const real = {};
    for (const [f] of Object.entries(esperado)) {
      const src = readFileSync(path.join(RAIZ, f), 'utf8');
      // Sin el `await`: una llamada partida (`const p = dispatchIntent(…); await p`) es la
      // misma llamada y no tiene por qué no contar.
      real[f] = (src.match(/\bdispatchIntent\s*\(/g) || []).length;
    }
    expect(real).toEqual(esperado);
  });

  it('dispatchIntent consulta el muro ANTES de buscar el handler', () => {
    const src = readFileSync(path.join(RAIZ, DUENO), 'utf8');
    const cuerpo = src.slice(src.indexOf('async function dispatchIntent'));
    const gate = cuerpo.indexOf('respuestaMuroSiCorresponde({');
    const lookup = cuerpo.indexOf('handlers[intencion]');
    expect(gate).toBeGreaterThan(-1);
    expect(lookup).toBeGreaterThan(-1);
    // Si el lookup fuera primero, un intent de LECTURA sin handler registrado caería al
    // fallback en vez de morir en el muro. Hoy no hay ninguno (lo fija el test de intents
    // fantasma), pero el orden es lo que hace que siga sin haberlo.
    expect(gate).toBeLessThan(lookup);
  });

  it('el muro se lee de intents-acceso, no de una lista propia del gate', () => {
    const src = readFileSync(path.join(RAIZ, 'handlers', 'muro-gate.js'), 'utf8');
    expect(src).toMatch(/require\('\.\/intents-acceso'\)/);
    // Una segunda lista de intents dentro del gate sería la divergencia que
    // `intents-acceso.test.js` no puede ver.
    expect(src).not.toMatch(/new Set\(\[/);
  });

  it('un fallo leyendo el conteo NO abre el muro', async () => {
    const { respuestaMuroSiCorresponde } = require('../../handlers/muro-gate');
    const roto = {
      supabase: { from: () => ({ select: () => ({ eq: () => Promise.reject(new Error('supabase caído')) }) }) },
      guardarMensaje: async () => {},
    };
    const usuario = { id: 'u', nombre: 'X', plan: 'free', trial_estado: 'vencido' };
    // Si el gate tragara el error y devolviera null, la lectura se entregaría gratis cada
    // vez que Supabase parpadee. Tiene que fallar CERRADO: el error sube.
    await expect(respuestaMuroSiCorresponde({ intencion: 'listar_gastos_mes', usuario, ctx: roto }))
      .rejects.toThrow('supabase caído');
  });
});
