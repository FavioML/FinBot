import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { WATCH_PATTERNS, disparaBuildRailway } from '../qa-e2e/backend-deploy-fresh.mjs';
import { compilarPatrones, crearPredicado, evaluarReglas, verificarForma } from '../qa-e2e/lib/railway-watch.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * `qa-e2e/backend-deploy-fresh.mjs` decide si un archivo redespliega Railway. La verdad
 * vive en `railway.json` (`build.watchPatterns`), y desde el 07-ago-2026 el predicado se
 * DERIVA de ahí en vez de ser una segunda copia escrita a mano.
 *
 * **Ese cambio movió lo que este archivo tiene que probar.** Antes había dos listas y el
 * trabajo era compararlas; el problema es que el test comparaba PROYECCIONES de una contra
 * la otra —el conjunto de negados, el veredicto sobre los archivos que existen— y por cada
 * proyección hay mutaciones que no la cruzan. Medidas el 07-ago, las tres pasaban 5/5 en
 * verde mientras el harness sub-reportaba y `backend-deploy-fresh` daba PASS sobre un
 * backend genuinamente stale:
 *
 *   a) `if (f.startsWith('infra/')) return false;` en el cuerpo del predicado
 *   b) una tercera clave en el objeto de exclusiones (se comparaban dos claves fijas)
 *   c) `[..., '!infra/**', 'infra/**']`: se comparaba el conjunto, sin el orden
 *
 * Hoy (b) y (c) no se pueden escribir —no hay objeto de exclusiones, y una lista que se
 * re-incluye no compila— así que lo que queda por probar es otra cosa:
 *
 *   1. que el compilador implemente los patrones declarados, contra una reimplementación
 *      INDEPENDIENTE, sobre el árbol real y sobre probes DERIVADOS de cada patrón;
 *   2. que se niegue a adivinar donde no hay medición (formas nuevas, precedencia);
 *   3. que el predicado no tenga conocimiento propio de rutas — lo que mata (a).
 *
 * Lo que ningún test de este archivo puede ver es si el modelo coincide con **Railway**:
 * eso se mide, y lo mide `qa-e2e/backend-watchpatterns-real.mjs`.
 *
 * La lista es negra A PROPÓSITO: una carpeta de backend nueva se despliega por default.
 * Ver la sección de gates en CLAUDE.md y [[project_railway_deploy_gate]].
 */

const railway = JSON.parse(fs.readFileSync(path.join(projectRoot, 'railway.json'), 'utf8'));
const patronesDeclarados = railway.build?.watchPatterns;

const RE_DIR = /^([\w.@-]+)\/\*\*$/; //   `dir/**`
const RE_EXT_RAIZ = /^\/\*\.([\w]+)$/; // `/*.ext`, anclado a la raíz

/** Escapa lo que en una ruta es literal pero en una regex no. */
const lit = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Segunda implementación, y **por otro mecanismo a propósito**: traduce cada glob a una
 * expresión regular anclada, donde `qa-e2e/lib/railway-watch.mjs` usa `startsWith` /
 * `endsWith` / `includes`. La primera versión de este test era una copia literal de aquella
 * —mismos regex carácter por carácter, mismos closures—, o sea que solo detectaba que
 * alguien hubiera editado una de las dos; una confusión entre `startsWith` e `includes`
 * viajaba idéntica a las dos copias. Con regex ancladas, un `includes` de un lado se ve.
 *
 * Lo que **sigue sin poder ver**, y conviene no confundirlo: un error de CONCEPTO compartido.
 * Si creo que `!/*.md` ancla a la raíz y no es así, las dos implementaciones anclan y las dos
 * se equivocan igual. Eso solo lo zanja medir contra Railway.
 *
 * Solo soporta las formas que `railway.json` usa hoy y **tira** ante cualquier otra en vez de
 * asumir un default: un `return false` acá sería el fallo silencioso de siempre.
 */
function compilar(patrones) {
  return patrones.map((p) => {
    const negado = p.startsWith('!');
    const cuerpo = negado ? p.slice(1) : p;

    // Ojo con los anclajes: `$` matchea ANTES de un `\n` final y `.` no cruza saltos de
    // línea, así que las formas ingenuas (`^dir/.+$`, `^[^/]+\.ext$`) NO son equivalentes a
    // `startsWith`/`endsWith` sobre seis entradas — `webapp/` pelado, un archivo llamado
    // exactamente `.md`, y cualquier nombre con `\n`. Los midió una revisión adversarial y
    // los seis estaban verdes **por casualidad**: ningún probe los tocaba. Un test de
    // equivalencia que difiere de lo que dice comparar es peor que no tenerlo, así que acá
    // no hay `.`, no hay `$` suelto y las clases de caracteres permiten el caso vacío.
    if (cuerpo === '**') return { patron: p, negado, forma: 'todo', re: /^[\s\S]*$/ };

    let m = cuerpo.match(RE_DIR);
    // `dir/**` → todo lo que cuelga de un directorio con ese nombre, a CUALQUIER PROFUNDIDAD.
    // Acá decía `^dir/` —anclado— igual que el `startsWith` del otro lado: las dos copias de
    // acuerdo y las dos mal, hasta que el deploy de control `6de1392` lo midió (09-ago-2026).
    // El `(?:^|/)` es el arreglo, y es por SEGMENTO a propósito: ver la nota larga en
    // `qa-e2e/lib/railway-watch.mjs`, que explica por qué `midocs/` NO cae.
    if (m) return { patron: p, negado, forma: 'dir', clave: `${m[1]}/`, re: new RegExp(`(?:^|/)${lit(m[1])}/`) };

    // `/*.ext` — la barra inicial ANCLA A LA RAÍZ, así que el nombre no puede tener ninguna
    // barra. Medido el 08-ago con el deploy de control `00dd65d`, que tocó solo
    // `.claude/commands/deploy.md` —un `.md` anidado— y Railway construyó.
    m = cuerpo.match(RE_EXT_RAIZ);
    if (m) {
      return { patron: p, negado, forma: 'extRaiz', clave: `.${m[1]}`, re: new RegExp(`^[^/]*\\.${lit(m[1])}(?![\\s\\S])`) };
    }

    throw new Error(
      `forma de patrón no soportada por este test: "${p}". Alguien agregó un glob de una ` +
        `forma nueva a railway.json. Enseñale la forma a compilar() Y a compilarPatrones() ` +
        `en qa-e2e/lib/railway-watch.mjs — y medí antes qué hace Railway con ella.`,
    );
  });
}

/**
 * Semántica de lista de globs: gana el ÚLTIMO patrón que matchea.
 *
 * La guarda de entrada NO es semántica de globs —`**` matchea la cadena vacía— sino el
 * contrato del predicado: una entrada falsy no es un archivo, y `gh api compare` puede
 * devolver `null` en `previous_filename`. Va acá también porque este evaluador se compara
 * contra el predicado entero, no contra su compilador.
 */
function evaluarDeclarado(reglas, archivo) {
  if (!archivo) return false;
  let incluido = false;
  for (const r of reglas) if (r.re.test(archivo)) incluido = !r.negado;
  return incluido;
}

/**
 * Probes DERIVADOS de cada patrón declarado, no una lista escrita a mano.
 *
 * Es lo que reemplaza a la comparación de conjuntos, y es más fuerte por la misma razón
 * por la que el corpus real es mejor que una lista inventada: cubre lo que la config
 * declara HOY, no lo que se me ocurrió cuando escribí el test. Una exclusión nueva en
 * `railway.json` trae sus propios probes sola, incluso si no existe todavía ni un archivo
 * versionado bajo esa ruta — que era justo el agujero original.
 *
 * Cada forma incluye sus near-misses: el prefijo compartido (`webapp-otro/`), la ruta
 * anidada (`otro/webapp/`), el segmento parcial (`otrowebapp/`), el ancla de raíz. Son los
 * que separan prefijo de subcadena de segmento, y un patrón anclado de uno recursivo.
 *
 * **Ojo con lo que estos probes NO pueden hacer, y se pagó el 09-ago-2026.** `otro/webapp/`
 * ya existía acá y el test pasaba en verde con las DOS implementaciones tratándolo como
 * observado — porque este test solo compara una copia contra la otra, y estaban de acuerdo
 * en la respuesta equivocada. Lo que separa la verdad es medir contra Railway
 * (`qa-e2e/backend-watchpatterns-real.mjs`), que es quien lo atrapó.
 */
function probesDe(regla) {
  if (regla.forma === 'todo') {
    return ['PROBE.txt', 'a/PROBE.txt', 'a/b/c/PROBE.js', '.oculto/PROBE.yml'];
  }
  if (regla.forma === 'dir') {
    const dir = regla.clave; //          'webapp/'
    const base = dir.slice(0, -1); //    'webapp'
    return [
      `${dir}PROBE.txt`,
      `${dir}sub/PROBE.js`,
      `${dir}.oculto/PROBE.json`, // sub-directorio con punto: es el caso real de webapp/.claude/
      `${base}-otro/PROBE.txt`, //  near-miss: comparte prefijo, es otro directorio
      `otro/${dir}PROBE.txt`, //    ANIDADO: cae. No está anclado a la raíz (medido, 6de1392)
      `a/b/${dir}PROBE.txt`, //     el mismo caso, más profundo
      `otro${base}/PROBE.txt`, //   near-miss que separa SUBCADENA de SEGMENTO: contiene
      //                            `webapp/` pero su segmento es `otrowebapp`. NO cae.
      base, //                      el directorio como archivo suelto, sin barra
    ];
  }
  if (regla.forma === 'extRaiz') {
    const ext = regla.clave; // '.md'
    return [
      `PROBE${ext}`, //           raíz: cae en la exclusión
      `sub/PROBE${ext}`, //       anidado: NO cae (el ancla de raíz)
      `sub/dir/PROBE${ext}`,
      `PROBE${ext}.txt`, //       near-miss: la extensión no está al final
      `PROBE${ext}x`,
    ];
  }
  throw new Error(`probesDe() no sabe generar casos para la forma "${regla.forma}"`);
}

/**
 * El corpus son los archivos versionados de verdad, que es exactamente la forma de lo que
 * consume el harness (`gh api .../compare` devuelve paths de git). Una lista escrita a mano
 * solo probaría los casos que se me ocurrieron; el árbol real prueba los que existen.
 */
function archivosVersionados() {
  // `-z` porque `git ls-files` a secas ENTRECOMILLA las rutas no-ASCII y les mete escapes
  // octales: `docs/año.md` sale como `"docs/a\303\261o.md"`, o sea empezando con una comilla
  // en vez de con `docs/`. Las dos implementaciones coincidirían sobre esa cadena —ninguna la
  // reconoce como el directorio excluido— y la regla nunca quedaría ejercitada: verde por
  // vacuidad justo sobre la ruta rara. Hoy el árbol no tiene ninguna, así que era latente.
  // Con `-z` no hay quoting: los nombres vienen crudos, separados por NUL.
  const raw = execFileSync('git', ['ls-files', '-z'], { cwd: projectRoot, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  return raw.split('\0').map((s) => s.trim()).filter(Boolean);
}

/** Casos que el árbol de hoy no cubre pero la lista sí decide. */
const SINTETICOS = [
  'servicio-nuevo/index.js', // carpeta de backend NUEVA: tiene que desplegar por default
  'webapp/src/app/nuevo/page.tsx',
  'qa-e2e/harness-nuevo.mjs',
  'docs/NOTA-nueva.md',
  'NUEVO.md', // *.md de la raíz: excluido
  'lib/NUEVO.md', // el mismo .md pero anidado: NO excluido (el ancla de raíz)
  'package.json',
  '.github/workflows/ci.yml',
];

describe('watchPatterns de railway.json vs. el predicado del harness', () => {
  it('el harness decide con los patrones de railway.json, no con una copia', () => {
    expect(
      patronesDeclarados,
      'railway.json no tiene build.watchPatterns: si se quitó, Railway pasa a observar TODO ' +
        'y el harness ya no modela nada',
    ).toBeDefined();

    expect(
      WATCH_PATTERNS,
      'el harness dejó de leer railway.json y volvió a tener su propia lista. Es exactamente ' +
        'la duplicación que se sacó el 07-ago: se desincroniza SIN romperse, y el harness ' +
        'sigue verde dando veredictos equivocados.',
    ).toEqual(patronesDeclarados);
  });

  it('el predicado coincide con los patrones declarados sobre todo el árbol versionado', () => {
    const reglas = compilar(patronesDeclarados);
    const corpus = archivosVersionados();

    // Sin esto el test podría pasar por vacuidad si `git ls-files` devuelve nada.
    expect(corpus.length, 'git ls-files no devolvió archivos: el corpus quedó vacío').toBeGreaterThan(100);

    // Tripwire del quoting. Una entrada entrecomillada significa que alguien le sacó el `-z`
    // Y que existe una ruta no-ASCII: las dos implementaciones coincidirían sobre esa cadena
    // sin que ninguna reconozca el directorio, o sea acuerdo por vacuidad. Medido el 08-ago
    // con `docs/año-prueba.md`: sin `-z` el predicado dice que redespliega, con `-z` dice que
    // no, y la correcta es la segunda.
    expect(
      corpus.filter((f) => f.startsWith('"')),
      'hay rutas entrecomilladas en el corpus: falta el `-z` en git ls-files',
    ).toEqual([]);

    const divergen = corpus
      .map((f) => ({ f, declarado: evaluarDeclarado(reglas, f), harness: disparaBuildRailway(f) }))
      .filter((r) => r.declarado !== r.harness);

    expect(
      divergen.slice(0, 20),
      'el predicado no implementa lo que declaran los watchPatterns. ' +
        '`declarado` es lo que dice railway.json, `harness` lo que hace el predicado.',
    ).toEqual([]);
  });

  /**
   * El que reemplaza a la vieja comparación de conjuntos, y cierra el agujero original de
   * forma más robusta: los probes salen de los patrones, así que una exclusión sobre un
   * directorio que todavía no tiene un solo archivo versionado igual queda ejercitada.
   */
  it('también coinciden sobre probes derivados de cada patrón declarado', () => {
    const reglas = compilar(patronesDeclarados);
    const probes = [...new Set(reglas.flatMap(probesDe))];

    expect(probes.length, 'no se derivó ni un probe: revisá probesDe()').toBeGreaterThan(10);

    const divergen = probes
      .map((f) => ({ f, declarado: evaluarDeclarado(reglas, f), harness: disparaBuildRailway(f) }))
      .filter((r) => r.declarado !== r.harness);

    expect(divergen, 'divergencia sobre los probes derivados de los patrones').toEqual([]);
  });

  /**
   * Entradas adversariales, para que la equivalencia entre las dos implementaciones deje de
   * depender de que a alguien se le ocurra el caso. Las seis primeras son exactamente las que
   * una revisión adversarial encontró divergiendo mientras el test estaba verde: las dos
   * implementaciones no coincidían y **ningún probe las tocaba**.
   *
   * Solo una es producible por git (`.md`, que es un nombre de archivo legal), y ahí la
   * divergencia caía del lado peligroso: el harness lo excluía. Las otras no llegan por
   * `gh api compare`, pero un test que dice "estas dos cosas son equivalentes" y no lo son
   * envenena todo lo que se apoye en él después.
   */
  it('coinciden también sobre entradas adversariales, no solo sobre las verosímiles', () => {
    const reglas = compilar(patronesDeclarados);
    const raros = [
      'webapp/', 'docs/', 'qa-e2e/', //  el directorio pelado, con barra y nada detrás
      '.md', //                          archivo llamado exactamente como la extensión
      'a\nb.js', 'README.md\n', //       salto de línea: `$` matchea antes de un \n final
      '', 'x', '/', '//', './x.js', 'webapp', 'webapp.js', 'webappx/y.js',
      'docs', 'docs.md', 'a/.md', '.md.md', 'MD', 'x.MD',
    ];

    const divergen = raros
      .map((f) => ({ f: JSON.stringify(f), declarado: evaluarDeclarado(reglas, f), harness: disparaBuildRailway(f) }))
      .filter((r) => r.declarado !== r.harness);

    expect(
      divergen,
      'las dos implementaciones difieren sobre entradas raras. No importa si son verosímiles: ' +
        'el resto de este archivo se apoya en que sean equivalentes.',
    ).toEqual([]);
  });

  it('también coinciden en los casos que el árbol de hoy no tiene', () => {
    const reglas = compilar(patronesDeclarados);
    const divergen = SINTETICOS
      .map((f) => ({ f, declarado: evaluarDeclarado(reglas, f), harness: disparaBuildRailway(f) }))
      .filter((r) => r.declarado !== r.harness);

    expect(divergen, 'divergencia en los casos sintéticos').toEqual([]);
  });

  /**
   * No es redundante con los de arriba: fija la INTENCIÓN. Si alguien invierte la lista a
   * blanca (`["handlers/**", "lib/**", ...]`), los tests de paridad pueden quedar verdes
   * —las dos implementaciones seguirían de acuerdo entre sí— mientras una carpeta nueva
   * deja de desplegarse en silencio, que es el fallo que la lista negra existe para evitar.
   */
  it('la lista es NEGRA: una carpeta de backend nueva se despliega sin tocar config', () => {
    const reglas = compilar(patronesDeclarados);
    for (const nueva of ['servicio-nuevo/index.js', 'workers/cola.js', 'integraciones/banco/x.js']) {
      expect(evaluarDeclarado(reglas, nueva), `railway.json dejó de observar ${nueva}`).toBe(true);
      expect(disparaBuildRailway(nueva), `el harness dejó de observar ${nueva}`).toBe(true);
    }
  });
});

/**
 * Con una sola implementación, la pregunta "¿las dos copias coinciden?" se acabó y la que
 * queda es "¿esta implementación se niega a adivinar donde no medimos?". Estos tests fijan
 * los tres lugares donde tiene que tirar en vez de contestar.
 */
describe('el compilador se niega a adivinar', () => {
  it('una forma de glob nueva rompe el build en vez de evaluarse con un default', () => {
    expect(() => compilarPatrones(['**', '!webapp/*.{ts,tsx}'])).toThrow(/forma de patrón no soportada/);
    expect(() => compilar(['**', '!webapp/*.{ts,tsx}'])).toThrow(/forma de patrón no soportada/);
  });

  /**
   * La mutación (c). Con `['**', ..., '!infra/**', 'infra/**']` la precedencia pasa a ser
   * observable —"gana el último que matchea" dice que `infra/` SE observa, "algún include y
   * ningún exclude" dice que no— y no hay una sola observación de Railway que las separe.
   * El test viejo comparaba el conjunto de negados y tiraba el orden, así que la mutación
   * pasaba en verde con el harness sub-reportando.
   */
  it('una lista que se re-incluye después de excluir NO compila: la precedencia no está medida', () => {
    expect(() => compilarPatrones(['**', '!webapp/**', '!infra/**', 'infra/**'])).toThrow(/PRECEDENCIA/);
    expect(() => verificarForma(['**', '!docs/**', 'docs/importante/**'])).toThrow(/PRECEDENCIA/);
  });

  it('una lista blanca no compila, y una vacía tampoco', () => {
    expect(() => compilarPatrones(['handlers/**', 'lib/**'])).toThrow(/negra a propósito/);
    expect(() => compilarPatrones([])).toThrow(/OBSERVAR TODO/);
  });
});

describe('el predicado no tiene conocimiento propio de rutas', () => {
  /**
   * La mutación (a): `if (f.startsWith('infra/')) return false;` escrito junto al
   * predicado, que es la forma que el código tenía ANTES de derivarlo — o sea lo que
   * escribiría cualquiera que no conozca la forma nueva. Ningún test de comportamiento la
   * atrapa: `infra/` no está declarado en ningún lado, así que no hay corpus ni probe
   * derivado que la ejercite, y las cinco pruebas pasaban en verde.
   *
   * Lo que sí se puede fijar es la PROPIEDAD: todo lo que el predicado sabe entró por los
   * patrones. Una función que no menciona ninguna cadena ni ninguna barra no puede conocer
   * una ruta. Corre sobre lo que se EXPORTA, así que también atrapa envolverlo desde afuera.
   *
   * Si necesitás explicar algo del cuerpo, el comentario va encima de la función.
   *
   * **Cubre la CADENA, no una función, y hubo que ampliarla DOS veces.** La primera versión
   * miraba solo el predicado exportado; una revisión adversarial la evadió bajando la misma
   * mutación a `evaluarReglas` (10/10 en verde). La segunda vuelta la evadió otra vez, en el
   * closure `disparaBuild` que devuelve `crearPredicado()` —el eslabón del medio, y el lugar
   * más natural donde alguien la escribiría— con 886/886 en verde.
   *
   * La lección se repite: cada vez que se parte una función en dos, el guard que la miraba
   * cubre la mitad. Si agregás un eslabón a la cadena, va en esta lista.
   *
   * Lo que este test NO cubre: los closures que devuelve `compilarPatrones()`, porque uno de
   * ellos (`extRaiz`) lleva legítimamente una barra y una comilla. Esos los cubre el test de
   * abajo, que barre los directorios REALES del repo — con el límite, que conviene tener
   * presente, de que solo ve directorios que YA existen: el hueco original era sobre `infra/`,
   * que no existía.
   */
  it('ningún eslabón de la cadena del predicado menciona una ruta', () => {
    const eslabones = [
      ['disparaBuildRailway', disparaBuildRailway], //   el export de backend-deploy-fresh
      ['crearPredicado(...)', crearPredicado(['**'])], // el closure que devuelve la fábrica
      ['evaluarReglas', evaluarReglas], //               el evaluador de reglas
    ];
    for (const [nombre, fn] of eslabones) {
      const fuente = fn.toString();

      expect(
        fuente,
        `${nombre} tiene una cadena literal adentro. Si es una ruta, se acaba de reintroducir ` +
          'la segunda fuente de verdad que se sacó el 07-ago: railway.json diría una cosa y el ' +
          'harness otra, en verde. La exclusión va en railway.json.',
      ).not.toMatch(/['"`]/);

      expect(
        fuente,
        `${nombre} tiene una barra adentro (una ruta a mano, o un literal de expresión regular). ` +
          'Mismo problema.',
      ).not.toMatch(/\//);
    }
  });

  /**
   * El complemento, y el que cubre los closures de `compilarPatrones()`: con una lista que no
   * excluye nada real, **ningún directorio de primer nivel del repo** puede quedar excluido.
   *
   * El vocabulario sale de `git ls-files`, no de una lista escrita a mano, por la misma razón
   * que el corpus: una exclusión a mano se escribe sobre un directorio que EXISTE —es el
   * motivo por el que a alguien se le ocurre excluirlo— y así queda cubierta venga de donde
   * venga en la cadena.
   */
  it('ningún directorio real del repo está excluido a mano en la cadena', () => {
    const dirs = [...new Set(archivosVersionados().filter((f) => f.includes('/')).map((f) => f.split('/')[0]))];
    expect(dirs.length, 'no se derivó ningún directorio: el corpus quedó vacío').toBeGreaterThan(5);

    const dispara = crearPredicado(['**', '!no-existe-este-directorio/**']);
    const excluidos = dirs.filter((d) => !dispara(`${d}/PROBE.js`));

    expect(
      excluidos,
      'estos directorios del repo quedan excluidos por una lista que no los menciona, así que ' +
        'la exclusión está escrita a mano en algún punto de la cadena (crearPredicado, ' +
        'evaluarReglas, o los closures de compilarPatrones). Va en railway.json.',
    ).toEqual([]);
  });

  /**
   * La otra mitad de la misma propiedad: el compilador tampoco puede tener rutas propias.
   * Con una lista sintética que no menciona ninguno de los directorios reales, todo lo que
   * no esté excluido POR ESA LISTA tiene que disparar build.
   */
  it('un predicado hecho con patrones sintéticos no arrastra los directorios reales', () => {
    const dispara = crearPredicado(['**', '!excluido-a/**', '!/*.txt']);

    for (const f of ['webapp/x.tsx', 'qa-e2e/x.mjs', 'docs/x.md', 'infra/x.js', 'README.md']) {
      expect(dispara(f), `${f} no está excluido por la lista sintética y debería disparar`).toBe(true);
    }
    for (const f of ['excluido-a/x.js', 'excluido-a/sub/y.js', 'LEEME.txt']) {
      expect(dispara(f), `${f} SÍ está excluido por la lista sintética`).toBe(false);
    }
    expect(dispara('sub/LEEME.txt'), 'el ancla de raíz de `/*.txt`').toBe(true);
  });

  /**
   * La semántica de `dir/**`, con VEREDICTOS y no solo paridad entre las dos copias.
   *
   * Hace falta separado justamente porque la paridad no alcanzó: hasta el 09-ago-2026 las dos
   * implementaciones decían `^dir/` y estaban de acuerdo en la respuesta equivocada. Lo que
   * fija cada fila de acá es una MEDICIÓN contra Railway o una elección declarada, no una
   * lectura de la sintaxis:
   *
   *   - anidado cae      → `6de1392` tocó `.claude/docs/railway-glob-probe.md` → "No changes",
   *                        contra `00dd65d` (`.claude/commands/deploy.md`) que SÍ construyó.
   *                        Las dos rutas difieren en un solo segmento.
   *   - parcial NO cae   → no está medido. Se elige el lado seguro: sobre-reportar produce una
   *                        falsa alarma de STALE, sub-reportar da PASS sobre un backend viejo.
   */
  it('`dir/**` excluye el directorio a cualquier profundidad, pero por SEGMENTO', () => {
    const dispara = crearPredicado(['**', '!excluido-a/**']);

    for (const f of ['excluido-a/x.js', 'otro/excluido-a/x.js', 'a/b/excluido-a/sub/x.js']) {
      expect(dispara(f), `${f}: \`dir/**\` no está anclado a la raíz (medido con 6de1392)`).toBe(false);
    }
    for (const f of ['otroexcluido-a/x.js', 'a/otroexcluido-a/x.js', 'excluido-a-otro/x.js']) {
      expect(
        dispara(f),
        `${f}: contiene la cadena pero su SEGMENTO es otro. Sin medir; modelamos observado ` +
          `porque el error cae del lado de una falsa alarma, no de un PASS sobre backend stale`,
      ).toBe(true);
    }
  });
});
