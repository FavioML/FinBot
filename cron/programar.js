const log = require('../lib/logger');
const { correrSinSolape } = require('./sin-solape');

/**
 * El CABLEADO de las tareas programadas, separado de `cron/index.js` para que se pueda
 * ejercitar como código y no solo leer como texto.
 *
 * La primera versión de esto vivía dentro de `cron/index.js`, que arrastra `checks.js` y con él
 * el cliente de Supabase. Los guards terminaron mirando el ARCHIVO con regex, y una revisión
 * adversarial midió el precio: **cuatro mutaciones de producción pasaban en verde** — borrar el
 * arranque al boot, poner el desfase en 0, y cablear `setInterval(fn)` salteándose el
 * anti-solape. Un guard que lee texto no puede ver ninguna de las tres.
 */

const PASO_OFFSET_MS = 20 * 1000;

/**
 * Desfase de arranque, calculado POR GRUPO DE PERÍODO.
 *
 * El pico que esto aplana es entre tareas que comparten período: las 18 de 15 minutos salían en
 * el mismo milisegundo. Una tarea sola en su período no tiene con quién chocar, así que le toca
 * **offset 0** — y eso no es un detalle: `keepWarmWebapp` (4 min) es la única con período corto,
 * y con un offset global calculado sobre el índice del array le tocaba 200s, o sea que su primer
 * tick pasaba de +4 a +7min20s. Es la tarea cuyo único propósito es que no haya una ventana fría
 * en Vercel, justo después de cada deploy.
 *
 * El paso se acota a `período / (n+1)` para que el último de un grupo grande no quede a medio
 * período del primero.
 */
function calcularOffsets(tareas) {
  const porPeriodo = new Map();
  for (const t of tareas) {
    if (!porPeriodo.has(t.cadaMs)) porPeriodo.set(t.cadaMs, []);
    porPeriodo.get(t.cadaMs).push(t);
  }
  const offsets = new Map();
  for (const [cadaMs, grupo] of porPeriodo) {
    const paso = Math.min(PASO_OFFSET_MS, Math.floor(cadaMs / (grupo.length + 1)));
    grupo.forEach((t, k) => offsets.set(t.nombre, k * paso));
  }
  return offsets;
}

/**
 * Programa `tareas` resolviendo cada `nombre` contra `funciones`.
 *
 * **Valida TODO antes de programar NADA.** Antes tiraba en el medio del `forEach`, y eso dejaba
 * el proceso a medias y VIVO: las tareas anteriores al typo programadas, las siguientes no, y
 * `limpiarContadores` —que se programa después— sin programar. `index.js` no hace `process.exit`
 * en `uncaughtException` (a propósito), así que Railway veía un proceso escuchando y sano.
 *
 * Una tarea que no resuelve se SALTEA y se reporta por `alFaltarFuncion`; las demás se programan
 * igual. Matar las 23 tareas sanas por un typo en la 24 es peor para un bot que le escribe a
 * gente real, y el guard `tests/cron/scheduling.test.js` ya atrapa el typo antes del push.
 *
 * @returns {{programadas: string[], rotas: string[], offsets: Map<string, number>}}
 */
function programar(tareas, funciones, { alFaltarFuncion, alAtascarse, umbralAtascoMs } = {}) {
  const rotas = tareas.filter((t) => typeof funciones[t.nombre] !== 'function').map((t) => t.nombre);
  rotas.forEach((nombre) => { if (alFaltarFuncion) alFaltarFuncion(nombre); });

  const sanas = tareas.filter((t) => typeof funciones[t.nombre] === 'function');
  const offsets = calcularOffsets(sanas);

  for (const t of sanas) {
    const fn = funciones[t.nombre];
    const offsetMs = offsets.get(t.nombre);
    const opciones = { alAtascarse, umbralAtascoMs };

    if (t.alBoot) correrSinSolape(t.nombre, fn, opciones);

    setTimeout(() => {
      setInterval(() => correrSinSolape(t.nombre, fn, opciones), t.cadaMs);
    }, offsetMs);

    log.info(
      { tag: t.tag, tarea: t.nombre, cadaMin: Math.round(t.cadaMs / 60000), offsetSeg: Math.round(offsetMs / 1000), alBoot: !!t.alBoot },
      t.mensaje,
    );
  }

  return { programadas: sanas.map((t) => t.nombre), rotas, offsets };
}

module.exports = { programar, calcularOffsets, PASO_OFFSET_MS };
