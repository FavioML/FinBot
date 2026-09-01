import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * LA MISMA COSTURA, EN `lib/` (ítem 20 del backlog).
 *
 * El ítem 19 cerró `handlers/` y al hacerlo dejó escrito que `lib/` seguía afuera. Los tres
 * guards de lecturas mudas que existían lo dejaban en el medio:
 *
 *   · `tests/handlers/lecturas-de-contenido.test.js`  →  `handlers/intents/`
 *   · `tests/handlers/lecturas-de-handlers.test.js`   →  `handlers/` (recursivo)
 *   · `tests/cron/lecturas-leen-el-error.test.js`     →  `cron/checks.js` + el cierre
 *                                                        transitivo de `services/`
 *
 * El de crons excluye `lib/` a mano, con un comentario que dice *"`lib/` es infraestructura,
 * no queries de cron"*. Es cierto **para ese guard** y no dice nada sobre el resto: explica por
 * qué no es asunto suyo, no por qué no era asunto de nadie. Once sitios vivían ahí.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * ESTO NO CIERRA EL PROBLEMA, Y EL NÚMERO ESTÁ MEDIDO
 *
 * Cerrar `lib/` **no** deja el repo cubierto, y decirlo importa porque la frase natural —"los
 * cuatro guards ya barren todo"— es la que hace que nadie vuelva a mirar. Corriendo este mismo
 * parser sobre lo que queda afuera de los cuatro perímetros (31-ago-2026): **46 sitios mudos en
 * 8 archivos**.
 *
 *   | archivo | mudos |          | archivo | mudos |
 *   |---|---|                    |---|---|
 *   | `routes/admin.js`          | 14 |  | `services/referrals.js`     | 4 |
 *   | `helpers/db-helpers.js`    | 10 |  | `routes/pro.js`             | 3 |
 *   | `services/gmail-scanner.js`|  7 |  | `services/notifications.js` | 2 |
 *   | `routes/public.js`         |  5 |  | `routes/internal.js`        | 1 |
 *
 * Y no son de relleno: `routes/admin.js:58` es literalmente el arquetipo que los comentarios de
 * este trabajo citan dos veces —`.single()` sin leer el error, y un `if (!data)` que contesta
 * **404 "Usuario no encontrado"**—, en la ruta `/admin/activar`. **CORRECCIÓN (31-ago): acá
 * decía "en la ruta que activa Pro después de un pago" y es falso.** `/activar` es el comp a
 * mano, con "sin pago de por medio" escrito en su propio comentario; la ruta del pago es
 * `/aprobar-pago`, que ya leía su error desde antes. El SITIO estaba bien medido y la frase
 * pegada al lado no, que es la clase `feedback_numeros_sin_medicion` en su forma más barata.
 * La mentira que el sitio produce es la misma —al admin se le dice que ese usuario no existe—
 * y el arreglo no cambia; lo que cambiaba era a quién le pasa. Quedó como
 * ítem 21 del backlog con la medición hecha; no entra acá de arrastre por el mismo motivo por
 * el que `lib/` no entró en el guard del ítem 19.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * EL PERÍMETRO ES `lib/` ENTERO, Y ESA FUE LA DECISIÓN QUE HABÍA QUE TOMAR
 *
 * La alternativa era barrer sólo "lo que decide algo", porque en `lib/` hay infra pura
 * (`crypto.js`, `formatters.js`, `dates.js`). Se descartó por dos motivos medidos acá:
 *
 *   · **Un recorte por criterio hay que mantenerlo, y el default queda del lado malo.** Un
 *     archivo nuevo nace FUERA de una lista blanca y nadie se entera; nace DENTRO de una
 *     lista negra y, si de verdad no corresponde, cuesta escribir el motivo. Es la misma
 *     forma que ya eligieron sus dos hermanos (`canal-unico-sin-cuenta-web`,
 *     `email-necesita-su-columna`).
 *   · **El recorte no compraba nada.** Los 28 archivos de `lib/` suman 39 queries y hoy están
 *     TODAS limpias. Un perímetro más chico habría sido menos cobertura al mismo precio.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * LO QUE SE COPIÓ DEL GUARD DEL 19, Y LAS DOS COSAS QUE NO
 *
 * Se copió: el parser tomado (no duplicado) del guard de crons, el perímetro recursivo en
 * lista negra, las exenciones por (archivo, tabla) con motivo obligatorio, y la antivacuidad.
 *
 * **1. No hay reparto con el inventario, porque en `lib/` nadie usa `verificarEscritura`.**
 * En `handlers/` ese corte existe por `webhook.js`, que envuelve 6 escrituras con el helper y
 * el parser crudo las reporta como mudas. Acá el helper no aparece en ningún archivo (medido),
 * así que copiar el corte habría dejado un `it.each([])` — que vitest reporta como CERO tests
 * y se lee como que pasó. En su lugar va un TRIPWIRE: se afirma que nadie lo usa. El día que
 * alguien lo use, esto se pone rojo y obliga a traer el reparto en vez de empezar a reportar
 * falsos positivos.
 *
 * **2. No hay exenciones, y `error-monitor.js` es el motivo por el que hay que leer y no
 * copiar.** El backlog llegó apostando a que el `insert` a `errores` sería una exención con
 * motivo, como las tres de `nlp_errors` del guard del 19. Al leerlo, el argumento no
 * sobrevivió: la recursión que justificaría eximirlo no existe (el log es pino a stdout, no
 * vuelve a `registrarError`), el insert ya se `await`ea, y lo que se pierde en silencio es la
 * tabla donde se cruzan los stacks de producción. Se arregló. La maquinaria de exenciones se
 * queda igual —vacía, y con su propio test sintético para que no se pudra sin usarse— porque
 * lo que tiene que costar es la PRÓXIMA exención, no ésta.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * LO QUE ESTE ARCHIVO NO PRUEBA, DECLARADO
 *
 * Mide UNA forma: que el `{ error }` se **destructure**. NO exige que se CONSULTE, y eso está
 * medido: un `const { data, error } = await supabase…` que nunca mira `error` sale limpio (hay
 * un caso abajo que lo fija). El límite es del parser compartido, o sea que vale igual para
 * los otros tres perímetros; apretarlo cambiaría veredictos en cuatro guards a la vez y es su
 * propia tanda.
 *
 * El reparto real, igual que en el 19: **acá la forma, y el comportamiento en otros tres
 * archivos**, que ejercitan cada sitio con la tabla caída y afirman qué se le contesta a la
 * persona:
 *
 *   · `tests/lib/lecturas-de-soporte.test.js`      — los 9 sitios de `lib/support-tickets.js`
 *   · `tests/lib/lecturas-de-infra.test.js`        — `isTestUser` y `registrarError`
 *   · `tests/handlers/anuncio-de-soporte.test.js`  — lo que `/soporte` y `/salir` ANUNCIAN
 *     cuando la sesión no se abrió ni se cerró (su gemelo por NLP está en
 *     `escrituras-de-intents.test.js`, `hablar_con_humano`)
 *
 * La segunda mitad no es opcional — la mutación que lo demuestra está escrita en el primero.
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
    + 'scripts/inventario-escrituras-intents.mjs y tests/handlers/lecturas-de-handlers.test.js, '
    + 'así que los tres se arreglan igual.'
  );
}
const cuerpo = fuenteGuard.slice(desde, hasta).replace('const RAIZ = process.cwd();', '');
const construir = new Function('readFileSync', 'readdirSync', 'statSync', 'path', 'RAIZ',
  cuerpo + '\nreturn { lecturas, leeElError };');
const { lecturas, leeElError } = construir(readFileSync, readdirSync, statSync, path, RAIZ);

// ─── El perímetro ────────────────────────────────────────────────────────────
/**
 * Lo que NO se barre, con su motivo. Vacío hoy: `lib/` no tiene subdirectorios y no hay ningún
 * archivo con una razón escrita para quedar afuera. Agregar una entrada acá es una DECISIÓN.
 */
const EXCLUIDOS = {};

/**
 * Las extensiones que se barren.
 *
 * **`.mjs` no es hipotética en este repo y `.cjs` sí, y la diferencia va dicha.** Medido el
 * 31-ago: **125 archivos `.mjs`** entre `scripts/` y `qa-e2e/`, y **cero `.cjs`** en todo el
 * código propio (un `find` por `.cjs` excluyendo `node_modules` sale vacío). O sea que la
 * que cierra una puerta real es `.mjs`; `.cjs` entra como seguro barato y **no está
 * ejercitada** — el caso de abajo la afirma contra esta constante, no contra el barrido.
 *
 * Filtrar sólo por `.js` sería la misma falla que el docblock de arriba argumenta para los
 * directorios —una lista blanca donde lo nuevo nace afuera y en silencio— movida al otro eje.
 */
const EXTENSIONES = ['.js', '.mjs', '.cjs'];

/**
 * `excluidos` entra por PARÁMETRO —con el default real— para que la regla se pueda ejercitar
 * con un mapa sintético. Con `EXCLUIDOS` vacío, un test que recorra la lista real no comprueba
 * nada y se lee como que sí.
 */
function archivosJs(dirRel, excluidos = EXCLUIDOS) {
  const out = [];
  for (const entrada of readdirSync(path.join(RAIZ, dirRel))) {
    const rel = dirRel + '/' + entrada;
    const esDir = statSync(path.join(RAIZ, rel)).isDirectory();
    // La exclusión se consulta SÓLO para directorios, y eso es la mitad del control: probada
    // antes del `isDirectory()`, una entrada de `EXCLUIDOS` podía sacar del barrido un ARCHIVO
    // suelto — la evasión barata, porque el piso de la antivacuidad tiene aire de sobra sobre
    // el conteo real y una baja de uno no lo cruza.
    if (esDir) {
      if (excluidos[rel]) continue;
      out.push(...archivosJs(rel, excluidos));
      continue;
    }
    if (EXTENSIONES.some((e) => entrada.endsWith(e))) out.push(rel);
  }
  return out;
}

const ARCHIVOS = archivosJs('lib');
const HELPER = 'helpers/escritura-verificada';

/**
 * Sitios exentos, por (archivo, tabla) y con motivo. NO por número de línea: las líneas se
 * mueven y una exención por línea termina tapando el sitio equivocado sin avisar.
 *
 * **Vacío a propósito.** Ver el docblock de arriba: el candidato que traía el backlog
 * (`lib/error-monitor.js` / `errores`) no sobrevivió a leerlo.
 */
const EXENTOS = [];

/**
 * Las queries de un fuente, clasificadas con el parser del otro guard.
 *
 * Toma el fuente y la lista de exenciones por PARÁMETRO —y no los lee de arriba— para que el
 * camino de las exenciones se pueda ejercitar con un fixture sintético. Con `EXENTOS` vacío,
 * un `for` sobre la lista real no ejecuta nada y el día que alguien agregue la primera se
 * entera ahí si estaba rota.
 */
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

describe('antivacuidad: el guard mira algo, y el parser funciona', () => {
  it('el perímetro no se vació', () => {
    // Si alguien mueve `lib/` o le pone una exclusión de más, esto lo dice en vez de salir
    // verde sobre cero archivos. El piso es holgado a propósito: no es un conteo que haya que
    // actualizar en cada commit, es un detector de perímetro colapsado.
    expect(ARCHIVOS.length, 'el perímetro de lib/ quedó vacío o casi').toBeGreaterThanOrEqual(20);
    // Los tres que tenían sitios el 31-ago-2026. Que sigan adentro es lo que impide que un
    // "arreglo" consista en sacarlos del barrido.
    for (const imprescindible of ['lib/support-tickets.js', 'lib/whatsapp.js', 'lib/error-monitor.js']) {
      expect(ARCHIVOS).toContain(imprescindible);
    }
  });

  it('es RECURSIVO: un subdirectorio de lib/ no se escapa solo', () => {
    // La evasión que este diseño cierra. Hoy `lib/` es plano, así que se comprueba la FUNCIÓN
    // y no el árbol: si `archivosJs` dejara de recursar, un `lib/canales/` nuevo saldría
    // invisible y nadie se enteraría. Verificado a mano creando el directorio con una lectura
    // muda adentro: el guard saca dos rojos (el archivo, y el subdirectorio no declarado).
    const subdirs = readdirSync(path.join(RAIZ, 'lib'))
      .filter((e) => statSync(path.join(RAIZ, 'lib', e)).isDirectory())
      .map((e) => 'lib/' + e);
    for (const d of subdirs) {
      expect(EXCLUIDOS[d], 'el subdirectorio ' + d + ' no está barrido ni excluido con motivo').toBeTruthy();
    }
    // Y que la recursión existe de verdad, sobre un árbol sintético: sin esto, el bucle de
    // arriba pasa en verde por vacío mientras `archivosJs` es plano.
    expect(archivosJs('tests').some((f) => f.split('/').length > 2),
      'archivosJs dejó de recursar: un subdirectorio nuevo de lib/ quedaría invisible').toBe(true);
  });

  it('una exclusión NO puede sacar un archivo suelto del barrido', () => {
    // Sacar un directorio es una decisión visible (queda su nombre y su motivo); sacar un
    // ARCHIVO es la evasión barata, porque el piso de la antivacuidad tiene aire de sobra sobre
    // el conteo real y una baja de uno no lo cruza. Cerrar esa puerta es más honesto que
    // apretar el piso hasta volverlo un número que hay que actualizar en cada commit.
    //
    // Se ejercita con un mapa SINTÉTICO: recorrer `EXCLUIDOS`, que hoy está vacío, sería un
    // bucle sin iteraciones leyéndose como verde.
    const conArchivo = archivosJs('lib', { 'lib/support-tickets.js': 'intento de evasión' });
    expect(conArchivo, 'una entrada de EXCLUIDOS logró sacar un archivo del barrido').toContain('lib/support-tickets.js');

    // Y el control: sobre un DIRECTORIO la exclusión sí manda, o sea que la regla no es
    // "EXCLUIDOS no hace nada".
    const conDir = archivosJs('tests', { 'tests/lib': 'excluido a propósito para este caso' });
    expect(conDir.some((f) => f.startsWith('tests/lib/')),
      'la exclusión dejó de excluir directorios: ahora no sirve para nada').toBe(false);

    // Lo real, además, sigue siendo sólo directorios. **Este bucle itera cero veces hoy**
    // (`EXCLUIDOS` está vacío), que es la forma que el docblock de arriba critica — se queda
    // porque las dos aserciones sintéticas de arriba ya cargan el caso, y ésta es la que va a
    // hablar el día que alguien agregue la primera exclusión real.
    for (const rel of Object.keys(EXCLUIDOS)) {
      expect(statSync(path.join(RAIZ, rel)).isDirectory(),
        'EXCLUIDOS sólo admite directorios, y ' + rel + ' no lo es').toBe(true);
    }
  });

  it('barre .mjs de verdad; .cjs va declarada y NO ejercitada', () => {
    // Hoy `lib/` es todo `.js`, así que la propiedad se comprueba sobre la FUNCIÓN: `scripts/`
    // y `qa-e2e/` tienen 125 `.mjs`, o sea que un `lib/x.mjs` es una forma que ya se escribe
    // acá. Con el filtro viejo (`entrada.endsWith('.js')`) salía invisible. **Ésta es la
    // aserción que discrimina**: muere si alguien vuelve al filtro viejo.
    expect(archivosJs('scripts').some((f) => f.endsWith('.mjs')),
      'archivosJs volvió a mirar sólo .js: un lib/*.mjs quedaría fuera del barrido').toBe(true);

    // Y ésta NO discrimina, y va dicho en vez de disfrazado: no hay un solo `.cjs` propio en el
    // repo, así que sobre el árbol real es indistinguible de no barrerlo. Se afirma contra la
    // constante a propósito —es un seguro hacia adelante— y el día que aparezca el primer
    // `.cjs` esta línea deja de ser decorativa sola.
    expect(EXTENSIONES).toEqual(expect.arrayContaining(['.js', '.mjs', '.cjs']));
  });

  it('el parser ENCUENTRA queries en el perímetro (si devuelve 0, no está midiendo)', () => {
    const total = [...CLASIFICADO.values()].reduce((s, c) => s + c.total, 0);
    // Un parser roto —o un recorte que se trajo la mitad del archivo— devuelve listas vacías y
    // este guard saldría verde sin haber mirado una sola query. Es el primer modo de fallo que
    // describe `feedback_guards_que_no_ven`. Medido el 31-ago-2026: 39.
    expect(total, 'el parser no encontró NINGUNA query en lib/: está roto, no limpio').toBeGreaterThan(25);
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

  it('el parser sigue el patrón BUILDER, que es como está escrito `cerrarSesion`', () => {
    // `let q = supabase.from(...)` arriba y `const { data, error } = await q` abajo: el error
    // sólo existe en la última línea. Sin esta capacidad del parser, arreglar `cerrarSesion`
    // no habría bajado el conteo y el arreglo se habría escrito en el lugar equivocado.
    const evaluar = (src) => lecturas(src, 'fixture.js')
      .filter((q) => q.lhs === null || !leeElError(q.lhs, q.indice)).length;
    const builderMudo = 'async function f(id) {\n  let q = supabase.from("t").select("id");\n  q = q.eq("id", id);\n  const { data } = await q;\n  return data;\n}\n';
    const builderSano = 'async function f(id) {\n  let q = supabase.from("t").select("id");\n  q = q.eq("id", id);\n  const { data, error } = await q;\n  if (error) throw error;\n  return data;\n}\n';
    expect(evaluar(builderMudo), 'el builder mudo no se detecta').toBe(1);
    expect(evaluar(builderSano), 'el builder sano se reporta como mudo: falso positivo').toBe(0);
  });

  it('LÍMITE FIJADO: destructurar `error` y no usarlo pasa como sano', () => {
    // Esto NO es lo deseable: es lo que el parser compartido hace hoy, medido. Se fija acá para
    // que nadie le crea a este guard más de lo que mide — y para que el día que alguien apriete
    // el parser (cambiando veredictos en los CUATRO perímetros que lo usan) este caso se ponga
    // rojo y lo mande a leer esta nota en vez de sorprenderse.
    //
    // Lo que SÍ atrapa este agujero es el test por sitio, en `lecturas-de-soporte.test.js`.
    const destructuraSinUsar = 'async function f() {\n  const { data, error } = await supabase.from("usuarios").select("*").eq("id", 1);\n  return data;\n}\n';
    const evaluar = (src) => lecturas(src, 'fixture.js')
      .filter((q) => q.lhs === null || !leeElError(q.lhs, q.indice)).length;
    expect(evaluar(destructuraSinUsar), 'el parser se apretó: revisá los otros tres perímetros').toBe(0);
  });

  it('la maquinaria de exenciones funciona, aunque hoy la lista esté VACÍA', () => {
    // Sin esto, el camino de las exenciones no se ejecuta nunca (EXENTOS = []) y podría estar
    // roto desde el día uno: la primera exención que alguien agregue saldría verde sin eximir
    // nada, o —peor— eximiendo de más. Se ejercita sobre fuente sintética con dos tablas para
    // que el match por tabla tenga algo que discriminar.
    //
    // **Comillas SIMPLES en el fixture, y no es cosmético:** `exentoEn` busca la cadena
    // literal `('<tabla>'`, así que una exención sobre un `supabase.from("tabla")` escrito con
    // comillas dobles NO matchearía y saldría como exención muerta. Todo el repo usa simples
    // —por eso el matcher alcanza— pero el día que eso cambie, el rojo va a salir del test de
    // "cada exención matchea algo" y esta nota dice dónde mirar.
    const src = 'async function f() {\n'
      + "  await supabase.from('telemetria').insert({ a: 1 });\n"
      + "  await supabase.from('plata').insert({ b: 2 });\n"
      + '}\n';
    const sinExenciones = clasificarFuente(src, 'lib/fixture.js', []);
    expect(sinExenciones.escrituras.length, 'el fixture ya no tiene dos escrituras mudas').toBe(2);

    const conExencion = clasificarFuente(src, 'lib/fixture.js',
      [{ archivo: 'lib/fixture.js', tabla: 'telemetria', motivo: 'x'.repeat(80) }]);
    expect(conExencion.escrituras.length, 'la exención no eximió su sitio').toBe(1);
    expect(conExencion.exentosVistos.has('telemetria'), 'la exención no quedó registrada como vista').toBe(true);

    // Y que NO exime de más: la exención es por (archivo, tabla), así que una tabla que no
    // matchea no puede llevarse puesto el sitio de al lado.
    const otraTabla = clasificarFuente(src, 'lib/fixture.js',
      [{ archivo: 'lib/fixture.js', tabla: 'no_existe', motivo: 'x'.repeat(80) }]);
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

describe('lib/: ninguna query descarta su { error }', () => {
  it.each(ARCHIVOS)('%s', (rel) => {
    const { lecturas: lm, escrituras: em } = CLASIFICADO.get(rel);
    // supabase-js NUNCA lanza. Sin leer `{ error }`, un fallo de infraestructura sale por la
    // misma puerta que "no había nada": la persona lee "no encontré" y va a buscar algo que sí
    // está. Molde del arreglo: `resolverSolicitudPro` en handlers/admin-commands.js
    // (`maybeSingle` + `if (error)` separado del `if (!data)`).
    expect(lm, 'lecturas mudas en ' + rel + ' (líneas)').toEqual([]);
    expect(em, 'escrituras sin destructuring en ' + rel + ' (líneas)').toEqual([]);
  });

  it('TRIPWIRE: nadie en lib/ usa verificarEscritura todavía', () => {
    // En `handlers/` hay un corte por este helper, porque `webhook.js` envuelve escrituras con
    // él y el parser crudo las reporta como mudas; ese guard le PREGUNTA al inventario en vez
    // de re-implementar la regla. Acá no existe ese corte porque no hay a quién aplicárselo, y
    // copiarlo habría dejado un `it.each([])` — cero tests que se leen como que pasaron.
    //
    // El día que un archivo de `lib/` importe el helper, este test se pone rojo: no es que
    // esté prohibido usarlo, es que hay que traer el reparto con el inventario ANTES, o este
    // guard va a empezar a reportar falsos positivos sobre escrituras que sí leen su error.
    const usan = ARCHIVOS.filter((rel) => CLASIFICADO.get(rel).usaHelper);
    expect(usan, 'lib/ empezó a usar verificarEscritura: traé el reparto con el inventario '
      + '(ver tests/handlers/lecturas-de-handlers.test.js, `CON_HELPER`) antes de seguir').toEqual([]);
  });
});
