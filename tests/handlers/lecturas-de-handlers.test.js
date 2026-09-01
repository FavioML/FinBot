import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

/**
 * LA COSTURA ENTRE LOS DOS GUARDS DE LECTURAS MUDAS (ítem 19 del backlog).
 *
 * Hasta el 31-ago-2026, `handlers/` (la raíz) no lo miraba NADIE:
 *
 *   · `tests/handlers/lecturas-de-contenido.test.js`  →  `handlers/intents/`
 *   · `tests/cron/lecturas-leen-el-error.test.js`     →  `cron/checks.js` + el cierre
 *                                                        transitivo de `services/`
 *
 * `handlers/muro-gate.js`, `handlers/webhook.js` y `handlers/admin-commands.js` caían justo en
 * el medio. No es hipotético: la fila del 24-ago de `docs/DEFECTOS.md` sobre `muro-gate.js`
 * sobrevivió SIETE DÍAS con su "Control que quedó: Ninguno todavía", mientras su gemelo de
 * `webhook.js` ya estaba arreglado desde el 26-ago. Un call-site sano tapando al roto, sin que
 * ningún build se pusiera rojo.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * LO QUE NO CUBRE, Y ES UNA DECISIÓN ESCRITA, NO UN OLVIDO
 *
 * **`lib/` sigue afuera, y también tiene costura.** Medido el 31-ago con el inventario:
 * `lib/support-tickets.js` 8 lecturas mudas + 1 escritura, `lib/whatsapp.js` 1,
 * `lib/error-monitor.js` 1. Es más grande que lo que este ítem vino a cerrar y toca el canal
 * de soporte, así que pide su propia tanda: quedó como ítem 20 del backlog con la medición
 * hecha. Meterlo acá de arrastre sería exactamente lo que el ítem 19 vino a criticar — cerrar
 * un hallazgo mirando sólo el árbol donde uno lo encontró.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * TRES DECISIONES DE DISEÑO, Y LAS TRES SE PAGARON EN OTRO GUARD
 *
 * 1. **El parser NO se copia: se toma del archivo que lo define**, igual que hace
 *    `scripts/inventario-escrituras-intents.mjs`. Ese parser ya se arregló dos veces
 *    (`d4baf49`, y el blanqueador de literales), y una copia acá divergiría sola. Si cambia su
 *    forma, esto falla con un mensaje que dice qué buscar, no en silencio.
 *
 * 2. **El perímetro es LISTA NEGRA y RECURSIVO.** Un `handlers/*.js` a secas deja afuera
 *    cualquier subdirectorio nuevo (`handlers/jobs/`, `handlers/canales/`), o sea que la
 *    costura se reabre un nivel más abajo el día que alguien cree una carpeta. Es literalmente
 *    la evasión #9 de `canal-unico-sin-cuenta-web.test.js`, que por eso también barre en negro.
 *
 * 3. **La regla de `verificarEscritura` no se re-implementa: se le pregunta al inventario.**
 *    `handlers/webhook.js` envuelve 6 escrituras con ese helper, que lee el error por dentro; el
 *    parser crudo las reporta como mudas. Desenvolverlas pide una regla que el inventario YA
 *    tiene, y una segunda copia deriva sola. Así que para los archivos que importan el helper
 *    este guard ejecuta el inventario y afirma sobre SU veredicto. Es una sola implementación
 *    de la regla, no dos de acuerdo — que es lo que `railway-watchpatterns-paridad` aprendió a
 *    los golpes: dos copias que coinciden pueden estar las dos equivocadas.
 *
 * LO QUE ESTE ARCHIVO NO PRUEBA, DECLARADO — y es más chico de lo que parece. Mide UNA forma:
 * que el `{ error }` se **destructure**. NO exige que se CONSULTE, y eso está medido, no
 * supuesto: un `const { data, error } = await supabase…` que nunca mira `error` sale limpio
 * (hay un caso abajo que lo fija). El límite viene del parser compartido, o sea que vale igual
 * para los otros dos guards; apretarlo cambiaría veredictos en tres perímetros a la vez y es su
 * propia tanda.
 *
 * Lo destapó una mutación: quitarle a `/panel` su `if (errPanel)` y dejar el destructuring
 * **no pone rojo a este archivo**, y sí a `admin-comandos-lecturas.test.js`. O sea que el reparto
 * real es: acá la forma, allá el comportamiento, y la segunda mitad no es opcional.
 */

const RAIZ = process.cwd();

// ─── El parser, tomado del guard que lo define ───────────────────────────────
const RUTA_GUARD = 'tests/cron/lecturas-leen-el-error.test.js';
const fuenteGuard = readFileSync(path.join(RAIZ, RUTA_GUARD), 'utf-8');
const desde = fuenteGuard.indexOf('const RAIZ = process.cwd();');
const hasta = fuenteGuard.indexOf('\ndescribe(');
if (desde < 0 || hasta < 0) {
  throw new Error(
    'No pude recortar el parser de ' + RUTA_GUARD + '. Cambió su forma: buscá '
    + '`const RAIZ = process.cwd();` y el primer `describe(`. Es el mismo recorte que hace '
    + 'scripts/inventario-escrituras-intents.mjs, así que los dos se arreglan igual.'
  );
}
const cuerpo = fuenteGuard.slice(desde, hasta).replace('const RAIZ = process.cwd();', '');
const construir = new Function('readFileSync', 'readdirSync', 'statSync', 'path', 'RAIZ',
  cuerpo + '\nreturn { lecturas, leeElError };');
const { lecturas, leeElError } = construir(readFileSync, readdirSync, statSync, path, RAIZ);

// ─── El perímetro ────────────────────────────────────────────────────────────
/**
 * Lo que NO se barre, con su motivo. Agregar una entrada acá es una DECISIÓN: cada una deja un
 * pedazo de `handlers/` sin vigilar.
 */
const EXCLUIDOS = {
  'handlers/intents': 'lo cubre tests/handlers/lecturas-de-contenido.test.js, y por '
    + 'COMPORTAMIENTO (ejercita cada sitio con datos, con cero filas y con error). Sus 2 '
    + 'lecturas mudas restantes están declaradas ahí a propósito: eliminar_transaccion y '
    + 'restaurar_eliminado fallan cerrado para la escritura y sólo mienten sobre la causa.',
};

function archivosJs(dirRel) {
  const out = [];
  for (const entrada of readdirSync(path.join(RAIZ, dirRel))) {
    const rel = dirRel + '/' + entrada;
    if (EXCLUIDOS[rel]) continue;
    if (statSync(path.join(RAIZ, rel)).isDirectory()) { out.push(...archivosJs(rel)); continue; }
    if (entrada.endsWith('.js')) out.push(rel);
  }
  return out;
}

const ARCHIVOS = archivosJs('handlers');
const HELPER = 'helpers/escritura-verificada';

/**
 * Sitios exentos, por (archivo, tabla) y con motivo. NO por número de línea: las líneas se
 * mueven y una exención por línea termina tapando el sitio equivocado sin avisar.
 */
const EXENTOS = [
  {
    archivo: 'handlers/message-processor.js',
    tabla: 'nlp_errors',
    motivo: 'Telemetría fire-and-forget (`.then(() => {}).catch(() => {})`), a propósito. Las '
      + 'tres corren en el camino donde el NLP ya falló y lo único que sigue es contestarle al '
      + 'usuario; esperar un INSERT a Supabase para eso le agrega una ida y vuelta a la '
      + 'respuesta de alguien a quien ya le fue mal. Lo que se pierde al fallar es una fila de '
      + '`nlp_errors`, que es una tabla de REVISIÓN del admin: el modo de fallo es un conteo '
      + 'sub-reportado, no una decisión equivocada ni plata. Se re-mira si `nlp_errors` deja '
      + 'de ser sólo telemetría.',
  },
];

/** Las queries de un archivo, clasificadas con el parser del otro guard. */
function clasificar(rel) {
  const src = readFileSync(path.join(RAIZ, rel), 'utf-8');
  const lineas = src.split('\n');
  const exentosDelArchivo = EXENTOS.filter((e) => e.archivo === rel);
  // La tabla se lee del fuente CRUDO en la línea del ancla (`supabase.from(` la lleva pegada),
  // no del fuente blanqueado, que justamente le vacía las cadenas.
  const exentoEn = (linea) => exentosDelArchivo.find((e) => (lineas[linea - 1] || '').includes("('" + e.tabla + "'"));

  const mudas = { lecturas: [], escrituras: [] };
  const exentosVistos = new Set();
  let total = 0;
  for (const q of lecturas(src, rel)) {
    total++;
    const esMuda = q.lhs === null || !leeElError(q.lhs, q.indice);
    if (!esMuda) continue;
    const ex = exentoEn(q.linea);
    if (ex) { exentosVistos.add(ex.tabla); continue; }
    if (q.lhs === null) mudas.escrituras.push(q.linea); else mudas.lecturas.push(q.linea);
  }
  return { ...mudas, total, src, exentosVistos, usaHelper: src.includes(HELPER) };
}

const CLASIFICADO = new Map(ARCHIVOS.map((rel) => [rel, clasificar(rel)]));
const CON_HELPER = ARCHIVOS.filter((rel) => CLASIFICADO.get(rel).usaHelper);
const SIN_HELPER = ARCHIVOS.filter((rel) => !CLASIFICADO.get(rel).usaHelper);

/** El veredicto del inventario para un archivo, ejecutándolo. Una sola regla, no dos. */
function veredictoDelInventario(rel) {
  const salida = execFileSync(process.execPath,
    ['scripts/inventario-escrituras-intents.mjs', rel], { cwd: RAIZ, encoding: 'utf-8' });
  const m = salida.match(/escrituras mudas=(\d+)\s+lecturas mudas=(\d+)/);
  if (!m) throw new Error('El inventario cambió su salida y no pude leer el TOTAL de ' + rel + ':\n' + salida);
  return { escrituras: Number(m[1]), lecturas: Number(m[2]), salida };
}

describe('antivacuidad: el guard mira algo, y el parser funciona', () => {
  it('el perímetro no se vació', () => {
    // Si alguien mueve `handlers/` o le pone una exclusión de más, esto lo dice en vez de salir
    // verde sobre cero archivos. El piso es holgado a propósito: no es un conteo que haya que
    // actualizar en cada commit, es un detector de perímetro colapsado.
    expect(ARCHIVOS.length, 'el perímetro de handlers/ quedó vacío o casi').toBeGreaterThanOrEqual(8);
    for (const imprescindible of ['handlers/admin-commands.js', 'handlers/muro-gate.js', 'handlers/webhook.js']) {
      expect(ARCHIVOS).toContain(imprescindible);
    }
  });

  it('es RECURSIVO: un subdirectorio de handlers/ no se escapa solo', () => {
    // La evasión que este diseño cierra. Hoy el único subdirectorio es `handlers/intents/` y
    // está excluido CON MOTIVO, así que se comprueba la función y no el árbol: si `archivosJs`
    // dejara de recursar, un `handlers/jobs/` nuevo saldría invisible y nadie se enteraría.
    const subdirs = readdirSync(path.join(RAIZ, 'handlers'))
      .filter((e) => statSync(path.join(RAIZ, 'handlers', e)).isDirectory())
      .map((e) => 'handlers/' + e);
    expect(subdirs, 'handlers/ ya no tiene subdirectorios: revisá EXCLUIDOS').toContain('handlers/intents');
    for (const d of subdirs) {
      expect(EXCLUIDOS[d], 'el subdirectorio ' + d + ' no está barrido ni excluido con motivo').toBeTruthy();
    }
  });

  it('el parser ENCUENTRA queries en el perímetro (si devuelve 0, no está midiendo)', () => {
    const total = [...CLASIFICADO.values()].reduce((s, c) => s + c.total, 0);
    // Un parser roto —o un recorte que se trajo la mitad del archivo— devuelve listas vacías y
    // este guard saldría verde sin haber mirado una sola query. Es el primer modo de fallo que
    // describe `feedback_guards_que_no_ven`.
    expect(total, 'el parser no encontró NINGUNA query en handlers/: está roto, no limpio').toBeGreaterThan(20);
  });

  it('el parser DETECTA una lectura muda sembrada, y NO marca una sana', () => {
    // El control que separa "no hay mudas" de "el detector no ve mudas". Sobre fuente
    // sintética, no sobre un archivo del árbol, para no depender de que el bug siga existiendo
    // (la clase `antivacuidad-anclada-al-defecto` de docs/DEFECTOS.md).
    const evaluar = (src) => lecturas(src, 'fixture.js')
      .filter((q) => q.lhs === null || !leeElError(q.lhs, q.indice)).length;
    const muda = 'async function f() {\n  const { data } = await supabase.from("usuarios").select("*").eq("id", 1);\n  return data;\n}\n';
    const sana = 'async function f() {\n  const { data, error } = await supabase.from("usuarios").select("*").eq("id", 1);\n  if (error) throw error;\n  return data;\n}\n';
    expect(evaluar(muda), 'el detector no ve una lectura muda evidente').toBe(1);
    expect(evaluar(sana), 'el detector marca como muda una lectura que SÍ lee el error').toBe(0);
  });

  it('LÍMITE FIJADO: destructurar `error` y no usarlo pasa como sano', () => {
    // Esto NO es lo deseable: es lo que el parser compartido hace hoy, medido. Se fija acá para
    // que nadie le crea a este guard más de lo que mide — y para que el día que alguien apriete
    // el parser (cambiando veredictos en los TRES perímetros que lo usan) este caso se ponga
    // rojo y lo mande a leer esta nota en vez de sorprenderse.
    //
    // Lo que SÍ atrapa este agujero es el test por sitio: la mutación "quitarle a /panel su
    // `if (errPanel)`" deja este archivo VERDE y mata `admin-comandos-lecturas.test.js`.
    const destructuraSinUsar = 'async function f() {\n  const { data, error } = await supabase.from("usuarios").select("*").eq("id", 1);\n  return data;\n}\n';
    const evaluar = (src) => lecturas(src, 'fixture.js')
      .filter((q) => q.lhs === null || !leeElError(q.lhs, q.indice)).length;
    expect(evaluar(destructuraSinUsar), 'el parser se apretó: revisá los otros dos perímetros').toBe(0);
  });

  it('cada exención declarada matchea algo (una exención muerta esconde el sitio siguiente)', () => {
    for (const ex of EXENTOS) {
      const c = CLASIFICADO.get(ex.archivo);
      expect(c, 'la exención apunta a ' + ex.archivo + ', que no está en el perímetro').toBeTruthy();
      expect(c.exentosVistos.has(ex.tabla),
        'la exención ' + ex.archivo + ' / ' + ex.tabla + ' ya no matchea ningún sitio: '
        + 'o el código se arregló y hay que borrarla, o la tabla cambió de nombre y está '
        + 'tapando lo que venga después').toBe(true);
      expect(ex.motivo.length, 'toda exención lleva motivo escrito').toBeGreaterThan(60);
    }
  });
});

describe('handlers/: ninguna query descarta su { error }', () => {
  it.each(SIN_HELPER)('%s', (rel) => {
    const { lecturas: lm, escrituras: em } = CLASIFICADO.get(rel);
    // supabase-js NUNCA lanza. Sin leer `{ error }`, un fallo de infraestructura sale por la
    // misma puerta que "no había nada": el usuario lee "no encontré" y va a buscar algo que sí
    // está. Molde del arreglo: `resolverSolicitudPro` en handlers/admin-commands.js
    // (`maybeSingle` + `if (error)` separado del `if (!data)`).
    expect(lm, 'lecturas mudas en ' + rel + ' (líneas)').toEqual([]);
    expect(em, 'escrituras sin destructuring en ' + rel + ' (líneas)').toEqual([]);
  });

  it.each(CON_HELPER)('%s (veredicto del inventario)', (rel) => {
    // Estos envuelven escrituras con `verificarEscritura`, que lee el error por dentro. La
    // regla para desenvolverlo vive en el inventario y se le pregunta a él en vez de copiarla.
    const v = veredictoDelInventario(rel);
    expect(v.lecturas, 'lecturas mudas en ' + rel + ':\n' + v.salida).toBe(0);
    expect(v.escrituras, 'escrituras mudas en ' + rel + ':\n' + v.salida).toBe(0);
  });

  it('el corte por helper es exhaustivo y hoy NO es vacío', () => {
    expect(SIN_HELPER.length + CON_HELPER.length).toBe(ARCHIVOS.length);
    // Si nadie usara el helper, la mitad de arriba nunca correría y su regla quedaría sin
    // ejercitar: sería un `it.each([])`, que vitest reporta como cero tests y se lee como que
    // pasó. Hoy `handlers/webhook.js` lo usa; el día que deje de usarlo, esto obliga a decidir
    // si el corte todavía tiene sentido en vez de dejarlo muerto.
    expect(CON_HELPER, 'nadie usa verificarEscritura en handlers/: el corte quedó sin ejercitar').not.toEqual([]);
  });
});
