import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * LA MISMA COSTURA, POR CUARTA VEZ — Y EL ARCHIVO QUE LA CIERRA POR CONSTRUCCIÓN
 * (ítem 21 del backlog).
 *
 * Los ítems 19 y 20 cerraron `handlers/` y `lib/`. Cada uno dejó escrito que el siguiente
 * seguía afuera, y el 21 midió el resto: **46 sitios mudos en 8 archivos**, con
 * `routes/admin.js` a la cabeza (14) y `helpers/db-helpers.js` (10) en el camino de cada
 * mensaje entrante.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * LA PREGUNTA QUE HABÍA QUE CONTESTAR ANTES DE ESCRIBIR NADA
 *
 * El ítem la formuló así: al ir por el CUARTO guard con el mismo parser y el mismo diseño,
 * ¿no conviene UNO con perímetro derivado del árbol de RUNTIME y lista negra, en vez de cinco
 * archivos que comparten parser y divergen en todo lo demás?
 *
 * **La respuesta es que sí conviene uno solo — pero NO derivado del árbol de runtime, y eso
 * está medido, no razonado.** El cierre transitivo de `require`s estáticos desde `index.js` +
 * `cron/checks.js` da 81 archivos, y dentro de él **NO están 13 de los 15 `handlers/intents/`**:
 * `handlers/intent-registry.js` los carga con `fs.readdirSync` + `require(path.join(...))`, o
 * sea que ningún parser estático los ve. Son **47 queries** — la superficie de NLP entera, la
 * más tocada del repo. Un perímetro derivado del runtime las habría dejado afuera **en
 * silencio y sin ponerse rojo**: el modo de fallo #1 de `feedback_guards_que_no_ven`, y
 * exactamente el mismo error que este capítulo viene arreglando desde el ítem 19.
 *
 * Así que el perímetro se deriva del árbol de **FUENTE**, con lista negra de DIRECTORIOS.
 * Sirve el mismo propósito (nada nace afuera) sin depender de que el código sea alcanzable por
 * un `require` literal.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * POR QUÉ SIGUEN SIENDO CINCO ARCHIVOS, Y POR QUÉ ESO YA NO ES LA COSTURA
 *
 * Este archivo **no** absorbe a sus tres hermanos, y la razón no es pereza:
 *
 *   · Cada uno lleva decisiones propias que no se fusionan sin perderlas. El de `handlers/`
 *     tiene el corte por `verificarEscritura` (le PREGUNTA al inventario en vez de
 *     re-implementar la regla) y la exención de `nlp_errors`. El de `handlers/intents/` es de
 *     COMPORTAMIENTO y admite 2 lecturas mudas declaradas a propósito. Una sola lista de
 *     exenciones sobre cuatro árboles deja de poder decir cuál.
 *   · Dos guards afirmando lo mismo sobre el mismo archivo dan un rojo doble que no dice
 *     dónde mirar.
 *
 * **Lo que sí cambia, y es el punto entero de este archivo: el perímetro ya no se escribe.**
 * Barre el árbol propio ENTERO desde la raíz y descuenta lo que otro guard cubre, con motivo.
 * Un directorio nuevo —`canales/`, `jobs/`, `workers/`— nace ADENTRO. Los cuatro guards
 * anteriores tenían perímetros positivos (`handlers`, `lib`, el transitivo del cron) y por eso
 * el complemento existía y nadie lo miraba: tres veces seguidas, el hueco lo encontró la
 * sesión siguiente. Acá no hay complemento que mirar.
 *
 * Y el hueco no era teórico: `services/gmail-scanner.js` (7 sitios, entre ellos el cron de
 * escaneo) vivía en `services/`, que el guard de crons SÍ barre — pero sólo lo que cuelga de
 * `cron/checks.js`, y `escaneoAutomatico` lo llama `cron/index.js`. Un archivo del mismo
 * directorio, a un salto de distancia del perímetro.
 *
 * **Por eso este archivo SE SUPERPONE con el guard de crons sobre `services/` y `cron/`, a
 * propósito.** La alternativa era dibujar a mano "services/ menos lo que el cron alcanza", que
 * es justo el perímetro escrito a mano que el ítem 19 documentó como el error. La superposición
 * sale gratis, y está medido por qué: el guard de crons **no tiene exenciones** (`PENDIENTES`
 * y `PENDIENTES_ESCRITURAS` están vacíos), así que los dos no pueden discrepar sobre un archivo
 * — sólo coincidir. El día que ese guard necesite su primera exención, esa afirmación deja de
 * valer y hay que traerla acá también.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * LO QUE ESTE ARCHIVO NO PRUEBA, DECLARADO
 *
 * Mide UNA forma: que el `{ error }` se **destructure**. NO exige que se CONSULTE — un
 * `const { data, error } = await supabase…` que nunca mira `error` sale limpio. Es un límite
 * del parser compartido, vale igual para los CUATRO perímetros, y está fijado como caso abajo.
 * El reparto es el mismo de los ítems 19 y 20: **acá la forma, el comportamiento en
 * `tests/routes/lecturas-de-rutas.test.js`, `tests/helpers/lecturas-del-camino-caliente.test.js`
 * y `tests/services/lecturas-de-servicios-sueltos.test.js`**, que ejercitan cada sitio con la
 * tabla caída y afirman qué se contesta. La segunda mitad no es opcional, y acá menos que en
 * ningún otro perímetro: los 46 sitios NO comparten política. Unos fallan CERRADO (el
 * anti-abuso de `/pro/solicitud`, los dos pre-checks del escáner de Gmail, la purga de
 * `conversaciones`) y otros ABIERTO con el log como único cambio (el envío de `/admin/notify`,
 * el perfil de Google, la sugerencia de meta). Mirando la forma, los dos grupos son idénticos.
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
    + '`const RAIZ = process.cwd();` y el primer `describe(`. Es el mismo recorte que hacen '
    + 'scripts/inventario-escrituras-intents.mjs, tests/handlers/lecturas-de-handlers.test.js '
    + 'y tests/lib/lecturas-de-lib.test.js, así que los cuatro se arreglan igual.'
  );
}
const cuerpo = fuenteGuard.slice(desde, hasta).replace('const RAIZ = process.cwd();', '');
const construir = new Function('readFileSync', 'readdirSync', 'statSync', 'path', 'RAIZ',
  cuerpo + '\nreturn { lecturas, leeElError };');
const { lecturas, leeElError } = construir(readFileSync, readdirSync, statSync, path, RAIZ);

// ─── El perímetro: el árbol propio ENTERO, menos lo que se declara ───────────
/**
 * Lo que NO se barre. Cada entrada es un DIRECTORIO con motivo escrito, y las que delegan en
 * otro guard llevan `guard:` — esa ruta se verifica abajo, porque una delegación a un archivo
 * que ya no existe es la costura de vuelta.
 */
const EXCLUIDOS = {
  'handlers': {
    guard: 'tests/handlers/lecturas-de-handlers.test.js',
    motivo: 'Perímetro del ítem 19: recursivo, con el corte por `verificarEscritura` que le '
      + 'pregunta al inventario y la exención de `nlp_errors`. Su subdirectorio `intents/` lo '
      + 'cubre a su vez `tests/handlers/lecturas-de-contenido.test.js`, por COMPORTAMIENTO y '
      + 'con 2 lecturas mudas declaradas a propósito. Fusionarlo acá perdería las dos cosas.',
  },
  'lib': {
    guard: 'tests/lib/lecturas-de-lib.test.js',
    motivo: 'Perímetro del ítem 20: `lib/` entero, recursivo, con sus tres guards de '
      + 'comportamiento (`lecturas-de-soporte`, `lecturas-de-infra`, `anuncio-de-soporte`). '
      + 'Los 39 sitios están limpios y el guard es el trinquete que los mantiene así.',
  },
  'node_modules': {
    motivo: 'Dependencias de terceros. No es código propio y no se arregla acá; barrerlo '
      + 'además haría que este guard tarde minutos en vez de milisegundos.',
  },
  'webapp': {
    motivo: 'Proyecto npm APARTE (Next.js) con su propio package.json, su propio vitest y su '
      + 'propio CI que gatea el deploy de Vercel. Sus guards viven ahí dentro '
      + '(`src/app/copy-claims.test.js`, `entrada-no-transparente.test.js`). Un guard de este '
      + 'proyecto que afirmara sobre el otro se saltearía el checkout que de verdad lo corre.',
  },
  'tests': {
    motivo: 'Los tests mismos. Una lectura muda en un fixture no le miente a ningún usuario, y '
      + 'los harness siembran datos con formas a propósito raras.',
  },
  'scripts': {
    motivo: 'Herramientas de línea de comandos que corre una persona mirando la salida. '
      + 'Medido el 31-ago-2026: 50 queries en 8 archivos. NO es que estén bien — es que el '
      + 'modo de fallo es distinto (un humano ve el resultado vacío en el momento) y meterlas '
      + 'acá mezclaría 50 sitios de tooling con los del producto. Si alguna vez un script '
      + 'escribe decisiones o plata sin supervisión, sale de esta lista.',
  },
  'qa-e2e': {
    motivo: 'Harness de QA: 319 queries en 42 archivos (medido el 31-ago-2026). Mismo '
      + 'argumento que `scripts/`, y con un agravante propio: acá una lectura que devuelve '
      + 'vacío se ve como un test que pasa. Eso es un problema real pero es OTRO —el de '
      + '`feedback_guards_que_no_ven`— y no se arregla exigiéndole `{ error }` a un fixture.',
  },
  'migrations': {
    motivo: 'SQL puro. Medido el 31-ago-2026: cero archivos .js/.mjs/.cjs, o sea que barrerlo '
      + 'no cambiaría ningún veredicto. Está declarado igual para que el día que alguien meta '
      + 'un runner .mjs acá dentro, la decisión de excluirlo tenga que re-tomarse a mano.',
  },
  'tasks': {
    motivo: 'Definiciones declarativas de tareas programadas. Medido el 31-ago-2026: cero '
      + 'archivos .js/.mjs/.cjs. Mismo argumento que migrations/: se declara para que dejar de '
      + 'ser cierto cueste una decisión y no pase inadvertido.',
  },
  'docs': {
    motivo: 'Markdown: DEFECTOS.md, runbooks y notas. No hay código que ejecute una query, y '
      + 'lo que se afirma sobre estos archivos lo vigila el drift-check del workspace, no un '
      + 'guard de lecturas.',
  },
  'assets': {
    motivo: 'Imágenes y estáticos que sirve el backend. No hay código propio acá: es la misma '
      + 'razón por la que no se barre content/, y las dos se declaran en vez de dejarse afuera '
      + 'por descuido del filtro de extensiones.',
  },
  'content': {
    motivo: 'Assets de contenido (reels, carruseles, captions) que no forman parte del runtime '
      + 'del backend: los consume Editor Pro Max, que es otro proyecto. Nada de lo que hay acá '
      + 'llega a producción por este package.json.',
  },
};

/**
 * Las extensiones que se barren. Mismo criterio que el guard de `lib/`: filtrar sólo por `.js`
 * sería una lista blanca por el otro eje, donde un `routes/x.mjs` nuevo nacería invisible.
 */
const EXTENSIONES = ['.js', '.mjs', '.cjs'];

/**
 * `excluidos` entra por PARÁMETRO —con el default real— para que la regla se pueda ejercitar
 * con un mapa sintético, igual que en `lecturas-de-lib.test.js`.
 */
function archivosJs(dirRel, excluidos = EXCLUIDOS) {
  const out = [];
  const base = dirRel ? path.join(RAIZ, dirRel) : RAIZ;
  for (const entrada of readdirSync(base)) {
    if (entrada.startsWith('.')) continue;   // .git, .claude, .github: no hay runtime ahí
    const rel = dirRel ? dirRel + '/' + entrada : entrada;
    const esDir = statSync(path.join(RAIZ, rel)).isDirectory();
    // La exclusión se consulta SÓLO para directorios: probada antes del `isDirectory()`, una
    // entrada de EXCLUIDOS podría sacar del barrido un ARCHIVO suelto, que es la evasión
    // barata (el piso de la antivacuidad tiene aire de sobra y una baja de uno no lo cruza).
    if (esDir) {
      if (excluidos[rel]) continue;
      out.push(...archivosJs(rel, excluidos));
      continue;
    }
    if (EXTENSIONES.some((e) => entrada.endsWith(e))) out.push(rel);
  }
  return out;
}

const ARCHIVOS = archivosJs('');
const HELPER = 'helpers/escritura-verificada';

/**
 * Sitios exentos, por (archivo, tabla) y con motivo. NO por número de línea: las líneas se
 * mueven y una exención por línea termina tapando el sitio equivocado sin avisar.
 *
 * **Vacío, y esta vez no había ni un candidato.** Los 46 sitios se leyeron uno por uno y los
 * 46 tenían un arreglo: unos fallan CERRADO (el anti-abuso de `/solicitud-pro`, los dos
 * pre-checks del escáner de Gmail, la purga de `conversaciones`) y otros fallan ABIERTO con el
 * log como único cambio (el envío de `/notificar`, el perfil de Google, la sugerencia de meta).
 * Lo que ninguno podía seguir haciendo era decidir con `undefined` y contestar como si supiera.
 */
const EXENTOS = [];

/** Las queries de un fuente, clasificadas con el parser del otro guard. */
function clasificarFuente(src, rel, exentos) {
  const lineas = src.split('\n');
  const exentosDelArchivo = exentos.filter((e) => e.archivo === rel);
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
  return { ...mudas, total, exentosVistos, usaHelper: src.includes(HELPER) };
}

const clasificar = (rel) => clasificarFuente(readFileSync(path.join(RAIZ, rel), 'utf-8'), rel, EXENTOS);
const CLASIFICADO = new Map(ARCHIVOS.map((rel) => [rel, clasificar(rel)]));

describe('el perímetro se deriva del árbol, no se escribe', () => {
  it('barre la raíz y los cuatro directorios de producción que quedaban sin guard', () => {
    // El piso es holgado a propósito: no es un conteo que haya que actualizar en cada commit,
    // es un detector de perímetro colapsado. **Medido el 31-ago-2026: 43 archivos** — y el
    // número va acá porque la primera versión decía 39, escrito sin medir. Lo que de verdad
    // impide que el perímetro se vacíe por partes es la lista de abajo, no el piso.
    expect(ARCHIVOS.length, 'el perímetro quedó vacío o casi').toBeGreaterThanOrEqual(30);
    // Los ocho que tenían sitios el 31-ago-2026, más los tres archivos de la raíz. Que sigan
    // adentro es lo que impide que un "arreglo" consista en sacarlos del barrido.
    for (const imprescindible of [
      'routes/admin.js', 'routes/public.js', 'routes/pro.js', 'routes/internal.js',
      'helpers/db-helpers.js', 'services/gmail-scanner.js', 'services/referrals.js',
      'services/notifications.js', 'index.js', 'gmail.js', 'cron/index.js',
    ]) {
      expect(ARCHIVOS, 'salió del barrido: ' + imprescindible).toContain(imprescindible);
    }
  });

  it('NO queda ningún directorio de primer nivel sin barrer ni excluido con motivo', () => {
    // **Ésta es la aserción que existe para que no haya un ítem 22 de esta misma clase.** Los
    // cuatro guards anteriores declaraban un perímetro POSITIVO, así que su complemento vivía
    // fuera de todo test y sólo aparecía cuando alguien iba a buscarlo — tres veces seguidas,
    // una sesión después. Acá el default es estar adentro: un directorio nuevo se barre solo, y
    // sacarlo cuesta escribir por qué.
    const dirs = readdirSync(RAIZ)
      .filter((e) => !e.startsWith('.'))
      .filter((e) => statSync(path.join(RAIZ, e)).isDirectory());
    const sinDeclarar = dirs.filter((d) => !EXCLUIDOS[d] && !ARCHIVOS.some((f) => f.startsWith(d + '/')));
    expect(sinDeclarar, 'directorios que no se barren y no están excluidos con motivo').toEqual([]);
  });

  it('cada exclusión que DELEGA nombra un guard que existe y que sigue mirando ese directorio', () => {
    // Sin esto, borrar `tests/lib/lecturas-de-lib.test.js` dejaría `lib/` sin ningún guard y
    // este archivo seguiría verde, porque lo excluye. Es la costura del ítem 20 reconstruida
    // por la puerta de atrás.
    //
    // **Lo que este caso comprueba, dicho con precisión:** que el archivo existe y que su
    // fuente todavía nombra el directorio como perímetro. NO comprueba que sus aserciones
    // corran ni que pasen — para eso está la suite entera. Es el chequeo más fuerte posible sin
    // importar un archivo de tests desde otro (lo que registraría sus `describe` dos veces).
    const delegan = Object.entries(EXCLUIDOS).filter(([, v]) => v.guard);
    expect(delegan.length, 'se perdieron las delegaciones: revisá EXCLUIDOS').toBe(2);
    for (const [dir, { guard }] of delegan) {
      expect(existsSync(path.join(RAIZ, guard)),
        'la exclusión de `' + dir + '/` delega en ' + guard + ', que YA NO EXISTE: ese '
        + 'directorio quedó sin ningún guard. O traés su perímetro acá, o restaurás el archivo').toBe(true);
      const src = readFileSync(path.join(RAIZ, guard), 'utf-8');
      expect(src.includes("archivosJs('" + dir + "')"),
        guard + ' ya no deriva su perímetro de `' + dir + '/`: la exclusión de acá quedó '
        + 'apuntando a un guard que mira otra cosa').toBe(true);
    }
  });

  it('toda exclusión apunta a un directorio que EXISTE', () => {
    // Una exclusión muerta no es inocua: si mañana alguien crea un directorio con ese nombre,
    // nace excluido y en silencio, con un motivo escrito para otra cosa.
    for (const rel of Object.keys(EXCLUIDOS)) {
      expect(existsSync(path.join(RAIZ, rel)),
        'EXCLUIDOS declara `' + rel + '`, que no existe: borrá la entrada').toBe(true);
      expect(statSync(path.join(RAIZ, rel)).isDirectory(),
        'EXCLUIDOS sólo admite directorios, y ' + rel + ' no lo es').toBe(true);
      expect(EXCLUIDOS[rel].motivo.length, 'toda exclusión lleva motivo escrito').toBeGreaterThan(60);
    }
  });

  it('una exclusión NO puede sacar un archivo suelto del barrido', () => {
    // Sacar un directorio es una decisión visible (queda su nombre y su motivo); sacar un
    // ARCHIVO es la evasión barata. Se ejercita con un mapa SINTÉTICO porque recorrer el real
    // no distingue las dos reglas.
    const conArchivo = archivosJs('routes', { 'routes/admin.js': 'intento de evasión' });
    expect(conArchivo, 'una entrada de EXCLUIDOS logró sacar un archivo del barrido').toContain('routes/admin.js');

    // Y el control: sobre un DIRECTORIO la exclusión sí manda, o sea que la regla no es
    // "EXCLUIDOS no hace nada".
    const conDir = archivosJs('services', { 'services/subscriptions': 'excluido para este caso' });
    expect(conDir.some((f) => f.startsWith('services/subscriptions/')),
      'la exclusión dejó de excluir directorios: ahora no sirve para nada').toBe(false);
  });

  it('es RECURSIVO y barre .mjs (un services/subscriptions/ nuevo no se escapa)', () => {
    // La recursión no se comprueba sobre una función sintética: el árbol real ya la ejercita,
    // porque `services/subscriptions/` está dos niveles abajo.
    expect(ARCHIVOS.some((f) => f.split('/').length > 2),
      'archivosJs dejó de recursar: un subdirectorio nuevo quedaría invisible').toBe(true);
    expect(ARCHIVOS).toContain('services/subscriptions/detector.js');
    // Y que el filtro de extensiones no volvió a ser sólo `.js`. Hoy el perímetro es todo
    // `.js`, así que la propiedad se comprueba sobre la FUNCIÓN, contra un directorio que sí
    // tiene `.mjs`. Ésta es la aserción que muere si alguien vuelve a `entrada.endsWith('.js')`.
    expect(archivosJs('scripts', {}).some((f) => f.endsWith('.mjs')),
      'archivosJs volvió a mirar sólo .js: un routes/x.mjs quedaría fuera del barrido').toBe(true);
  });
});

describe('antivacuidad: el parser mira algo y discrimina', () => {
  it('el parser ENCUENTRA queries en el perímetro (si devuelve 0, no está midiendo)', () => {
    const total = [...CLASIFICADO.values()].reduce((s, c) => s + c.total, 0);
    // Un parser roto —o un recorte que se trajo la mitad del archivo— devuelve listas vacías y
    // este guard saldría verde sin haber mirado una sola query.
    //
    // **Medido el 31-ago-2026: 237 queries en 43 archivos.** La primera versión decía 66 con un
    // piso de 45, escrito sin medir, y eso no era un detalle cosmético: con 237 reales, un piso
    // de 45 deja pasar un parser que perdió el 80% de los sitios, que es exactamente el modo de
    // fallo que este caso viene a cerrar. El piso de 150 sigue siendo holgado —no hay que
    // tocarlo cuando alguien agrega una query— pero ya no es indistinguible de no mirar.
    expect(total, 'el parser no encontró NINGUNA query en el perímetro: está roto, no limpio').toBeGreaterThan(150);
  });

  it('el parser DETECTA una lectura muda sembrada, y NO marca una sana', () => {
    // Sobre fuente sintética, no sobre un archivo del árbol: anclar la antivacuidad a un
    // defecto real la mata el día que ese defecto se arregla (`antivacuidad-anclada-al-defecto`).
    const evaluar = (src) => lecturas(src, 'fixture.js')
      .filter((q) => q.lhs === null || !leeElError(q.lhs, q.indice)).length;
    const muda = 'async function f() {\n  const { data } = await supabase.from("usuarios").select("*").eq("id", 1);\n  return data;\n}\n';
    const sana = 'async function f() {\n  const { data, error } = await supabase.from("usuarios").select("*").eq("id", 1);\n  if (error) throw error;\n  return data;\n}\n';
    expect(evaluar(muda), 'el detector no ve una lectura muda evidente').toBe(1);
    expect(evaluar(sana), 'el detector marca como muda una lectura que SÍ lee el error').toBe(0);
  });

  it('ve el destructuring de un `Promise.all`, que es como está escrito el cron de Gmail', () => {
    // `const [{ data: a, error: e1 }, { data: b, error: e2 }] = await Promise.all([...])`.
    // Sin esta capacidad del parser, las dos lecturas que deciden a quién se le escanea el
    // correo habrían salido limpias mudas y el arreglo se habría escrito en otro lado.
    const evaluar = (src) => lecturas(src, 'fixture.js')
      .filter((q) => q.lhs === null || !leeElError(q.lhs, q.indice)).length;
    const mudo = 'async function f() {\n'
      + '  const [{ data: a }, { data: b }] = await Promise.all([\n'
      + '    supabase.from("usuarios").select("*"),\n'
      + '    supabase.from("gmail_cuentas").select("usuario_id"),\n'
      + '  ]);\n  return [a, b];\n}\n';
    const sano = 'async function f() {\n'
      + '  const [{ data: a, error: e1 }, { data: b, error: e2 }] = await Promise.all([\n'
      + '    supabase.from("usuarios").select("*"),\n'
      + '    supabase.from("gmail_cuentas").select("usuario_id"),\n'
      + '  ]);\n  if (e1 || e2) throw e1 || e2;\n  return [a, b];\n}\n';
    expect(evaluar(mudo), 'las dos queries del Promise.all mudo no se detectan').toBe(2);
    expect(evaluar(sano), 'el Promise.all que SÍ lee sus errores se reporta como mudo').toBe(0);
  });

  it('LÍMITE FIJADO: destructurar `error` y no usarlo pasa como sano', () => {
    // Esto NO es lo deseable: es lo que el parser compartido hace hoy, medido. Se fija acá para
    // que nadie le crea a este guard más de lo que mide — y para que el día que alguien apriete
    // el parser (cambiando veredictos en los CUATRO perímetros que lo usan) este caso se ponga
    // rojo y lo mande a leer esta nota en vez de sorprenderse.
    //
    // Lo que SÍ atrapa este agujero es el test por sitio: la mutación "quitarle a `/pendientes`
    // su `if (error)` dejando el destructuring" deja este archivo VERDE y mata
    // `tests/routes/lecturas-de-rutas.test.js`.
    const destructuraSinUsar = 'async function f() {\n  const { data, error } = await supabase.from("usuarios").select("*").eq("id", 1);\n  return data;\n}\n';
    const evaluar = (src) => lecturas(src, 'fixture.js')
      .filter((q) => q.lhs === null || !leeElError(q.lhs, q.indice)).length;
    expect(evaluar(destructuraSinUsar), 'el parser se apretó: revisá los otros tres perímetros').toBe(0);
  });

  it('la maquinaria de exenciones funciona, aunque hoy la lista esté VACÍA', () => {
    // Sin esto, el camino de las exenciones no se ejecuta nunca (EXENTOS = []) y podría estar
    // roto desde el día uno: la primera exención que alguien agregue saldría verde sin eximir
    // nada, o —peor— eximiendo de más.
    //
    // Comillas SIMPLES en el fixture, y no es cosmético: `exentoEn` busca la cadena literal
    // `('<tabla>'`. Todo el repo usa simples, por eso el matcher alcanza.
    const src = 'async function f() {\n'
      + "  await supabase.from('telemetria').insert({ a: 1 });\n"
      + "  await supabase.from('plata').insert({ b: 2 });\n"
      + '}\n';
    const sinExenciones = clasificarFuente(src, 'routes/fixture.js', []);
    expect(sinExenciones.escrituras.length, 'el fixture ya no tiene dos escrituras mudas').toBe(2);

    const conExencion = clasificarFuente(src, 'routes/fixture.js',
      [{ archivo: 'routes/fixture.js', tabla: 'telemetria', motivo: 'x'.repeat(80) }]);
    expect(conExencion.escrituras.length, 'la exención no eximió su sitio').toBe(1);
    expect(conExencion.exentosVistos.has('telemetria'), 'la exención no quedó registrada como vista').toBe(true);

    // Y que NO exime de más: la exención es por (archivo, tabla).
    const otraTabla = clasificarFuente(src, 'routes/fixture.js',
      [{ archivo: 'routes/fixture.js', tabla: 'no_existe', motivo: 'x'.repeat(80) }]);
    expect(otraTabla.escrituras.length, 'una exención que no matchea igual eximió algo').toBe(2);
    expect(otraTabla.exentosVistos.size, 'una exención muerta se anotó como vista').toBe(0);
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

describe('el resto del árbol: ninguna query descarta su { error }', () => {
  it.each(ARCHIVOS)('%s', (rel) => {
    const { lecturas: lm, escrituras: em } = CLASIFICADO.get(rel);
    // supabase-js NUNCA lanza. Sin leer `{ error }`, un fallo de infraestructura sale por la
    // misma puerta que "no había nada": el admin lee "Usuario no encontrado" sobre alguien que
    // sí está, o el panel dice "no hay pagos pendientes" sobre alguien que acaba de pagar.
    // Molde del arreglo: `resolverSolicitudPro` en handlers/admin-commands.js — `maybeSingle`
    // + `if (error)` SEPARADO del `if (!data)`, porque con `.single()` y cero filas el error es
    // PGRST116 y un `if (error)` a secas cambia la mentira por la simétrica.
    expect(lm, 'lecturas mudas en ' + rel + ' (líneas)').toEqual([]);
    expect(em, 'escrituras sin destructuring en ' + rel + ' (líneas)').toEqual([]);
  });

  it('TRIPWIRE: nadie en este perímetro usa verificarEscritura todavía', () => {
    // En `handlers/` hay un corte por este helper, porque `webhook.js` envuelve escrituras con
    // él y el parser crudo las reporta como mudas; ese guard le PREGUNTA al inventario en vez
    // de re-implementar la regla. Acá no existe ese corte porque no hay a quién aplicárselo
    // (medido: los 9 archivos que lo importan están todos en `handlers/`), y copiarlo habría
    // dejado un `it.each([])` — cero tests que se leen como que pasaron.
    //
    // El día que un archivo de este perímetro importe el helper, esto se pone rojo: no está
    // prohibido usarlo, hay que traer el reparto ANTES o este guard empieza a reportar falsos
    // positivos sobre escrituras que sí leen su error.
    const usan = ARCHIVOS.filter((rel) => CLASIFICADO.get(rel).usaHelper);
    expect(usan, 'este perímetro empezó a usar verificarEscritura: traé el reparto con el '
      + 'inventario (ver tests/handlers/lecturas-de-handlers.test.js, `CON_HELPER`)').toEqual([]);
  });
});
