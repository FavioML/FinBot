// La lista COMPLETA de archivos de un rango `base...head`, que la API de compare no da.
//
// EL PROBLEMA, medido el 08-ago-2026 contra la API en vivo y este repo. El endpoint
// `repos/{repo}/compare/{base}...{head}` **trunca `files` en 300**, sin bandera y sin campo
// que lo avise. El corte está caracterizado, no estimado: la lista que devuelve es
// byte-idéntica a `git diff --name-only base...head | LC_ALL=C sort | head -300`. O sea
// orden alfabético de bytes y corte duro en 300.
//
//   base `1bdbd6a` (HEAD~400) ...main
//     archivos reales (git)          : 667
//     observados por railway.json    : 302
//     lo que devuelve la API          : 300  ->  193 observados
//     observados INVISIBLES            : 109
//
// LAS DOS SALIDAS QUE NO EXISTEN, las dos medidas antes de descartarlas:
//
//   a) **No hay campo de total.** Los únicos numéricos del payload son `ahead_by`,
//      `behind_by` y `total_commits`. No hay `total_files` ni nada equivalente.
//   b) **Paginar no sirve, y falla en la dirección peligrosa.** `per_page`/`page` paginan
//      los COMMITS, no los archivos: `files` viene poblado solo en la página 1 y siempre
//      topado en 300; `page=2` devuelve `files: 0`. Un harness que paginara ingenuamente
//      concluiría "no hay más archivos", que es peor que el truncado original.
//
// LA SALIDA QUE SÍ EXISTE: el media type `application/vnd.github.diff` del MISMO endpoint
// **no está topado**, y conserva la semántica de RANGO, que es la parte que no se puede
// negociar (ver abajo).
//
// Medido: entrega **667 y 744 bloques `diff --git`** en el rango de arriba y en
// `HEAD~700...main`, contra 667 y 744 archivos que reporta `git`. La igualdad es sobre los
// BLOQUES. La lista de rutas que devuelve el parser es a propósito un **superconjunto** (668 y
// 749) porque un rename aporta sus DOS puntas, igual que el `previous_filename` del JSON. Lo
// que se verificó es que no falta ninguna (`solo-en-git` vacío en los dos rangos), no que los
// largos coincidan: la primera versión de esta nota decía "667/667 ... coincidiendo archivo por
// archivo", y el próximo que la comprobara comparando largos habría leído un bug donde hay un
// diseño.
//
// LO QUE NO SE PUEDE HACER, y es la trampa obvia: unir los diffs commit por commit. Sería
// INCORRECTO, no solo caro. Railway evalúa `watchPatterns` sobre el diff desde el último
// commit DESPLEGADO, no sobre cada commit suelto, y por eso un revert como `352356f` da
// "No changes to watched files" pese a tocar `tests/` en su propio diff. Una unión por
// commit lo reportaría como cambio observado: **STALE falso**. Mismo argumento para unir
// diffs por tramos: un archivo tocado en un tramo y revertido en otro aparece en los dos.
// La única forma correcta es un diff de rango, y de ahí el media type.
//
// HONESTIDAD SOBRE LA SEVERIDAD, porque la nota que originó este trabajo la tenía mal. El
// truncado NO produce hoy un veredicto falso en `backend-deploy-fresh`: rompe la LISTA, no
// la conclusión. Para que `pendingBackend` saliera vacío harían falta ≥300 archivos
// EXCLUIDOS ordenando antes del primer observado.
//
// Y no es alcanzable por ARITMÉTICA, no por suerte. De las cuatro exclusiones de `railway.json`,
// `webapp/**` (323 archivos, tres cuartos del total) **ordena ÚLTIMO** —hoy no hay ni un archivo
// del árbol que ordene después de `webapp/`—, así que ninguno de sus archivos puede preceder a un
// observado. Los excluidos que sí podrían son `docs/` (35) + `qa-e2e/` (89) + `*.md` de raíz (1)
// = **125 en todo el repo**, y 125 < 300 para cualquier rango.
//
// Medido aparte, la posición real del primer observado sobre 120 bases consecutivas: 102 veces 0,
// una vez 1, 16 veces 2. El 0 tan frecuente lo explica `.claude/**`, que **está OBSERVADO** (no
// aparece en las exclusiones) y ordena primero en bytes.
//
// (Historia de este párrafo, porque son tres versiones y las tres estuvieron mal: un "techo" de
// 137 metiendo los 13 de `.claude/` del lado equivocado —lo desmintió el propio harness listando
// `.claude/commands/deploy.md` en `pendingBackend`—; después 124; y después "0 en todas, siempre",
// medido cada 20 commits, un muestreo que produce rangos largos que SIEMPRE tocan `.claude/` y por
// lo tanto no podía devolver otra cosa. Esa última cambió una demostración por una muestra sesgada
// y la enunció con la palabra "siempre". La cota de 125 hay que RE-DERIVARLA si cambia
// `railway.json` o si aparece un directorio que ordene después de `webapp/`.)
//
// Se arregla igual por dos motivos concretos: (1) esa protección es INCIDENTAL, depende de
// la forma del repo y nada la vigila, así que una exclusión nueva que ordene temprano la
// erosiona en silencio; y (2) `severidad()` en `backend-deploy-tested` decide con
// `observados.length === 0` e imprime "el runtime que corre es el mismo que sí se testeó".
// El truncado solo puede BAJAR ese conteo, o sea que solo puede empujar hacia la rama
// tranquilizadora. Una lista incompleta nunca debe poder producir una afirmación de calma.

import { execFileSync } from 'node:child_process';

/**
 * El tope de la API. Se compara con `>=`, no con `>`, y no es un off-by-one: un rango con
 * EXACTAMENTE 300 archivos reales es indistinguible de uno truncado en 300, porque no hay
 * campo de total con el que desempatar. Tratar los dos como sospechosos cuesta una llamada
 * de más en un caso raro; tratarlos como sanos deja pasar el caso malo.
 */
export const TOPE_FILES = 300;

const PREFIJO_HEADER = 'diff --git ';

function ghPorDefecto(ruta, jq, extra = []) {
  const args = ['api', ruta, ...extra];
  if (jq) args.push('--jq', jq);
  // El diff crudo del rango de 400 commits mide 5 MB y el de 700 mide 6 MB, contra el default de
  // 1 MB de `execFileSync`. Se sube para que el caso normal no falle.
  //
  // La razón que estaba escrita acá era falsa y la midió una revisión: decía que el default
  // "cortaría el diff y `nombresDeRawDiff` devolvería una lista corta SIN saberlo". No: desbordar
  // `maxBuffer` **TIRA** `ENOBUFS` (`status: null`, `SIGTERM`), lo atrapa el `try/catch` de
  // `compararRango`, y sale `completa: false, fuente: 'json-topado'` con el error adentro. O sea
  // que el default fallaba ruidoso y del lado seguro; lo que produce es un exit 2 espurio, no una
  // lista corta silenciosa. Sigue estando bien subirlo, por el exit 2.
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
}

/**
 * Una ruta tal como la escribe git, desescapada. `null` si lleva un escape que no sabemos leer.
 *
 * Git aplica `core.quotePath` y **la API de GitHub también**: una ruta con bytes no-ASCII sale
 * entre comillas y con escapes octales por byte —`"a/acentuado-\303\261.txt"`—, igual en la
 * cabecera que en `---`/`+++`/`rename`. Verificado contra la API en vivo, no solo con git local.
 *
 * Sin esto el parser fallaba de dos formas distintas, y la segunda es la grave:
 *
 *  - una MODIFICACIÓN de ruta no-ASCII no matchea ningún prefijo (`--- "a/` no es `--- a/`) y el
 *    bloque cae en `sinParsear`. Falla del lado seguro, pero deja el harness en exit 2 permanente.
 *  - un **rename MIXTO** (ascii → no-ascii) es peor. Medido: git cita **solo el lado que lo
 *    necesita** (`diff --git a/plain.txt "b/renombrado-\303\251.txt"`), así que `rename from
 *    plain.txt` matchea y `rutas` queda no-vacío: no hay `null`, `sinParsear` sale en 0, y la
 *    lista se declara COMPLETA con la cadena cruda `"renombrado-\303\251.txt"` en lugar de la
 *    ruta real. Un archivo perdido en silencio con la lista marcada completa, que es exactamente
 *    lo que este módulo afirma que no puede pasar.
 *
 * Y cerraba una divergencia fea: el camino JSON (n < 300) **no** cita, así que la misma ruta se
 * escribía distinto según si el rango cruzaba los 300 archivos.
 *
 * Los escapes se juntan como BYTES y se decodifican como UTF-8 al final: `\303\261` son dos bytes
 * de un solo carácter, y decodificarlos de a uno da mojibake. `fatal: true` para que una
 * secuencia inválida sea `null` y no un `�` silencioso. Un escape desconocido es `null`
 * también: acá no se adivina.
 */
export function desescaparRuta(s) {
  if (typeof s !== 'string') return null;
  if (!(s.length >= 2 && s.startsWith('"') && s.endsWith('"'))) return s;

  const SIMPLES = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11, '\\': 92, '"': 34 };
  const cuerpo = s.slice(1, -1);
  const codificador = new TextEncoder();
  const bytes = [];

  for (let i = 0; i < cuerpo.length; i++) {
    const c = cuerpo[i];
    if (c !== '\\') {
      for (const b of codificador.encode(c)) bytes.push(b);
      continue;
    }
    const sig = cuerpo[i + 1];
    if (sig === undefined) return null; // barra colgando
    if (sig >= '0' && sig <= '7') {
      const oct = cuerpo.slice(i + 1, i + 4);
      if (!/^[0-7]{3}$/.test(oct)) return null;
      bytes.push(parseInt(oct, 8));
      i += 3;
      continue;
    }
    if (Object.hasOwn(SIMPLES, sig)) {
      bytes.push(SIMPLES[sig]);
      i += 1;
      continue;
    }
    return null; // escape que no conocemos
  }

  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes));
  } catch {
    return null;
  }
}

/**
 * Las rutas de UN bloque de diff, o `null` si el bloque no se pudo leer sin ambigüedad.
 *
 * Se mira SOLO la región de cabecera del bloque, o sea hasta el primer `@@`. No es prolijidad:
 * en un diff unificado las líneas de contenido van prefijadas con `-`, y una línea BORRADA cuyo
 * contenido sea `-- a/x` se imprime como `--- a/x`, indistinguible de la cabecera. Parsear
 * `--- ` en todo el bloque inventa archivos a partir del contenido de un diff.
 *
 * Tres fuentes, por orden de confianza:
 *
 * 1. `rename from` / `rename to` — una ruta por línea, sin ambigüedad posible. Hacen falta:
 *    el rename de `services/subscriptions.js` a `services/subscriptions/catalog.js` es el
 *    único de 667 archivos donde leer un solo lado daba una lista distinta a la de `git`.
 * 2. `--- a/x` y `+++ b/x` — una ruta por línea. `/dev/null` en altas y bajas se saltea.
 *    **No alcanzan solas:** un archivo binario no tiene ninguna de las dos (trae
 *    `Binary files ... differ`), y un cambio de solo-modo tampoco.
 * 3. La cabecera `diff --git a/X b/Y`. Git **no** cita las rutas con espacios (medido: un
 *    archivo llamado `con espacio.txt` sale `diff --git a/con espacio.txt b/con espacio.txt`),
 *    así que en general es ambigua. Para el caso `X === Y` —todo lo que no es un rename— se
 *    resuelve por longitud y queda EXACTA. Si ni eso cierra, se devuelve `null`.
 *
 * `null` es "no sé leer esto", y quien llama lo convierte en "lista incompleta". Nunca en una
 * lista corta que se lea como completa.
 */
export function rutasDeBloque(lineas) {
  const header = (lineas[0] ?? '').replace(/\r$/, '');
  const rutas = new Set();
  // Una sola ruta que no se pueda desescapar invalida el bloque ENTERO, aunque las otras se
  // hayan leído bien: quedarse con las que se entendieron es perder una en silencio.
  let ilegible = false;

  const agregar = (cruda) => {
    const r = desescaparRuta(cruda);
    if (r === null || r === '') { ilegible = true; return; }
    rutas.add(r);
  };

  // El TAB final de `---`/`+++`: git lo agrega cuando la ruta tiene un ESPACIO, **cite o no
  // cite**. La primera versión de esto decía lo contrario ("las rutas citadas nunca llevan TAB")
  // y lo midió falso una revisión adversarial contra la API en vivo: una ruta no-ASCII CON espacio
  // —el caso normal en cualquier repo en español— llega citada Y con TAB:
  //
  //     +++ "b/Alg\303\272n d\303\255a.md"<TAB>
  //
  // Por eso el TAB se quita SIEMPRE, y el `endsWith('"')` que había acá era la condición
  // equivocada: con TAB después de la comilla daba false y funcionaba de casualidad, por el orden
  // en que caían los `if`. Quitar el TAB de una ruta citada es inocuo (una ruta citada termina en
  // comilla, así que no hay TAB que perder) y necesario cuando lo lleva.
  const limpiar = (l) => l.replace(/\t+$/, '');

  for (const cruda of lineas.slice(1)) {
    const l = cruda.replace(/\r$/, '');
    if (l.startsWith('@@')) break; // fin de la cabecera: lo que sigue es contenido
    const s = limpiar(l);
    if (s.startsWith('rename from ')) agregar(s.slice('rename from '.length));
    else if (s.startsWith('rename to ')) agregar(s.slice('rename to '.length));
    else if (s.startsWith('--- a/')) agregar(s.slice('--- a/'.length));
    else if (s.startsWith('+++ b/')) agregar(s.slice('+++ b/'.length));
    // Las variantes citadas: `--- "a/X"` y `+++ "b/X"`. Se reconstruye la comilla de apertura
    // para que `desescaparRuta` vea una cadena bien formada.
    else if (s.startsWith('--- "a/')) agregar(`"${s.slice('--- "a/'.length)}`);
    else if (s.startsWith('+++ "b/')) agregar(`"${s.slice('+++ "b/'.length)}`);
  }

  if (ilegible) return null;
  if (rutas.size) return [...rutas];

  // Fallback: la cabecera. Solo se llega acá en bloques sin `---`/`+++`/`rename`, o sea binarios
  // y cambios de solo-modo, donde nunca hay rename y por lo tanto `X === Y` siempre.
  const resto = header.slice(PREFIJO_HEADER.length);

  // Caso citado: `"a/X" "b/X"`. Una cadena citada no puede contener una comilla sin escapar, así
  // que acá la cabecera es NO ambigua y se parsea exacto.
  const citado = resto.match(/^"a\/((?:[^"\\]|\\.)*)" "b\/((?:[^"\\]|\\.)*)"$/);
  if (citado) {
    if (citado[1] !== citado[2]) return null; // un rename sin líneas `rename`: no se desambigua
    const r = desescaparRuta(`"${citado[1]}"`);
    return r === null || r === '' ? null : [r];
  }

  // Caso sin citar, resuelto por longitud: git NO cita las rutas con espacios (medido), así que
  // `a/X b/Y` es ambiguo en general y solo cierra cuando `|X| === |Y|`.
  if (resto.startsWith('a/')) {
    const largo = (resto.length - 5) / 2; // 'a/' + X + ' b/' + X  ->  5 + 2*|X|
    if (Number.isInteger(largo) && largo > 0) {
      const x = resto.slice(2, 2 + largo);
      if (resto.slice(2 + largo, 5 + largo) === ' b/' && resto.slice(5 + largo) === x) return [x];
    }
  }
  return null;
}

/**
 * Los nombres de archivo de un diff unificado crudo.
 *
 * Devuelve `{ archivos, entradas, sinParsear }`. `entradas` es cuántos bloques `diff --git`
 * había y `sinParsear` los que `rutasDeBloque` no pudo leer: si esa lista no está vacía, la
 * respuesta NO es completa y quien llama tiene que decirlo.
 *
 * Los bloques se cortan por líneas que empiezan con `diff --git ` en la columna 0. En un diff
 * unificado toda línea de contenido va prefijada (`-`, `+`, ` `), así que una línea de contenido
 * que fuera un header de diff no puede empezar en la columna 0.
 */
export function nombresDeRawDiff(texto) {
  const lineas = String(texto).split('\n');
  const bloques = [];
  let actual = null;

  for (const l of lineas) {
    if (l.startsWith(PREFIJO_HEADER)) {
      if (actual) bloques.push(actual);
      actual = [l];
    } else if (actual) {
      actual.push(l);
    }
  }
  if (actual) bloques.push(actual);

  const archivos = new Set();
  const sinParsear = [];
  for (const b of bloques) {
    const rutas = rutasDeBloque(b);
    if (!rutas) { sinParsear.push(b[0]); continue; }
    for (const r of rutas) archivos.add(r);
  }

  return { archivos: [...archivos].sort(), entradas: bloques.length, sinParsear };
}

/**
 * Los objetos `files` de la API a una lista plana de rutas, con **las dos puntas de un rename**.
 *
 * Mover un archivo de una ruta observada por Railway a una excluida (o al revés) es un cambio en
 * la ruta observada, así que quedarse solo con `filename` haría que un rename que saca código de
 * `services/` se lea como "nada observado cambió": PASS falso.
 *
 * Vive acá y no en el `jq` porque en el `jq` no se podía probar. Ver el comentario en
 * `compararRango`.
 */
export function aplanarArchivos(entradas) {
  const rutas = [];
  for (const f of entradas || []) {
    if (typeof f === 'string') { rutas.push(f); continue; } // tolerancia a la forma vieja
    if (f?.filename) rutas.push(f.filename);
    if (f?.previous_filename) rutas.push(f.previous_filename);
  }
  return [...new Set(rutas)];
}

/**
 * `base...head` con la lista de archivos COMPLETA, o con `completa: false` y el motivo.
 *
 * El contrato que importa: **`completa: false` nunca puede leerse como "no cambió nada
 * observado"**. Una lista incompleta solo puede ESCONDER archivos, así que un resultado con
 * archivos observados sigue siendo de fiar (el que encontraste, cambió de verdad), pero un
 * resultado VACÍO no dice nada. Quien llama tiene que ramificar por `completa` antes de
 * afirmar calma.
 *
 * `files` trae las dos puntas de un rename, igual que el `jq` original (`.filename` y
 * `.previous_filename`): mover un archivo de una ruta observada a una excluida es un cambio
 * en la ruta observada.
 */
export function compararRango({ repo, base, head = 'main', ghFn = ghPorDefecto }) {
  const ruta = `repos/${repo}/compare/${base}...${head}`;
  // El `jq` devuelve los objetos crudos y el aplanado se hace en JS **a propósito**. Antes el
  // `jq` decía `.filename, .previous_filename`, o sea que la regla "las dos puntas de un rename"
  // vivía dentro de una cadena que ningún test puede ejercitar: la revisión adversarial le quitó
  // `previous_filename` y los 958 tests siguieron en verde. Y era el camino de TODOS los días
  // (n < 300), mientras los dientes que sí existían para renames cubrían solo el camino del diff
  // crudo. Ahora la regla está en `aplanarArchivos()`, que es pura y se prueba.
  const jq = '{status, ahead_by, '
    + 'files: [.files[]? | {filename, previous_filename}], '
    + 'nFiles: ((.files // []) | length), '
    + 'newest: (.commits[-1]?.commit.committer.date)}';

  const cmp = JSON.parse(ghFn(ruta, jq));
  const base_ = { status: cmp.status, ahead_by: cmp.ahead_by, newest: cmp.newest };
  const planas = aplanarArchivos(cmp.files);

  // El conteo se VALIDA antes de compararlo, y esto no es paranoia de tipos: lo encontró la
  // segunda vuelta de revisión sobre este mismo archivo. Sin la validación, un payload sin
  // `nFiles` daba `Number(undefined)` -> `NaN`, y **las dos** comparaciones numéricas de abajo
  // eligen la rama insegura ante NaN: `NaN < 300` es false (baja al diff crudo como si
  // estuviera topado) y después `0 < NaN` también es false (la guarda de coherencia no salta).
  // El resultado era `{ files: [], completa: true }`: la lista vacía DECLARADA completa, que es
  // el fail-open exacto que este módulo viene a cerrar, reintroducido adentro del arreglo.
  // `typeof === 'number'` y no `Number(...)`: la coacción convierte `null`, `[]` y `''` en **0**,
  // y `0 < 300` declara la lista completa sea lo que sea. Es el mismo bug que el `undefined` de
  // antes (que daba NaN y caía por el otro lado), un valor al lado. El `jq` produce siempre un
  // entero, así que esto es la red por si alguien le cambia la expresión.
  const n = cmp.nFiles;
  if (typeof n !== 'number' || !Number.isFinite(n)) {
    return {
      ...base_,
      files: planas,
      completa: false,
      fuente: 'json',
      motivoIncompleta: `la respuesta de compare no trajo un conteo de archivos usable `
        + `(nFiles: ${JSON.stringify(cmp.nFiles)}), así que no se puede saber si vino topada`,
    };
  }

  if (n < TOPE_FILES) {
    return { ...base_, files: planas, completa: true, fuente: 'json' };
  }

  // Topado: la lista JSON es inútil como lista. Al diff crudo, que no tiene tope.
  let raw;
  try {
    raw = ghFn(ruta, null, ['-H', 'Accept: application/vnd.github.diff']);
  } catch (e) {
    return {
      ...base_,
      files: planas,
      completa: false,
      fuente: 'json-topado',
      motivoIncompleta: `la API topó \`files\` en ${cmp.nFiles} y el diff crudo falló: `
        + `${String(e?.stderr || e?.message || e).split('\n')[0].trim()}`,
    };
  }

  const { archivos, entradas, sinParsear } = nombresDeRawDiff(raw);

  // ORDEN DE LOS TRES CONTROLES, y no es arbitrario: van del diagnóstico más específico al más
  // genérico. La primera versión ponía el del newline arriba y **tapaba** al de `entradas === 0`
  // justo en el escenario para el que se escribió: `gh api` **sin `--jq`** no termina en newline
  // (medido), y la bajada al diff crudo es sin `--jq`, así que un media type ignorado —que
  // devuelve JSON— caía en "llegó cortada a mitad de hunk" en vez de en "no era un diff". Los dos
  // dan `completa: false`, o sea que no había fail-open, pero el mensaje mandaba a mirar el
  // transporte cuando el problema era la petición.

  // 1) Ni una entrada, con el JSON diciendo que había archivos: esto no era un diff. Es lo que
  //    pasa si el media type se ignora o si un doble de test devuelve JSON.
  if (entradas === 0) {
    return {
      ...base_,
      files: planas,
      completa: false,
      fuente: 'diff',
      motivoIncompleta: `el diff crudo no trajo ni una entrada \`${PREFIJO_HEADER.trim()}\`, `
        + `con ${n} archivos reportados por el JSON: la respuesta no era un diff`,
    };
  }

  // 2) Hay bloques pero el cuerpo no cierra: se cortó a mitad de hunk.
  //
  // Un diff crudo completo termina en newline: verificado sobre las respuestas reales de 5 y 6 MB,
  // incluida una cuyo último archivo tiene `\ No newline at end of file`, y una de solo-binario.
  //
  // Importa porque el corte NO deja rastro por ningún otro lado: cae dentro de un hunk, así que el
  // último bloque conserva sus `---`/`+++` y parsea limpio, y el conteo tampoco lo ve porque en
  // esta rama `n` vale SIEMPRE 300 (es el tope de la API) — o sea que `archivos.length < n` solo
  // cubre la franja 0-299, y cualquier pérdida que deje ≥300 bloques parseables pasaba como
  // completa.
  //
  // **Ojo con la causa, que estuvo mal escrita acá.** Esto NO es el desborde de `maxBuffer`: ese
  // TIRA `ENOBUFS` (medido: `status: null`, `SIGTERM`) y lo atrapa el `try/catch` de arriba, o sea
  // que falla ruidoso y del lado seguro. El mecanismo que esta guarda cubre es otro: una revisión
  // adversarial midió que sobre un diff enorme (~110 MB, por debajo del `maxBuffer` de 128 MB)
  // `gh api` entrega el cuerpo PARCIAL con **exit 0 y stderr vacío**, cinco veces, con el corte en
  // un punto distinto cada vez. No lo reproduje yo —cuesta bajar 110 MB— así que queda anotado
  // como medido por la revisión y no por mí. La guarda es barata e inocua en cualquier caso.
  //
  // Este repo está a ~18x de ese tamaño (la historia entera son ~6 MB), no a órdenes de magnitud.
  // Se pone igual porque la propiedad que este módulo afirma es incondicional, y una protección
  // que depende del tamaño del repo no es una protección: es una coincidencia.
  if (!raw.endsWith('\n')) {
    return {
      ...base_,
      files: [...new Set([...planas, ...archivos])],
      completa: false,
      fuente: 'diff',
      motivoIncompleta: `el diff crudo tiene ${entradas} entradas pero no termina en newline `
        + `(${raw.length} chars): el cuerpo llegó cortado a mitad de hunk. No lo ve ni `
        + `\`sinParsear\` (el último bloque parsea limpio) ni el conteo (en esta rama el tope es `
        + `siempre 300)`,
    };
  }

  // 3) Un bloque que no se pudo leer sin ambigüedad.
  if (sinParsear.length) {
    return {
      ...base_,
      files: [...new Set([...planas, ...archivos])],
      completa: false,
      fuente: 'diff',
      motivoIncompleta: `${sinParsear.length} de ${entradas} entradas del diff crudo no se `
        + `pudieron leer sin ambigüedad (p. ej. ${JSON.stringify(sinParsear[0])})`,
    };
  }

  // Un diff crudo que trae MENOS archivos que la lista topada es incoherente: el diff es la
  // fuente sin tope, así que no puede ser el más corto. Si pasa, algo se cortó (¿maxBuffer?,
  // ¿el media type con su propio límite en un rango gigante?) y no se puede afirmar nada.
  if (archivos.length < n) {
    return {
      ...base_,
      files: [...new Set([...planas, ...archivos])],
      completa: false,
      fuente: 'diff',
      motivoIncompleta: `el diff crudo trajo ${archivos.length} archivos, MENOS que los `
        + `${n} de la lista topada: se cortó en algún lado`,
    };
  }

  return { ...base_, files: archivos, completa: true, fuente: 'diff', entradas };
}
