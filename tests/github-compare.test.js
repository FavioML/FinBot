import { describe, it, expect } from 'vitest';

import {
  TOPE_FILES, nombresDeRawDiff, rutasDeBloque, compararRango,
  desescaparRuta, aplanarArchivos,
} from '../qa-e2e/lib/github-compare.mjs';
import { decidirFrescura } from '../qa-e2e/backend-deploy-fresh.mjs';

/**
 * El defecto que estos tests vigilan, medido el 08-ago-2026 contra la API en vivo:
 * `repos/{repo}/compare/{base}...{head}` **trunca `files` en 300** sin bandera y sin campo de
 * total. Sobre `HEAD~400...main` de este repo devolvía 300 de 667 archivos reales, o sea 193 de
 * los 302 que Railway observa: **109 archivos observados invisibles**.
 *
 * Lo que hay que impedir NO es el truncado (es de GitHub, no se puede apagar) sino que una lista
 * cortada produzca una afirmación de calma. Hay dos afirmaciones así, y las dos tienen su test:
 *
 *   - `backend-deploy-fresh`: "ninguno toca archivos que Railway observe" -> PASS
 *   - `severidad()`: "el runtime que corre es el mismo que sí se testeó"
 *
 * Y una nota de honestidad, porque la nota que originó este trabajo lo tenía mal: el truncado NO
 * produce hoy un PASS falso en `fresh`. Para eso harían falta ≥300 archivos EXCLUIDOS ordenando
 * antes del primer observado, y eso no es alcanzable por aritmética: `webapp/**` (323 archivos)
 * ordena ÚLTIMO, y los excluidos que podrían precederlo son dos órdenes de magnitud menos que
 * 300 (el comando para recontarlos está en el módulo). Rompe la LISTA,
 * no la conclusión. Se arregla porque esa cota depende de la forma del árbol y nada la vigila, y
 * porque en `severidad()` el truncado solo puede empujar hacia la rama tranquilizadora.
 */

// ---------------------------------------------------------------------------------------------
// El parser del diff crudo
// ---------------------------------------------------------------------------------------------

/**
 * Un diff con los seis casos que rompen un parser ingenuo. Los tres primeros salieron de medir
 * contra el repo real; los tres últimos son el fixture malicioso.
 *
 * 1. **rename con cambios** — el primer intento leía solo el lado `a/` y perdía el destino. Sobre
 *    667 archivos reales fue la ÚNICA diferencia contra `git`: `services/subscriptions.js` en vez
 *    de `services/subscriptions/catalog.js`.
 * 1b. **rename PURO (similarity index 100%)** — y este es el que hace que `rename from`/`to` sean
 *    imprescindibles. Medido: un rename sin cambios de contenido trae SOLO esas dos líneas, sin
 *    `---`/`+++` (que en el caso 1 tapaban el agujero), y su cabecera tiene rutas de largo
 *    distinto, así que el fallback por longitud no la puede desambiguar. Lo encontró la prueba
 *    por mutación: quitar `rename to` dejaba los 21 tests en verde sin este bloque.
 * 2. **binario** — no tiene `---`/`+++`, así que un parser que dependa de esas líneas lo pierde
 *    entero. El repo tiene `.png` versionados.
 * 3. **solo-modo** — tampoco tiene `---`/`+++`.
 * 4. **ruta con espacio** — medido: git **no** cita la ruta en `diff --git` (sale
 *    `diff --git a/con espacio.txt b/con espacio.txt`), así que la cabecera es ambigua en
 *    general y hay que resolverla por longitud.
 * 5. **línea de contenido que imita una cabecera** — una línea BORRADA cuyo contenido sea
 *    `-- a/trampa.txt` se imprime como `--- a/trampa.txt`, indistinguible de la cabecera real.
 *    Por eso solo se mira hasta el primer `@@`.
 * 6. **alta y baja** — `/dev/null` en uno de los dos lados no es una ruta.
 */
const DIFF_DURO = [
  'diff --git a/services/subscriptions.js b/services/subscriptions/catalog.js',
  'similarity index 92%',
  'rename from services/subscriptions.js',
  'rename to services/subscriptions/catalog.js',
  'index 1111111..2222222 100644',
  '--- a/services/subscriptions.js',
  '+++ b/services/subscriptions/catalog.js',
  '@@ -1,2 +1,2 @@',
  '-viejo',
  '+nuevo',
  'diff --git a/lib/viejo.js b/lib/nombre-mucho-mas-largo.js',
  'similarity index 100%',
  'rename from lib/viejo.js',
  'rename to lib/nombre-mucho-mas-largo.js',
  'diff --git a/qa-e2e/muro-pro.png b/qa-e2e/muro-pro.png',
  'index 3333333..4444444 100644',
  'Binary files a/qa-e2e/muro-pro.png and b/qa-e2e/muro-pro.png differ',
  'diff --git a/scripts/backup/backup.sh b/scripts/backup/backup.sh',
  'old mode 100644',
  'new mode 100755',
  'diff --git a/con espacio.txt b/con espacio.txt',
  'index 5555555..6666666 100644',
  '--- a/con espacio.txt\t',
  '+++ b/con espacio.txt\t',
  '@@ -1 +1 @@',
  '-x',
  '+y',
  'diff --git a/lib/trampa.js b/lib/trampa.js',
  'index 7777777..8888888 100644',
  '--- a/lib/trampa.js',
  '+++ b/lib/trampa.js',
  '@@ -1,3 +1,2 @@',
  '--- a/trampa.txt',
  '+++ b/otra-trampa.txt',
  ' contexto',
  'diff --git a/migrations/060_nueva.sql b/migrations/060_nueva.sql',
  'new file mode 100644',
  'index 0000000..9999999',
  '--- /dev/null',
  '+++ b/migrations/060_nueva.sql',
  '@@ -0,0 +1 @@',
  '+select 1;',
  'diff --git a/docs/viejo.md b/docs/viejo.md',
  'deleted file mode 100644',
  'index aaaaaaa..0000000',
  '--- a/docs/viejo.md',
  '+++ /dev/null',
  '@@ -1 +0,0 @@',
  '-adios',
].join('\n');

describe('nombresDeRawDiff: los casos que rompen un parser ingenuo', () => {
  const r = nombresDeRawDiff(DIFF_DURO);

  it('encuentra las 8 entradas y las lee todas sin ambigüedad', () => {
    expect(r.entradas).toBe(8);
    expect(r.sinParsear).toEqual([]);
  });

  it('trae LAS DOS puntas de un rename', () => {
    expect(r.archivos).toContain('services/subscriptions.js');
    expect(r.archivos).toContain('services/subscriptions/catalog.js');
  });

  /**
   * El rename puro no tiene `---`/`+++` y su cabecera es ambigua por largos distintos: si
   * `rename from`/`rename to` no se leen, este bloque desaparece ENTERO de la lista. Y un
   * rename puede mover un archivo de una ruta excluida a una observada, así que perderlo es
   * perder justo el cambio que decide el veredicto.
   */
  it('lee el rename PURO, que solo tiene rename from/to', () => {
    expect(r.archivos).toContain('lib/viejo.js');
    expect(r.archivos).toContain('lib/nombre-mucho-mas-largo.js');
  });

  it('no pierde el binario ni el cambio de solo-modo, que no tienen ---/+++', () => {
    expect(r.archivos).toContain('qa-e2e/muro-pro.png');
    expect(r.archivos).toContain('scripts/backup/backup.sh');
  });

  it('resuelve la ruta con espacio, que git no cita', () => {
    expect(r.archivos).toContain('con espacio.txt');
  });

  it('NO inventa archivos a partir del contenido del diff', () => {
    // El fixture malicioso: `--- a/trampa.txt` es una línea BORRADA, no una cabecera.
    expect(r.archivos).not.toContain('trampa.txt');
    expect(r.archivos).not.toContain('otra-trampa.txt');
    expect(r.archivos).toContain('lib/trampa.js');
  });

  it('no toma /dev/null como una ruta', () => {
    expect(r.archivos.some((f) => f.includes('dev/null'))).toBe(false);
    expect(r.archivos).toContain('migrations/060_nueva.sql');
    expect(r.archivos).toContain('docs/viejo.md');
  });

  it('la lista es exactamente la esperada, sin sobrantes', () => {
    expect(r.archivos).toEqual([
      'con espacio.txt',
      'docs/viejo.md',
      'lib/nombre-mucho-mas-largo.js',
      'lib/trampa.js',
      'lib/viejo.js',
      'migrations/060_nueva.sql',
      'qa-e2e/muro-pro.png',
      'scripts/backup/backup.sh',
      'services/subscriptions.js',
      'services/subscriptions/catalog.js',
    ]);
  });

  it('tolera CRLF', () => {
    const conCrlf = nombresDeRawDiff(DIFF_DURO.split('\n').join('\r\n'));
    expect(conCrlf.sinParsear).toEqual([]);
    expect(conCrlf.archivos).toContain('services/subscriptions/catalog.js');
    expect(conCrlf.archivos).toContain('con espacio.txt');
  });
});

/**
 * **Cada fuente de ruta, ejercitada AISLADA.** Sobre un diff realista las fuentes se solapan: un
 * rename con cambios trae `rename from/to` **y** `---`/`+++`, y una modificación trae `---`/`+++`
 * **y** una cabecera resoluble por longitud. Así que quitar una fuente deja los tests en verde por
 * redundancia, no porque el comportamiento siga bien. Ya pasó dos veces acá: la prueba por
 * mutación mostró que `rename to` no estaba ejercitado por nada (y ESE no era redundante: un
 * rename puro no tiene `---`/`+++`), y después que las variantes citadas de `---`/`+++` tampoco lo
 * estaban (esas sí son redundantes con el fallback de cabecera — medido: quitarlas deja un diff
 * real con rutas CJK en 27/27).
 *
 * El truco para aislar: una cabecera con los dos lados DISTINTOS, que el fallback por longitud no
 * puede resolver. Así la única fuente posible es la línea que se está probando. Es un test del
 * CONTRATO de `rutasDeBloque`, no de un diff verosímil, y por eso puede fijar cada rama.
 */
describe('rutasDeBloque: cada fuente de ruta, aislada de las demás', () => {
  // Lados distintos y de largo distinto: el fallback por longitud devuelve null.
  const HEADER_IRRESOLUBLE = 'diff --git a/lado-izquierdo.js b/otro-lado-mas-largo.js';

  it('sin ninguna fuente, el bloque es ilegible (o sea: el aislamiento funciona)', () => {
    expect(rutasDeBloque([HEADER_IRRESOLUBLE])).toBeNull();
  });

  const casos = [
    ['rename from', 'rename from services/viejo.js', 'services/viejo.js'],
    ['rename to', 'rename to services/nuevo.js', 'services/nuevo.js'],
    ['--- a/', '--- a/lib/borrado.js', 'lib/borrado.js'],
    ['+++ b/', '+++ b/lib/agregado.js', 'lib/agregado.js'],
    ['--- "a/ (citada)', '--- "a/docs/gu\\303\\255a.md"', 'docs/guía.md'],
    ['+++ "b/ (citada)', '+++ "b/docs/gu\\303\\255a.md"', 'docs/guía.md'],
  ];

  for (const [nombre, linea, esperada] of casos) {
    it(`lee \`${nombre}\` cuando es la ÚNICA fuente del bloque`, () => {
      expect(rutasDeBloque([HEADER_IRRESOLUBLE, linea])).toEqual([esperada]);
    });
  }
});

describe('rutasDeBloque: lo que no se puede leer se DECLARA, no se saltea', () => {
  it('devuelve null ante una cabecera ambigua que no cierra por longitud', () => {
    // Un rename de rutas de largo distinto SIN las líneas `rename from/to`: la cabecera
    // `a/X b/Y` con |X| != |Y| no se puede desambiguar, y no hay otra fuente.
    expect(rutasDeBloque(['diff --git a/corto.js b/mucho-mas-largo.js'])).toBeNull();
  });

  it('un bloque ilegible sube a sinParsear en vez de desaparecer', () => {
    const r = nombresDeRawDiff('diff --git a/corto.js b/mucho-mas-largo.js\nindex 1..2 100644');
    expect(r.entradas).toBe(1);
    expect(r.sinParsear).toHaveLength(1);
    expect(r.archivos).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// Rutas citadas (core.quotePath)
// ---------------------------------------------------------------------------------------------

/**
 * Git aplica `core.quotePath` y **la API de GitHub también**: una ruta con bytes no-ASCII sale
 * entre comillas con escapes octales. Y lo que lo vuelve peligroso, medido con git de verdad:
 * en un rename MIXTO git cita **solo el lado que lo necesita**.
 *
 *     diff --git a/plain.txt "b/renombrado-\303\251.txt"
 *     rename from plain.txt
 *     rename to "renombrado-\303\251.txt"
 *
 * Con eso `rename from` matchea, `rutas` queda no-vacío, no hay `null`, `sinParsear` sale 0, y la
 * lista se declaraba COMPLETA con la cadena cruda en lugar de la ruta. Archivo perdido en
 * silencio con la lista marcada completa: la propiedad que el módulo afirma sostener, violada.
 */
describe('desescaparRuta: las rutas citadas de git', () => {
  it('deja intacta una ruta sin comillas', () => {
    expect(desescaparRuta('services/transactions.js')).toBe('services/transactions.js');
  });

  it('decodifica los octales como BYTES y después como UTF-8', () => {
    // `\303\261` son los DOS bytes de una `ñ`. Decodificarlos de a uno da mojibake.
    expect(desescaparRuta('"acentuado-\\303\\261.txt"')).toBe('acentuado-ñ.txt');
    expect(desescaparRuta('"services/notificaci\\303\\263n.js"')).toBe('services/notificación.js');
  });

  /**
   * **Las NUEVE entradas de `SIMPLES`, una por una.** Antes solo estaban fijadas `t`, `\\` y `"`,
   * y las otras seis eran libres: la prueba por mutación mostró que borrar `n: 10` o dejar la tabla
   * en tres entradas pasaba en verde. Y un valor equivocado ahí **no da `null`, da una ruta
   * silenciosamente mal decodificada dentro de una lista `completa: true`**, que es el peor modo
   * de falla del módulo.
   *
   * Que git escapa `\n` en una ruta está medido, no es teórico: un archivo con un newline en el
   * nombre sale `diff --git "a/con\nnewline.txt" "b/con\nnewline.txt"`.
   */
  it('decodifica las nueve escapes simples con su byte exacto', () => {
    // `letra` es el carácter que sigue a la barra en el diff; `esperado` el byte que representa.
    const casos = [
      ['a', '\x07'], ['b', '\b'], ['f', '\f'], ['n', '\n'], ['r', '\r'],
      ['t', '\t'], ['v', '\v'], ['\\', '\\'], ['"', '"'],
    ];
    for (const [letra, esperado] of casos) {
      const entrada = `"x\\${letra}y.txt"`; // p. ej.  "x\ny.txt"
      expect(desescaparRuta(entrada), `escape \\${letra}`).toBe(`x${esperado}y.txt`);
    }
  });

  /** Ante un escape que no conocemos o una secuencia UTF-8 inválida, `null`. Acá no se adivina. */
  it('devuelve null en vez de adivinar', () => {
    expect(desescaparRuta('"escape\\zdesconocido"')).toBeNull();
    expect(desescaparRuta('"octal\\30incompleto"')).toBeNull();
    expect(desescaparRuta('"barra colgando\\"')).toBeNull();
    expect(desescaparRuta('"utf8 invalido \\377\\377"')).toBeNull();
    expect(desescaparRuta(undefined)).toBeNull();
  });
});

describe('rutas no-ASCII en el diff: no se pierden ni se declaran completas mal', () => {
  const bloque = (ls) => nombresDeRawDiff(ls.join('\n'));

  /**
   * **La ruta citada CON ESPACIO, que es el caso normal en un repo en español.** Git agrega un TAB
   * al final de `---`/`+++` cuando la ruta tiene un espacio, **cite o no cite** — medido contra la
   * API en vivo sobre una ruta real `Algún día.md`:
   *
   *     +++ "b/Alg\303\272n d\303\255a.md"<TAB>
   *
   * Sin este fixture, `limpiar` y las ramas citadas nunca se ejercitaban juntas: los otros fixtures
   * citados no tienen espacio, así que no llevan TAB. Una revisión adversarial mutó `limpiar` a la
   * identidad en las ramas citadas y los 124 tests siguieron verdes, mientras sobre un diff real de
   * GitHub el módulo devolvía la cadena cruda con comillas, octales y el TAB como si fuera una ruta.
   */
  it('lee una ruta citada CON espacio, que llega con un TAB después de la comilla', () => {
    const r = bloque([
      'diff --git "a/docs/Alg\\303\\272n d\\303\\255a.md" "b/docs/Alg\\303\\272n d\\303\\255a.md"',
      'index 1111111..2222222 100644',
      '--- "a/docs/Alg\\303\\272n d\\303\\255a.md"\t',
      '+++ "b/docs/Alg\\303\\272n d\\303\\255a.md"\t',
      '@@ -1 +1 @@',
      '-x',
      '+y',
    ]);
    expect(r.sinParsear).toEqual([]);
    expect(r.archivos).toEqual(['docs/Algún día.md']);
  });

  it('una modificación de ruta citada se lee bien (antes caía en sinParsear)', () => {
    const r = bloque([
      'diff --git "a/docs/gu\\303\\255a.md" "b/docs/gu\\303\\255a.md"',
      'index 1111111..2222222 100644',
      '--- "a/docs/gu\\303\\255a.md"',
      '+++ "b/docs/gu\\303\\255a.md"',
      '@@ -1 +1 @@',
      '-x',
      '+y',
    ]);
    expect(r.sinParsear).toEqual([]);
    expect(r.archivos).toEqual(['docs/guía.md']);
  });

  /** El caso grave: la lista se declaraba completa con basura adentro. */
  it('el rename MIXTO ascii -> no-ascii devuelve la ruta REAL, no la cadena cruda', () => {
    const r = bloque([
      'diff --git a/plain.txt "b/renombrado-\\303\\251.txt"',
      'similarity index 100%',
      'rename from plain.txt',
      'rename to "renombrado-\\303\\251.txt"',
    ]);
    expect(r.sinParsear).toEqual([]);
    expect(r.archivos).toEqual(['plain.txt', 'renombrado-é.txt']);
    // Y sobre todo: ninguna cadena cruda con comillas u octales se cuela como "ruta".
    expect(r.archivos.some((f) => f.includes('\\303') || f.startsWith('"'))).toBe(false);
  });

  it('un binario con nombre citado se resuelve por la cabecera', () => {
    const r = bloque([
      'diff --git "a/qa-e2e/capturañ.png" "b/qa-e2e/capturañ.png"'.replace(/ñ/g, '\\303\\261'),
      'index 3333333..4444444 100644',
      'Binary files differ',
    ]);
    expect(r.sinParsear).toEqual([]);
    expect(r.archivos).toEqual(['qa-e2e/capturañ.png']);
  });

  /** Una ruta que no se puede desescapar invalida el bloque ENTERO, no solo esa ruta. */
  it('si una sola ruta del bloque es ilegible, el bloque va a sinParsear', () => {
    const r = bloque([
      'diff --git a/plain.txt "b/roto\\zz.txt"',
      'rename from plain.txt',
      'rename to "roto\\zz.txt"',
    ]);
    expect(r.sinParsear).toHaveLength(1);
    expect(r.archivos).toEqual([]);
  });

  it('una cabecera citada con los dos lados DISTINTOS y sin líneas rename no se adivina', () => {
    const r = bloque(['diff --git "a/uno\\303\\261.txt" "b/otro\\303\\261.txt"', 'index 1..2 100644']);
    expect(r.sinParsear).toHaveLength(1);
  });

  /**
   * **El tripwire, aplicado a TODOS los fixtures citados y no a uno.** Antes vivía dentro de un
   * solo `it`, así que solo vigilaba ese fixture: agregar un caso citado nuevo no lo hacía pasar
   * por el control. Ninguna salida del parser puede tener forma de cadena cruda de git, nunca.
   */
  it('NINGUNA ruta devuelta tiene forma de cadena cruda de git', () => {
    const fixtures = [
      // citada simple, citada con espacio+TAB, rename mixto, binario citado, y el diff duro entero
      ['diff --git "a/docs/gu\\303\\255a.md" "b/docs/gu\\303\\255a.md"', '--- "a/docs/gu\\303\\255a.md"', '+++ "b/docs/gu\\303\\255a.md"'],
      ['diff --git "a/d/Alg\\303\\272n d\\303\\255a.md" "b/d/Alg\\303\\272n d\\303\\255a.md"', '--- "a/d/Alg\\303\\272n d\\303\\255a.md"\t', '+++ "b/d/Alg\\303\\272n d\\303\\255a.md"\t'],
      ['diff --git a/plain.txt "b/renombrado-\\303\\251.txt"', 'rename from plain.txt', 'rename to "renombrado-\\303\\251.txt"'],
      ['diff --git "a/q/cap\\303\\261.png" "b/q/cap\\303\\261.png"', 'Binary files differ'],
      DIFF_DURO.split('\n'),
    ];
    for (const f of fixtures) {
      const { archivos } = nombresDeRawDiff((Array.isArray(f) ? f : [f]).join('\n'));
      for (const ruta of archivos) {
        expect(ruta.startsWith('"'), `ruta cruda: ${JSON.stringify(ruta)}`).toBe(false);
        expect(ruta.includes('\\'), `escape sin decodificar: ${JSON.stringify(ruta)}`).toBe(false);
        expect(ruta.endsWith('\t'), `TAB colgando: ${JSON.stringify(ruta)}`).toBe(false);
        expect(ruta.length, 'ruta vacía').toBeGreaterThan(0);
      }
    }
  });

  /**
   * `desescaparRuta` recibe la cadena SIN la comilla de apertura reconstruida en algunos caminos, y
   * `s.length >= 2` es lo que evita tratar una comilla suelta (`"`) como una cadena citada vacía.
   */
  it('una comilla suelta no es una cadena citada', () => {
    expect(desescaparRuta('"')).toBe('"');
  });

  /**
   * El fallback por longitud con `largo === 0` produciría `['']`, o sea una "ruta" vacía metida en
   * una lista declarada completa. `largo > 0` lo corta.
   */
  it('el fallback por longitud no devuelve la ruta vacía', () => {
    // `diff --git a/ b/` -> resto = 'a/ b/', largo = (5-5)/2 = 0
    expect(rutasDeBloque(['diff --git a/ b/'])).toBeNull();
  });

  it('una ruta que se desescapa a cadena vacía invalida el bloque', () => {
    expect(rutasDeBloque(['diff --git a/x.js b/y.js', '--- a/'])).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// aplanarArchivos: las dos puntas de un rename, en el camino de TODOS los días
// ---------------------------------------------------------------------------------------------

/**
 * Esta regla vivía dentro de la cadena del `jq` (`.filename, .previous_filename`), o sea en un
 * lugar que ningún test puede ejercitar: la revisión adversarial le quitó `previous_filename` y
 * los 958 tests siguieron en verde. Y es el camino JSON, el de todos los días (n < 300), mientras
 * los dientes que existían para renames cubrían solo el camino del diff crudo (n >= 300).
 */
describe('aplanarArchivos: un rename trae sus DOS puntas', () => {
  it('conserva filename y previous_filename', () => {
    expect(aplanarArchivos([
      { filename: 'services/subscriptions/catalog.js', previous_filename: 'services/subscriptions.js' },
      { filename: 'index.js' },
    ])).toEqual(['services/subscriptions/catalog.js', 'services/subscriptions.js', 'index.js']);
  });

  it('deduplica y tolera entradas vacías', () => {
    expect(aplanarArchivos([{ filename: 'a.js' }, { filename: 'a.js' }, null, {}])).toEqual(['a.js']);
    expect(aplanarArchivos(null)).toEqual([]);
  });

  /**
   * El caso que lo vuelve un problema de correctitud y no de prolijidad: un rename que SACA un
   * archivo de una ruta observada por Railway hacia una excluida. Con solo `filename`, el destino
   * (`webapp/`) está excluido y el origen (`services/`) no se ve, así que el rango se lee como
   * "nada observado cambió": PASS falso sobre un backend al que le sacaron un archivo.
   */
  it('un rename de ruta observada a excluida sigue siendo visible', () => {
    const soloBackend = (f) => !f.startsWith('webapp/');
    const planas = aplanarArchivos([
      { filename: 'webapp/src/lib/movido.ts', previous_filename: 'services/movido.js' },
    ]);
    expect(planas.filter(soloBackend)).toEqual(['services/movido.js']);
  });
});

// ---------------------------------------------------------------------------------------------
// compararRango: cuándo se baja al diff crudo
// ---------------------------------------------------------------------------------------------

/** La forma REAL que devuelve el `jq` de `compararRango`: objetos, no cadenas. */
const jsonCompare = (n, extra = {}) => JSON.stringify({
  status: 'ahead',
  ahead_by: 3,
  files: Array.from({ length: n }, (_, i) => ({ filename: `webapp/src/a${String(i).padStart(4, '0')}.ts` })),
  nFiles: n,
  newest: '2026-08-08T00:00:00Z',
  ...extra,
});

/** Un doble de `gh` que registra las llamadas y responde según el media type pedido. */
function ghFalso({ n, raw, tiraEnDiff = false }) {
  const llamadas = [];
  const fn = (ruta, jq, extra = []) => {
    llamadas.push({ ruta, jq, extra });
    const esDiff = extra.some((a) => String(a).includes('vnd.github.diff'));
    if (!esDiff) return jsonCompare(n);
    if (tiraEnDiff) {
      const e = new Error('Command failed: gh api ...');
      e.stderr = 'gh: Service Unavailable (HTTP 503)';
      throw e;
    }
    return raw;
  };
  return { fn, llamadas };
}

describe('compararRango: el tope de 300 y la bajada al diff crudo', () => {
  it('por debajo del tope NO pide el diff crudo: una llamada y listo', () => {
    const { fn, llamadas } = ghFalso({ n: 299 });
    const r = compararRango({ repo: 'x/y', base: 'aaa', head: 'main', ghFn: fn });
    expect(r.completa).toBe(true);
    expect(r.fuente).toBe('json');
    expect(r.files).toHaveLength(299);
    expect(llamadas).toHaveLength(1);
  });

  /**
   * **El umbral es `>=`, y este test es el que lo fija.** Un rango con exactamente 300 archivos
   * reales es INDISTINGUIBLE de uno truncado en 300: no hay campo de total con el que desempatar.
   * Medido: `HEAD~180...main` de este repo devuelve exactamente 300. Mutar `>=` a `>` deja ese
   * caso leyéndose como completo, y es justo el borde donde empieza el problema.
   */
  it('EN el tope (300 exactos) baja al diff crudo, porque 300 real y 300 topado no se distinguen', () => {
    // Un truncado REALISTA, que es la forma que tiene en este repo: la lista topada trae 300
    // archivos de `webapp/` (excluido, ordena último) y los observados de backend caen DESPUÉS
    // del corte alfabético. Solo el diff crudo los ve.
    const delDiff = [
      ...Array.from({ length: 300 }, (_, i) => `webapp/src/a${String(i).padStart(4, '0')}.ts`),
      'services/dos.js',
      'tests/tres.js',
    ];
    // El `\n` final no es cosmético: una respuesta real de `gh` termina en newline, y la falta de
    // ese newline es la única señal de un cuerpo cortado a mitad de hunk (ver su test).
    const raw = `${delDiff
      .map((f) => `diff --git a/${f} b/${f}\nindex 1..2 100644\n--- a/${f}\n+++ b/${f}\n@@ -1 +1 @@\n-x\n+y`)
      .join('\n')}\n`;
    const { fn, llamadas } = ghFalso({ n: TOPE_FILES, raw });
    const r = compararRango({ repo: 'x/y', base: 'aaa', head: 'main', ghFn: fn });

    expect(llamadas).toHaveLength(2);
    expect(llamadas[1].extra.join(' ')).toContain('vnd.github.diff');
    expect(r.completa).toBe(true);
    expect(r.fuente).toBe('diff');
    // Lo que la lista topada NO tenía y el diff sí: los archivos observados.
    expect(r.files).toContain('services/dos.js');
    expect(r.files).toContain('tests/tres.js');
    expect(r.files).toHaveLength(302);
  });

  it('si el diff crudo falla, la respuesta queda marcada incompleta con el motivo', () => {
    const { fn } = ghFalso({ n: TOPE_FILES, tiraEnDiff: true });
    const r = compararRango({ repo: 'x/y', base: 'aaa', head: 'main', ghFn: fn });
    expect(r.completa).toBe(false);
    expect(r.fuente).toBe('json-topado');
    expect(r.motivoIncompleta).toMatch(/503/);
  });

  it('un bloque ilegible del diff marca la lista incompleta, no la da por buena', () => {
    // Un bloque legible y uno ilegible: la respuesta tiene que quedar incompleta Y conservar lo
    // que sí se leyó, FUSIONANDO la lista topada del JSON con la del diff. Sin la fusión, un
    // observado que solo aparecía en el diff crudo se pierde y un STALE correcto (exit 1) se
    // degrada a exit 2.
    const raw = 'diff --git a/services/legible.js b/services/legible.js\nindex 1..2 100644\n'
      + '--- a/services/legible.js\n+++ b/services/legible.js\n@@ -1 +1 @@\n-x\n+y\n'
      + 'diff --git a/corto.js b/mucho-mas-largo.js\n';
    const { fn } = ghFalso({ n: TOPE_FILES, raw });
    const r = compararRango({ repo: 'x/y', base: 'aaa', head: 'main', ghFn: fn });
    expect(r.completa).toBe(false);
    expect(r.motivoIncompleta).toMatch(/no se pudieron leer sin ambigüedad/);
    expect(r.files, 'lo del diff crudo no se descarta').toContain('services/legible.js');
    expect(r.files, 'ni lo que el JSON alcanzó a traer').toContain('webapp/src/a0000.ts');
  });

  /**
   * El ORDEN de los tres controles. `gh api` **sin `--jq`** no termina en newline (medido), y la
   * bajada al diff crudo es sin `--jq`: si el control del newline va primero, un media type
   * ignorado —que devuelve JSON— se diagnostica como "cuerpo cortado a mitad de hunk" en vez de
   * "no era un diff". Los dos dan `completa: false`, pero el mensaje manda a mirar el lugar
   * equivocado, que es la misma clase que `diagnosticar404` acaba de arreglar.
   */
  it('un JSON sin newline final se diagnostica como "no era un diff", no como truncado', () => {
    const { fn } = ghFalso({ n: TOPE_FILES, raw: '{"status":"ahead","files":[]}' });
    const r = compararRango({ repo: 'x/y', base: 'aaa', head: 'main', ghFn: fn });
    expect(r.completa).toBe(false);
    expect(r.motivoIncompleta).toMatch(/no era un diff/);
    expect(r.motivoIncompleta).not.toMatch(/cortado a mitad de hunk/);
  });

  /**
   * **El fail-open que la segunda vuelta de revisión encontró DENTRO de este arreglo**, y que la
   * suite entera daba por bueno.
   *
   * El `jq` de `compararRango` siempre produce `nFiles`, así que en producción no pasa — pero los
   * dobles de `severidad` en `backend-deploy-tested-errores.test.js` devuelven un payload de
   * compare SIN ese campo, y con eso el módulo devolvía `{ files: [], completa: true }`: la lista
   * VACÍA declarada COMPLETA, escondiendo el `handlers/webhook.js` que el doble sí traía.
   *
   * La cadena son dos comparaciones con `NaN`, y ante `NaN` las dos eligen la rama insegura:
   * `Number(undefined) < 300` es false (baja al diff crudo como si estuviera topado) y después
   * `0 < NaN` también es false (la guarda de coherencia no salta). Un conteo que no es un número
   * finito es "no sé si vino topada", nunca "no vino topada".
   */
  it('sin un conteo de archivos usable NO declara la lista completa', () => {
    const sinConteo = () => JSON.stringify({ status: 'ahead', files: [{ filename: 'handlers/webhook.js' }] });
    const r = compararRango({ repo: 'x/y', base: 'a', head: 'b', ghFn: sinConteo });
    expect(r.completa, 'sin nFiles no se puede afirmar que la lista esté entera').toBe(false);
    expect(r.motivoIncompleta).toMatch(/conteo de archivos usable/);
    // Y sobre todo: no se pierde lo que el JSON sí trajo.
    expect(r.files).toEqual(['handlers/webhook.js']);
  });

  /**
   * `Number(null)`, `Number([])` y `Number('')` son todos **0**, y `0 < 300` declara la lista
   * completa sea lo que sea. Es el mismo bug que el `undefined` (que daba NaN y caía por el otro
   * lado), un valor al lado, y por eso el chequeo es `typeof === 'number'` y no una coacción.
   */
  it('un conteo que COACCIONA a 0 tampoco declara la lista completa', () => {
    for (const nFiles of [null, [], '', false, '17']) {
      const fn = () => JSON.stringify({ status: 'ahead', files: [{ filename: 'index.js' }], nFiles });
      const r = compararRango({ repo: 'x/y', base: 'a', head: 'b', ghFn: fn });
      expect(r.completa, `nFiles=${JSON.stringify(nFiles)}`).toBe(false);
    }
  });

  /**
   * **`gh api` entrega el cuerpo PARCIAL con exit 0 y stderr vacío** cuando el diff es enorme: no
   * hay excepción que atrapar. El corte cae a mitad de hunk, así que el último bloque conserva
   * sus `---`/`+++` y parsea limpio, y el conteo tampoco lo ve porque en esa rama `n` vale
   * siempre 300: `archivos.length < n` solo cubre la franja 0-299, y una pérdida que deje 300+
   * bloques pasaba como completa. La única señal del transporte es que un diff completo termina
   * en newline (verificado sobre las respuestas reales de 5 y 6 MB).
   */
  it('un diff cortado a mitad de hunk se detecta por el newline final', () => {
    const completo = [...Array(305)].map((_, i) => {
      const f = `services/s${String(i).padStart(3, '0')}.js`;
      return `diff --git a/${f} b/${f}\nindex 1..2 100644\n--- a/${f}\n+++ b/${f}\n@@ -1 +1 @@\n-x\n+y`;
    }).join('\n');

    // Con newline final: completa, y los 305 se ven.
    const ok = ghFalso({ n: TOPE_FILES, raw: `${completo}\n` });
    const rOk = compararRango({ repo: 'x/y', base: 'a', head: 'main', ghFn: ok.fn });
    expect(rOk.completa).toBe(true);
    expect(rOk.files).toHaveLength(305);

    // Cortado a mitad de hunk: 305 bloques parseables igual, pero sin newline final.
    const cortado = ghFalso({ n: TOPE_FILES, raw: `${completo}\n-lineaCorta` });
    const rMal = compararRango({ repo: 'x/y', base: 'a', head: 'main', ghFn: cortado.fn });
    expect(rMal.completa, 'un cuerpo truncado no puede leerse como lista completa').toBe(false);
    expect(rMal.motivoIncompleta).toMatch(/no termina en newline/);
  });

  it('el camino JSON conserva las dos puntas de un rename', () => {
    const conRename = () => JSON.stringify({
      status: 'ahead',
      ahead_by: 1,
      files: [{ filename: 'services/subscriptions/catalog.js', previous_filename: 'services/subscriptions.js' }],
      nFiles: 1,
      newest: '2026-08-08T00:00:00Z',
    });
    const r = compararRango({ repo: 'x/y', base: 'a', head: 'b', ghFn: conRename });
    expect(r.completa).toBe(true);
    expect(r.files).toEqual(['services/subscriptions/catalog.js', 'services/subscriptions.js']);
  });

  /**
   * La costura con el consumidor. `decidirFrescura` lee `newest` para la ventana de deploy en
   * vuelo, y sacarlo de `base_` no rompía nada: los tests del productor no lo afirmaban y los del
   * consumidor construían `cmp` a mano. Sin `newest`, `ageMin` queda `null` para siempre, la
   * ventana muere, y todo deploy que esté construyendo sale STALE exit 1 en el canary diario.
   */
  it('propaga status, ahead_by y newest, que es lo que el consumidor lee', () => {
    const { fn } = ghFalso({ n: 5 });
    const r = compararRango({ repo: 'x/y', base: 'a', head: 'b', ghFn: fn });
    expect(r).toMatchObject({ status: 'ahead', ahead_by: 3, newest: '2026-08-08T00:00:00Z' });
  });

  it('un diff crudo sin ni una entrada no es un rango vacío: es una respuesta que no era un diff', () => {
    // El caso real: un doble (o un proxy) que ignora el header y devuelve JSON.
    const { fn } = ghFalso({ n: TOPE_FILES, raw: '{"status":"ahead"}\n' });
    const r = compararRango({ repo: 'x/y', base: 'aaa', head: 'main', ghFn: fn });
    expect(r.completa).toBe(false);
    expect(r.motivoIncompleta).toMatch(/no era un diff/);
    expect(r.files).toHaveLength(TOPE_FILES);
  });

  /**
   * El diff crudo es la fuente SIN tope, así que no puede traer menos archivos que la lista
   * topada. Si pasa, algo se cortó —`maxBuffer` chico, un límite del media type en un rango
   * gigante— y lo que no se puede hacer es leerlo como una lista completa y corta.
   */
  it('un diff que trae MENOS que la lista topada es incoherente y se marca incompleto', () => {
    const raw = 'diff --git a/solo-uno.js b/solo-uno.js\nindex 1..2 100644\n'
      + '--- a/solo-uno.js\n+++ b/solo-uno.js\n@@ -1 +1 @@\n-x\n+y\n';
    const { fn } = ghFalso({ n: TOPE_FILES, raw });
    const r = compararRango({ repo: 'x/y', base: 'aaa', head: 'main', ghFn: fn });
    expect(r.completa).toBe(false);
    expect(r.motivoIncompleta).toMatch(/MENOS que los 300/);
  });
});

// ---------------------------------------------------------------------------------------------
// decidirFrescura: la regla con dientes
// ---------------------------------------------------------------------------------------------

/**
 * Estos cuatro son el guard de verdad, y viven en una función PURA a propósito.
 *
 * La regla nueva —una lista incompleta no puede producir PASS— es una relación entre DOS campos
 * (`completa` y `pendingBackend.length`), no una cadena en el código. Un guard que leyera el
 * fuente buscando `'PASS'` no la vigila: ya se evadieron dos de esos cambiando comillas simples
 * por dobles. Acá se ejercita el comportamiento.
 */
describe('decidirFrescura: una lista incompleta no puede producir PASS', () => {
  const soloBackend = (f) => !f.startsWith('webapp/') && !f.startsWith('docs/') && !f.startsWith('qa-e2e/');
  const AHORA = new Date('2026-08-08T12:00:00Z').getTime();
  const VIEJO = '2026-08-08T00:00:00Z'; // 12 h atrás: fuera de la ventana de deploy en vuelo

  const decidir = (cmp) => decidirFrescura({
    deployed: 'abcdef1234567890', cmp, dispara: soloBackend, ahora: AHORA, inFlightMin: 10,
  });

  it('lista COMPLETA sin archivos observados -> PASS (exit 0)', () => {
    const r = decidir({ status: 'ahead', ahead_by: 2, files: ['docs/x.md', 'webapp/y.ts'], completa: true, fuente: 'json', newest: VIEJO });
    expect(r.code).toBe(0);
    expect(r.verdict).toBe('PASS');
  });

  it('lista INCOMPLETA sin archivos observados -> exit 2, NUNCA PASS', () => {
    const r = decidir({
      status: 'ahead', ahead_by: 2, files: ['docs/x.md', 'webapp/y.ts'],
      completa: false, fuente: 'json-topado', motivoIncompleta: 'la API topó files en 300', newest: VIEJO,
    });
    expect(r.code).toBe(2);
    expect(r.verdict).not.toBe('PASS');
    expect(r.extra.detalle).toMatch(/topó/);
  });

  /**
   * La otra mitad de la asimetría, y no es simetría por elegancia: una lista corta ESCONDE
   * archivos, no los inventa. El observado que sí apareció cambió de verdad, así que el STALE
   * se sostiene aunque falten otros. Degradarlo a exit 2 acá convertiría un backend
   * genuinamente stale en "no sé".
   */
  it('lista INCOMPLETA pero CON archivos observados -> STALE (exit 1), que sigue siendo sólido', () => {
    const r = decidir({
      status: 'ahead', ahead_by: 2, files: ['services/x.js', 'webapp/y.ts'],
      completa: false, fuente: 'diff', motivoIncompleta: 'un bloque ilegible', newest: VIEJO,
    });
    expect(r.code).toBe(1);
    expect(r.verdict).toMatch(/^STALE/);
    expect(r.extra.listaCompleta).toBe(false);
    expect(r.extra.avisoLista).toBeTruthy();
  });

  it('reporta el TOTAL de pendientes, no solo los 5 que imprime', () => {
    const files = Array.from({ length: 12 }, (_, i) => `services/s${i}.js`);
    const r = decidir({ status: 'ahead', ahead_by: 4, files, completa: true, fuente: 'diff', newest: VIEJO });
    expect(r.extra.pendingBackend).toHaveLength(5);
    expect(r.extra.pendingBackendTotal).toBe(12);
  });

  it('`identical` no depende de ninguna lista: PASS aunque venga marcada incompleta', () => {
    const r = decidir({ status: 'identical', ahead_by: 0, files: [], completa: false });
    expect(r.code).toBe(0);
    expect(r.verdict).toBe('PASS');
  });

  it('la ventana de deploy en vuelo sigue viva y es lo único que ablanda un STALE', () => {
    const reciente = new Date(AHORA - 5 * 60000).toISOString();
    const r = decidir({ status: 'ahead', ahead_by: 1, files: ['services/x.js'], completa: true, fuente: 'json', newest: reciente });
    expect(r.code).toBe(0);
    expect(r.extra.reason).toMatch(/en vuelo/);
  });

  /**
   * La rama que el refactor de este trabajo volvió testeable y que no se estaba testeando: un
   * force-push o un rollback dejan el sha desplegado fuera de main. Mutarla a `if (false && ...)`
   * la hacía caer en el `identical` de abajo y salía **PASS "ninguno (== HEAD)"** con 958 tests
   * en verde. Cobertura alrededor del cambio: el archivo cubría 5 de 6 ramas.
   */
  it('un sha que no es ancestro de main es exit 2, no PASS', () => {
    for (const status of ['behind', 'diverged']) {
      const r = decidir({ status, ahead_by: 0, files: [], completa: true });
      expect(r.code, status).toBe(2);
      expect(r.verdict).toMatch(/no es ancestro de main/);
      expect(r.verdict).toMatch(status);
    }
  });
});

/**
 * **Los defaults de producción, sin inyectar nada.** Los tests de arriba pasan `dispara` e
 * `inFlightMin` para poder controlar el escenario, y por eso ninguno ejercitaba el cableado real:
 * la revisión adversarial cambió `dispara = disparaBuildRailway` por `dispara = () => false` y
 * `?? 10` por `?? 1000000`, y las DOS mutaciones dejaron los 958 tests en verde. En producción la
 * primera contesta PASS para cualquier backend stale (nada dispara build) y la segunda convierte
 * todo STALE en "deploy en vuelo" (la ventana pasa a ser de 1,9 años).
 *
 * `disparaBuildRailway` sí estaba cubierto por `railway-watchpatterns-paridad.test.js`. Lo que no
 * cubría nada era que `decidirFrescura` lo USE, que es justo lo que el refactor movió a un default
 * de parámetro.
 */
describe('decidirFrescura: los defaults de producción están cableados', () => {
  const VIEJO = '2020-01-01T00:00:00.000Z'; // fuera de cualquier ventana razonable

  it('usa el predicado REAL de railway.json cuando no se inyecta `dispara`', () => {
    // `handlers/webhook.js` es runtime del backend: Railway lo observa. Sin el predicado real
    // cableado, `pendingBackend` sale vacío y esto daría PASS.
    const r = decidirFrescura({
      deployed: 'abcdef1234567890',
      cmp: { status: 'ahead', ahead_by: 1, files: ['handlers/webhook.js'], completa: true, fuente: 'json', newest: VIEJO },
    });
    expect(r.code, 'un archivo de runtime pendiente es STALE').toBe(1);
    expect(r.extra.pendingBackend).toContain('handlers/webhook.js');
  });

  it('y el predicado real EXCLUYE lo que railway.json excluye', () => {
    const r = decidirFrescura({
      deployed: 'abcdef1234567890',
      cmp: { status: 'ahead', ahead_by: 1, files: ['webapp/src/x.ts', 'docs/y.md'], completa: true, fuente: 'json', newest: VIEJO },
    });
    expect(r.code, 'webapp/ y docs/ no redespliegan el backend').toBe(0);
    expect(r.verdict).toBe('PASS');
  });

  it('usa la ventana de deploy en vuelo REAL (10 min), no una inventada', () => {
    // Un commit de hace 30 minutos está FUERA de la ventana de 10: tiene que salir STALE. Con el
    // default mutado a 1000000 esto daría PASS "deploy en vuelo".
    const hace30min = new Date(Date.now() - 30 * 60000).toISOString();
    const r = decidirFrescura({
      deployed: 'abcdef1234567890',
      cmp: { status: 'ahead', ahead_by: 1, files: ['index.js'], completa: true, fuente: 'json', newest: hace30min },
    });
    expect(r.code).toBe(1);
    expect(r.extra.newestCommitAgeMin).toBeGreaterThanOrEqual(29);
  });
});
