import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'path';

/**
 * Ninguna lectura de los crons —ni las de `cron/checks.js`, ni las de los servicios que ese
 * archivo llama— puede tirar el `{ error }`.
 *
 * supabase-js **no lanza**: devuelve `{ data: null, error }`. Un `const { data } = await
 * supabase...` no es una abreviatura, es una decisión — la de tratar una caída de la base
 * exactamente igual que "no hay a quién avisar". Y eso no deja excepción, ni log, ni fila en
 * `errores`: el cron corre, no falla, y se apaga mudo.
 *
 * Este guard es de FORMA. Que la forma sirva para algo lo prueban `lecturas-con-error.test.js`
 * y `lecturas-servicios-con-error.test.js`, corriendo los crons y los servicios con la tabla
 * caída y afirmando a quién se notifica. Los dos hacen falta y ninguno reemplaza al otro: el
 * funcional cubre los casos que se ejercitan hoy, este cubre la lectura que alguien agregue
 * mañana.
 *
 * **Por qué mide la FORMA del statement y no busca una cadena.** Un guard que preguntara
 * "¿aparece `error:` en el archivo?" se satisface con una sola lectura arreglada. Uno que
 * mirara sólo la línea del `await` se evade con un salto de línea, que es justamente cómo
 * están escritas las queries largas de estos archivos. Acá se extrae cada expresión
 * `supabase.from(...)` con su lado izquierdo completo y se exige que ese lado **nombre el
 * error**, sea cual sea la sintaxis. Las evasiones que se probaron están fijadas abajo en
 * `EVASIONES`, ejecutadas contra el mismo parser que corre sobre los archivos reales — no
 * descritas en un comentario.
 */

/**
 * **La lista de archivos no se declara: se deriva.**
 *
 * La versión anterior miraba un solo archivo y anotaba el hueco en un docblock —
 * "`services/survey-triggers.js` (12 lecturas)… extender el guard a los servicios que
 * alimentan crons es el trabajo siguiente". Ese docblock tenía dos cosas mal, y las dos son
 * el motivo de que acá no haya lista escrita a mano:
 *
 *   · **El número.** Eran 11, no 12. La 12ª era `registrarEvento`, que SÍ lee su error y hasta
 *     lo re-lanza; la contaba el propio parser, por el bug de backtrack que se arregla más
 *     abajo. O sea que el hueco declarado venía con un defecto ya adentro.
 *   · **El alcance, y se quedó corto DOS veces.** Decía "los servicios", pero el backlog
 *     listaba cinco y `cron/checks.js` requiere **nueve** — los cuatro que faltaban
 *     (`neto-score`, `recommendations`, `spending-alerts`, `subscriptions`) resultaron limpios
 *     al medirlos, así que esa vez la lista corta no costó nada. Lo que sí costó fue el
 *     siguiente recorte: derivar **un solo salto**. Una revisión adversarial mostró que
 *     `summaries.js` estaba dentro y sus dos dependencias directas no, con lecturas mudas
 *     alimentando el resumen semanal. Hoy son **17 archivos** y la derivación es transitiva.
 *
 * Una lista escrita a mano al lado de otra lista que debería ser igual diverge sola. Acá hay
 * una sola, y se recorre entera: los `require` relativos a `services/`, desde el cron.
 */
const RAIZ = process.cwd();

const PALABRAS_ANTES_DE_REGEX = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
  'throw', 'case', 'do', 'else', 'yield', 'await',
]);

/**
 * El recorrido, en una sola pasada. `sinComentarios` y `sinLiterales` son sus dos vistas.
 *
 * **Tiene que entender literales de REGEX, y esa no fue la primera versión.** La primera
 * reconocía cadenas y comentarios nada más, y con eso un `/['"]/` la desincronizaba: la
 * comilla de adentro del regex abría una cadena que no existía. Medido por una revisión
 * adversarial: **24 archivos del repo tienen esa forma** (entre ellos
 * `services/import-parser.js`, que vive en el directorio del que sale el perímetro), y el
 * caso peor no es el que tira sino el que NO tira — con un número PAR de comillas espurias
 * se emparejan entre sí, el largo se preserva, y todo lo que hay en el medio queda adentro
 * de una cadena fabricada. Con dos `/"/g` en el mismo archivo se llegaba a **resucitar una
 * query comentada** y a devolver el falso positivo que este mismo commit arregla.
 *
 * Regex o división se decide por el último carácter significativo, que es el criterio de
 * cualquier lexer de JS: después de un valor (`)`, un identificador, un número) una barra
 * divide; después de un operador, una coma, una apertura, un `;`, un `}` o una de las
 * palabras de `PALABRAS_ANTES_DE_REGEX`, empieza un literal. Adentro del literal, una `/`
 * dentro de una clase `[...]` no lo cierra.
 *
 * `blanquearLiterales` es lo que separa las dos vistas y NO puede ser siempre true:
 * `serviciosQueLlamaElCron` lee la ruta de adentro de la cadena del `require`.
 */
function recorrer(src, { blanquearLiterales = false, etiqueta = '' } = {}) {
  const n = src.length;
  const donde = etiqueta ? ' (' + etiqueta + ')' : '';
  let out = '';
  let i = 0;
  // Pila de contextos: `codigo` lleva su profundidad de llaves para saber qué `}` cierra
  // una interpolación `${…}` y cuál es una llave común.
  const pila = [{ tipo: 'codigo', llaves: 0 }];
  const cima = () => pila[pila.length - 1];
  const blanco = (c) => (c === '\n' ? '\n' : ' ');
  const emitir = (desde, hasta, blanquear) => {
    for (let k = desde; k < hasta; k++) out += blanquear ? blanco(src[k]) : src[k];
  };
  const ultimoSignificativo = () => {
    for (let k = out.length - 1; k >= 0; k--) if (!/\s/.test(out[k])) return out[k];
    return '';
  };
  const palabraAntes = () => {
    let k = out.length - 1;
    while (k >= 0 && /\s/.test(out[k])) k--;
    const fin = k + 1;
    while (k >= 0 && /[\w$]/.test(out[k])) k--;
    return out.slice(k + 1, fin);
  };

  while (i < n) {
    const ctx = cima();
    const c = src[i];

    if (ctx.tipo === 'tpl') {
      if (src.charCodeAt(i) === 92) { emitir(i, Math.min(i + 2, n), blanquearLiterales); i += 2; continue; }
      if (c === '`') { out += c; i++; pila.pop(); continue; }
      if (c === '$' && src[i + 1] === '{') { out += '${'; i += 2; pila.push({ tipo: 'codigo', llaves: 0 }); continue; }
      out += blanquearLiterales ? blanco(c) : c;
      i++;
      continue;
    }

    if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') { out += ' '; i++; } continue; }
    if (c === '/' && src[i + 1] === '*') {
      const fin = src.indexOf('*/', i + 2);
      const hasta = fin < 0 ? n : fin + 2;
      emitir(i, hasta, true);
      i = hasta;
      continue;
    }

    if (c === "'" || c === '"') {
      out += c;
      i++;
      const ini = i;
      let cerrada = false;
      while (i < n) {
        if (src.charCodeAt(i) === 92) { i += 2; continue; }
        if (src[i] === c) { cerrada = true; break; }
        if (src[i] === '\n') break;   // una cadena de comillas no cruza líneas
        i++;
      }
      emitir(ini, Math.min(i, n), blanquearLiterales);
      if (!cerrada) throw new Error('cadena sin cerrar' + donde + ' en la línea ' + (out.split('\n').length) + ': el fuente quedó desincronizado. Extendé el scanner, no lo silencies.');
      out += src[i];
      i++;
      continue;
    }

    if (c === '`') { out += c; i++; pila.push({ tipo: 'tpl' }); continue; }

    if (c === '/') {
      const prev = ultimoSignificativo();
      const esRegex = prev === '' || '(,=:[!&|?{};+-*%~^<>'.includes(prev) || PALABRAS_ANTES_DE_REGEX.has(palabraAntes());
      if (esRegex) {
        out += c;
        i++;
        const ini = i;
        let clase = false;
        let cerrado = false;
        while (i < n) {
          if (src.charCodeAt(i) === 92) { i += 2; continue; }
          if (src[i] === '\n') break;              // un literal de regex no cruza líneas
          if (src[i] === '[') clase = true;
          else if (src[i] === ']') clase = false;
          else if (src[i] === '/' && !clase) { cerrado = true; break; }
          i++;
        }
        emitir(ini, Math.min(i, n), blanquearLiterales);
        if (!cerrado) throw new Error('literal de regex sin cerrar' + donde + ' en la línea ' + (out.split('\n').length) + ': el fuente quedó desincronizado. Extendé el scanner, no lo silencies.');
        out += src[i];
        i++;
        continue;
      }
    }

    if (c === '{') ctx.llaves++;
    else if (c === '}') {
      if (ctx.llaves === 0 && pila.length > 1) { out += c; i++; pila.pop(); continue; }
      ctx.llaves--;
    }
    out += c;
    i++;
  }

  // Terminar fuera del contexto de código de nivel cero significa que el recorrido perdió
  // el hilo, y todo lo que se mida sobre eso es basura que parece un veredicto.
  if (pila.length !== 1 || pila[0].tipo !== 'codigo') throw new Error('el recorrido terminó dentro de un template' + donde + ': el fuente quedó desincronizado');
  if (out.length !== src.length) throw new Error('el recorrido no preservó el largo' + donde + ': los números de línea del reporte dejarían de ser los del archivo');
  return out;
}

/**
 * Reemplaza comentarios por espacios del MISMO largo. Preserva los offsets, o sea que los
 * números de línea del reporte siguen siendo los del archivo real — y de paso un
 * `supabase.from(` que viva dentro de un comentario deja de contar como código.
 *
 * **Recorre el fuente en vez de aplicarle un regex, y esa es la diferencia entera.** La
 * versión anterior aplicaba un regex de comentario de línea sobre el fuente crudo, así que
 * cualquier `'…https://app.neto.pe'` era un comentario para el blanqueador: se comía **el
 * resto de la línea, incluido el `;` final del statement**. Sin ese `;`, el backtrack de
 * `lecturas()` cruza al statement de arriba y hereda su `=`.
 *
 * No es hipotético y no es de laboratorio: en `handlers/webhook.js:830` un `update()`
 * fire-and-forget salía reportado como lectura muda con LHS `respuesta`, heredado de la línea
 * que arma el saludo con el link al dashboard. Es la misma familia que el bug de la ventana
 * de 600 caracteres —una escritura y una lectura intercambiadas— con otra causa.
 *
 * Medido: **1 veredicto cambia en `handlers/` + `lib/` (148 sitios) y 0 en este perímetro
 * (165 sitios)**. O sea que acá estaba latente, no dormido por suerte: hoy no hay ninguna
 * cadena con `//` cerrando un statement antes de una query, y mañana la puede escribir
 * cualquiera.
 */
function sinComentarios(src, etiqueta = '') {
  return recorrer(src, { etiqueta });
}

/**
 * Lo mismo, y además con el CONTENIDO de cadenas, de los tramos de texto de un template y
 * de los literales de regex vaciado — conservando el código de las interpolaciones `${…}`,
 * que sí se ejecuta y puede llevar una query adentro.
 *
 * Hace falta porque el análisis de `lecturas()` mira `;`, `=` y llaves para decidir dónde
 * empieza un statement y qué le asigna, y **cualquiera de los tres dentro de una cadena
 * miente**. Las tres formas se midieron:
 *
 *   · `const plantilla = 'const { data, error } = await supabase'` seguido de una escritura
 *     fire-and-forget: la cadena le regalaba a la escritura un LHS que lee el error, o sea
 *     una **exención**, que es la peor de las tres salidas;
 *   · un `;` adentro de una cadena cortaba el statement antes de tiempo;
 *   · una llave suelta en un texto (`enviar('formato {')`) disparaba la regla de bloque
 *     sobre una lectura correcta.
 *
 * El mismo texto DENTRO de un comentario ya se blanqueaba desde siempre. Esa asimetría
 * —comentario sí, cadena no— era el hueco, y lo encontró una revisión adversarial.
 */
function sinLiterales(src, etiqueta = '') {
  return recorrer(src, { blanquearLiterales: true, etiqueta });
}

/**
 * **El cierre TRANSITIVO** de los `services/` que el cron alcanza, arrancando en
 * `cron/checks.js`.
 *
 * La primera versión seguía UN salto, y la revisión adversarial mostró lo que eso cuesta con
 * un caso vivo: `generarResumenSemanal` —hermano de las dos funciones que este mismo commit
 * arregló, en el mismo archivo— delega en `obtenerGastosSemana` (`services/transactions.js`)
 * y `obtenerPresupuestosMes` (`services/budget.js`), y las dos descartaban su `{ error }`.
 * `summaries.js` estaba dentro del perímetro; sus dos dependencias directas no.
 *
 * O sea que con un solo salto **mover una query un archivo más adentro la saca de
 * jurisdicción**, que es exactamente el refactor que creó este trabajo.
 */
function serviciosQueLlamaElCron(entrada) {
  const vistos = new Set();
  const cola = [entrada];
  const out = [];
  while (cola.length) {
    const rel = cola.shift();
    if (vistos.has(rel)) continue;
    vistos.add(rel);
    if (rel !== entrada) out.push(rel);
    // El `catch` cubre el archivo que NO EXISTE (un `require` a algo que se movió), y nada
    // más. Cuando tragaba también los errores del recorrido, un fuente que el scanner no
    // sabe leer sacaba a ese servicio del perímetro **y a todo lo que colgara de él**:
    // medido inyectando un literal de regex con comilla en `services/summaries.js`, la
    // derivación bajaba de 18 a 17 archivos y `services/budget.js` desaparecía. Un guard que
    // mira menos por un error de su propio parser es la falla que este archivo persigue.
    //
    // **Es el único cambio de este commit sin un test que pueda matarlo**, y va dicho en vez
    // de afirmado de más: revertirlo a `try { …sinComentarios… } catch { continue }` deja las
    // 45 aserciones en verde, porque hoy no hay ningún archivo del árbol sobre el que el
    // recorrido falle — y eso lo vigila el caso `no se desincroniza en ningún archivo del
    // árbol de runtime`, que es lo que acota el riesgo. Probarlo de verdad pide escribir un
    // fuente roto dentro de `services/` durante la corrida, y un test que deja basura en el
    // árbol cuesta más de lo que compra.
    let src;
    try {
      src = readFileSync(path.join(RAIZ, rel), 'utf-8');
    } catch { continue; }
    src = sinComentarios(src, rel);
    const dir = path.posix.dirname(rel.split(path.sep).join('/'));
    const re = /require\(\s*['"](\.[\w./-]+?)(?:\.js)?['"]\s*\)/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      const abs = path.posix.normalize(path.posix.join(dir, m[1]));
      if (!abs.startsWith('services/')) continue;   // `lib/` es infraestructura, no queries de cron
      for (const f of archivosDe(abs.slice('services/'.length))) if (!vistos.has(f)) cola.push(f);
    }
  }
  return out.sort();
}

/**
 * Resuelve `X` a los archivos reales. Un servicio puede ser un archivo o un directorio con
 * `index.js`; en el segundo caso entran TODOS sus `.js`, porque el `index` que el cron
 * requiere suele ser un re-export y las queries viven en los submódulos. (`subscriptions/`
 * es exactamente eso: su `index.js` no toca supabase, `detector.js` sí.)
 */
function archivosDe(servicio) {
  const base = path.join(RAIZ, 'services', servicio);
  try {
    if (statSync(base).isDirectory()) {
      return readdirSync(base)
        .filter((f) => f.endsWith('.js'))
        .map((f) => 'services/' + servicio + '/' + f);
    }
  } catch { /* no existe como directorio: es un archivo suelto */ }
  return ['services/' + servicio + '.js'];
}

const ARCHIVOS = ['cron/checks.js', ...serviciosQueLlamaElCron('cron/checks.js')];

/**
 * **Los archivos del perímetro que todavía NO se barrieron, con su conteo de mudas. Hoy: cero.**
 *
 * Tuvo tres entradas exactamente un día. Las agregó el commit que volvió transitiva la
 * derivación (`services/transactions.js` 10, `services/budget.js` 3, `services/categories.js` 3)
 * y las sacó el siguiente, que las barrió. Que el mapa quede vacío es el estado final que el
 * trinquete perseguía, no una lista que se olvidó de llenarse.
 *
 * **Sigue siendo un trinquete y por eso no se borra.** Vacío significa que `ninguna descarta el
 * { error }` cubre el perímetro ENTERO sin excepciones: una lectura muda nueva, en cualquier
 * archivo, rompe el build. Agregar una entrada acá es la única forma de posponer un barrido, y
 * cuesta escribir el número — que después sólo puede bajar, y al llegar a cero obliga a sacar
 * la fila (`ningún pendiente está en cero`).
 */
const PENDIENTES = {};

/**
 * Y su mitad de ESCRITURAS, que hace falta por separado. También en cero.
 *
 * Las dos que tenía —los dos `insert` de subcategorías de `services/categories.js`— se cerraron
 * con un log cada una: son accesorias (el gasto que las dispara ya está escrito) pero una
 * subcategoría que desaparece porque el insert fue rechazado es indistinguible de una que el
 * usuario nunca pidió.
 *
 * Existe separada porque la primera versión del trinquete contaba sólo las lecturas y excluía a
 * esos archivos de la aserción de escrituras **sin contarlas**, o sea que una escritura
 * fire-and-forget nueva entraba en silencio: el agujero exacto que `PENDIENTES` evita, en la
 * otra mitad del mismo problema.
 */
const PENDIENTES_ESCRITURAS = {};

/**
 * Retrocede desde el `=` y devuelve el patrón asignado, y nada más: un destructuring
 * balanceado (`{ data, error }`, `[{ data: a, error: e }]`) o un identificador suelto
 * (`yaAviso`). Es lo que separa "el LHS" de "el texto que quedó antes del signo igual".
 */
function lhsDe(src, idxIgual) {
  let i = idxIgual - 1;
  while (i >= 0 && /\s/.test(src[i])) i--;
  if (i < 0) return '';
  const fin = i + 1;
  if (src[i] === '}' || src[i] === ']') {
    let prof = 0;
    for (; i >= 0; i--) {
      const c = src[i];
      if (c === '}' || c === ']') prof++;
      else if (c === '{' || c === '[') { prof--; if (prof === 0) break; }
    }
    return src.slice(Math.max(i, 0), fin).trim();
  }
  while (i >= 0 && /[\w$.]/.test(src[i])) i--;
  return src.slice(i + 1, fin).trim();
}

/**
 * Extrae cada uso de `supabase.from(...)` / `supabase.rpc(...)` con su lado izquierdo.
 *
 * Devuelve `{ lhs, linea }`. `lhs` es `null` cuando el statement no asigna nada: una
 * escritura fire-and-forget.
 *
 * **Lo que rompió cada versión de esta función, en orden:**
 *
 *   · **`Promise.all` era invisible.** El regex exigía `await supabase`, y ahí el `await` está
 *     sobre el `Promise.all`, no sobre la query — con dos lecturas de
 *     `checkRecordatorioOnboarding` dentro del propio archivo que el guard decía cubrir. Por
 *     eso ancla en `supabase.from(`.
 *   · **El backtrack cruzaba statements**, retrocediendo hasta el último `const|let|var` de
 *     los 400 caracteres previos. Se cortó en el `;` anterior.
 *   · **Y el corte en el `;` no alcanzaba.** Quedaban tres agujeros que sólo aparecieron al
 *     apuntar el guard a los servicios, y los tres son de la misma familia — el LHS se
 *     adivinaba por posición en vez de leerse:
 *
 *       – **El primer `=` de la ventana no es el de la asignación.** Entre el `;` anterior y
 *         la query puede haber una firma de función con parámetro por defecto. Es literal:
 *         `async function registrarEvento({ …, responseData = null })` hacía que el LHS
 *         extraído fuera la firma, y esa lectura —que lee su error y lo re-lanza— salía
 *         reportada como muda. Un guard que señala una línea correcta es la clase de guard
 *         que se aprende a ignorar. Ahora se toma el **último** `=` de asignación.
 *       – **Quedarse con "todo lo que hay antes del `=`" tampoco es el LHS.** Con
 *         `const opciones = { error: true }` en la línea de arriba y sin `;`, ese `error:`
 *         ajeno alcanzaba para dar por buena la lectura de abajo. Ahora se retrocede desde el
 *         `=` balanceando llaves y se extrae el patrón exacto.
 *       – **La ventana de 600 caracteres decapitaba los `Promise.all` largos.** El de
 *         `recommendations.js` tiene cinco queries: la quinta quedaba fuera de la ventana, se
 *         reportaba `lhs: null` y el guard la contaba como **escritura fire-and-forget**, o
 *         sea que la sacaba de su propia jurisdicción. Un punto ciego disfrazado de exención
 *         es peor que uno que se ve.
 */
function lecturas(srcConComentarios, etiqueta = '') {
  const src = sinLiterales(srcConComentarios, etiqueta);
  const out = [];
  const re = /\bsupabase\s*\.\s*(?:from|rpc)\s*\(/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const linea = src.slice(0, m.index).split('\n').length;
    // El statement: desde el `;` anterior (sin tope de ventana) hasta la query.
    const izq = src.slice(src.lastIndexOf(';', m.index) + 1, m.index);
    // El ÚLTIMO `=` de asignación: ni flecha (`=>`), ni comparación (`==`, `!=`, `>=`, `<=`).
    const reIgual = /(^|[^=!<>])=(?!=|>)/g;
    let ult = null;
    let mm;
    while ((mm = reIgual.exec(izq)) !== null) ult = mm;
    if (!ult) { out.push({ lhs: null, linea }); continue; }
    const eq = ult.index + ult[0].length - 1;
    // **El `=` tiene que estar en el MISMO bloque que la query.** Si entre el `=` y el ancla
    // se abrió una llave que no cerró, ese `=` es de otra cosa y este statement no asigna
    // nada: es una escritura fire-and-forget. Las dos formas que lo disparan están vivas:
    //
    //   · `const marcarVerificado = async () => { await supabase.from('webapp_otp')…`
    //   · `async function registrarError(tag, msg, opts = {}) { try { await supabase.from('errores')…`
    //
    // La segunda es el mismo parámetro por defecto que el caso de `registrarEvento` que ya
    // tiene su fixture — y muestra que "tomar el último `=`" sólo alcanza cuando la query SÍ
    // asigna. Cuando no asigna nada, la firma vuelve a ganar y una ESCRITURA sale reportada
    // como lectura muda: el guard en rojo sobre código correcto, que es la dirección que
    // enseña a ignorarlo.
    //
    // El balance de llaves basta y no abre nada: son 0 sitios de 165 en este perímetro y 2 de
    // 148 en `handlers/`+`lib/`, los dos escrituras verificadas a mano. Y si algún día una
    // lectura de verdad cayera acá, no desaparece: pasa a `SIN_ASIGNACION`, que este mismo
    // archivo exige vacío. Cambia de aserción, no de jurisdicción.
    let bloque = 0;
    for (const c of izq.slice(eq + 1)) { if (c === '{') bloque++; else if (c === '}') bloque--; }
    if (bloque > 0) { out.push({ lhs: null, linea }); continue; }
    let lhs = lhsDe(izq, eq);
    if (/^[A-Za-z_$][\w$]*$/.test(lhs)) {
      // Sin `await` entre el `=` y la query, lo que se asignó no es el RESULTADO sino el
      // constructor: el error todavía no existe en esta línea.
      if (!/\bawait\b/.test(izq.slice(ult.index))) lhs = lhsDelAwait(src, m.index, lhs);
      // Y si el resultado entero quedó en una variable, el error puede leerse después como
      // `res.error`. Sin esto, `const res = await …; if (res.error) throw res.error` —que
      // maneja el error perfectamente— salía reportado como mudo.
      else if (new RegExp('\\b' + lhs + '\\s*\\.\\s*error\\b').test(src.slice(m.index))) lhs = '{ error }';
    }
    out.push({ lhs, linea, indice: indicePromiseAll(izq, eq) });
  }
  return out;
}

/**
 * Si esta query está dentro de un `Promise.all([...])`, en qué POSICIÓN de la lista está.
 *
 * Es lo que permite pedirle el error al elemento que le toca en vez de a todos: el patrón de
 * destructuring de un `Promise.all` puede mezclar queries con cualquier otra promesa.
 */
function indicePromiseAll(izq, eq) {
  const tramo = izq.slice(eq);
  const pa = tramo.indexOf('Promise.all');
  if (pa < 0) return null;
  const corchete = tramo.indexOf('[', pa);
  if (corchete < 0) return null;
  let prof = 0;
  let idx = 0;
  for (let i = corchete + 1; i < tramo.length; i++) {
    const c = tramo[i];
    if (c === '(' || c === '[' || c === '{') prof++;
    else if (c === ')' || c === ']' || c === '}') { if (prof === 0) break; prof--; }
    else if (c === ',' && prof === 0) idx++;
  }
  return idx;
}

/**
 * El patrón builder: `let q = supabase.from(...)` arriba, `if (cond) q = q.eq(...)` en el
 * medio, `const { data, error } = await q` abajo. El error sólo existe en esa última línea.
 *
 * Sin esto el guard reportaba `debts.js:57` —una lectura que **ya leía su error**, y cuyo log
 * está escrito y comentado— como muda. Es la misma clase de falso positivo que el parámetro
 * por defecto: el guard señalando trabajo ya hecho. Y no es un caso de laboratorio: de las dos
 * apariciones del patrón dentro del perímetro, una lee su error y la otra no, así que un guard
 * que las tratara igual —en cualquiera de las dos direcciones— se equivoca en una.
 */
function lhsDelAwait(src, desde, ident) {
  const resto = src.slice(desde);
  const re = new RegExp('(^|[^=!<>])(=)(?!=|>)\\s*await\\s+' + ident + '\\b');
  const m = re.exec(resto);
  return m ? lhsDe(resto, m.index + m[1].length) : ident;
}

/** Corta `a, b, c` en sus elementos de PRIMER nivel (ignora las comas anidadas). */
function elementosTopLevel(s) {
  const out = [];
  let prof = 0;
  let actual = '';
  for (const c of s) {
    if (c === '{' || c === '[' || c === '(') prof++;
    else if (c === '}' || c === ']' || c === ')') prof--;
    if (c === ',' && prof === 0) { out.push(actual); actual = ''; continue; }
    actual += c;
  }
  out.push(actual);
  return out.map((x) => x.trim()).filter(Boolean);
}

/** Blanquea el CONTENIDO de las cadenas, preservando el largo. */
function sinCadenas(s) {
  return s.replace(/(['"`])(?:\\.|(?!\1)[^\\])*\1/g, (m) => m[0] + ' '.repeat(m.length - 2) + m[0]);
}

/** Índice del primer `car` a profundidad 0, o -1. */
function indiceTopLevel(s, car) {
  let prof = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '{' || c === '[' || c === '(') prof++;
    else if (c === '}' || c === ']' || c === ')') prof--;
    else if (c === car && prof === 0) return i;
  }
  return -1;
}

/**
 * ¿Este patrón de objeto tiene `error` como CLAVE de primer nivel?
 *
 * **Se pregunta por la clave, no por la cadena, y esa distinción la pagó una revisión
 * adversarial con cuatro evasiones ejecutadas contra este mismo parser.** La versión anterior
 * hacía `/\berror\s*(:|[,}])/` sobre el TEXTO del patrón, así que daban por buenas:
 *
 *   · `const { data, etiqueta = 'error, ' } = …` — la cadena literal, que ni siquiera es código;
 *   · `const { data, ...error } = …` — un rest que junta todo lo demás en un objeto llamado
 *     `error`, o sea que el error queda dentro de `error.error` y nadie lo mira;
 *   · `const { data, meta: { error } = {} } = …` — un `error` ANIDADO bajo una clave que la
 *     respuesta de supabase-js no tiene: se destructura de un `{}` por defecto, siempre
 *     `undefined`.
 *
 * El fixture `errorPrevio` que ya estaba cubría "una variable cuyo NOMBRE contiene error", que
 * es otra cosa. Acá se blanquean las cadenas, se parte el patrón en sus elementos de primer
 * nivel y se compara la clave de cada uno.
 *
 * Lo que sigue sin poder ver, y va dicho porque es el límite real: `error: _ignorado` con la
 * variable nunca usada. Distinguirlo pide análisis de uso, y la forma es indistinguible del
 * `error: e` idiomático que este repo usa en todos lados.
 */
function nombraError(patron) {
  const t = patron.trim();
  if (!t.startsWith('{') || !t.endsWith('}')) return false;
  return elementosTopLevel(sinCadenas(t.slice(1, -1))).some((e) => {
    if (e.startsWith('...')) return false;
    const dp = indiceTopLevel(e, ':');
    const clave = (dp >= 0 ? e.slice(0, dp) : e.split('=')[0]).trim();
    return clave === 'error';
  });
}

/**
 * ¿Este statement se queda con el error?
 *
 * En un patrón de array —o sea un `Promise.all`— mira **el elemento que le corresponde a ESTA
 * query**, que es lo que `indice` trae.
 *
 * La versión anterior exigía el error de TODOS los elementos, y eso tapaba un agujero abriendo
 * el opuesto: `const [{ data, error }, otros] = await Promise.all([supabase…, calcular()])`
 * salía reportado como mudo porque `otros` no nombra ningún error — o sea el guard gritando
 * sobre código correcto, que es la dirección que enseña a ignorarlo. Con el índice, cada query
 * responde por su propio elemento y las dos cosas quedan cerradas.
 */
function leeElError(lhs, indice = null) {
  if (!lhs || !lhs.includes('{')) return false;   // sin destructuring no hay error que leer
  const t = lhs.trim();
  if (t.startsWith('[')) {
    const elems = elementosTopLevel(t.slice(1, -1));
    if (indice === null) return elems.length > 0 && elems.every(nombraError);
    return indice < elems.length && nombraError(elems[indice]);
  }
  return nombraError(t);
}

/** `{ archivo, lhs, linea }` de todo el perímetro. */
const TODAS = ARCHIVOS.flatMap((rel) =>
  lecturas(readFileSync(path.join(RAIZ, rel), 'utf-8'), rel).map((l) => ({ ...l, archivo: rel })));
const CON_ASIGNACION = TODAS.filter((l) => l.lhs !== null);
const SIN_ASIGNACION = TODAS.filter((l) => l.lhs === null);

describe('el perímetro es el que el cron alcanza', () => {
  /**
   * La derivación tiene que encontrar servicios de verdad. Si alguien cambia la forma del
   * `require` (un alias, un `import`, una constante), `SERVICIOS` queda vacío, `ARCHIVOS` se
   * reduce a `cron/checks.js` y **el guard sale verde habiendo dejado de mirar los servicios**
   * sin que nadie se entere: el modo de falla exacto que esta versión vino a cerrar.
   */
  it('deriva los servicios que el cron llama', () => {
    // El piso va en el conteo REAL (18), no uno por debajo. Con 17 contra 18 reales, perder
    // un servicio derivado entero —lo que pasa si el recorrido falla sobre un archivo y la
    // derivación lo saltea— no cruzaba el umbral, y sólo lo atrapaban los `toContain` de
    // abajo, que nombran cinco de los dieciocho.
    expect(ARCHIVOS.length).toBeGreaterThanOrEqual(18);
    // Los que el backlog nombraba como el trabajo pendiente…
    expect(ARCHIVOS).toContain('services/survey-triggers.js');
    expect(ARCHIVOS).toContain('services/debts.js');
    // …uno de los cuatro que el backlog no listaba (entró limpio, pero entró)…
    expect(ARCHIVOS).toContain('services/spending-alerts.js');
    // …y los dos que sólo aparecen al SEGUNDO salto, que es lo que justifica el cierre
    // transitivo: `summaries.js` los llama y tenían lecturas mudas del resumen semanal.
    expect(ARCHIVOS).toContain('services/transactions.js');
    expect(ARCHIVOS).toContain('services/budget.js');
  });

  /**
   * **El perímetro se ancla en `supabase.from(` literal, así que aliasear el cliente lo vuelve
   * ciego.** Un `const db = supabase` seguido de `db.from('usuarios')` no cae en MUDA ni en
   * SIN_ASIGNACION: desaparece, que es la peor de las tres salidas. Lo encontró una revisión
   * adversarial ejecutándolo contra el parser.
   *
   * En vez de intentar seguir el alias —que pide análisis de flujo y falla en silencio cuando
   * no alcanza— el guard **se niega a adivinar**: si aparece un alias o un acceso computado,
   * rompe el build y manda a extender el parser. Es la misma postura que el compilador de
   * `watchPatterns` con una forma de glob nueva.
   */
  it('nadie aliasea el cliente de supabase dentro del perímetro', () => {
    const sospechosos = [];
    for (const rel of ARCHIVOS) {
      const src = sinComentarios(readFileSync(path.join(RAIZ, rel), 'utf-8'), rel);
      // `= supabase` a secas (no `supabase.from`, no `supabase.rpc`), y `supabase['from']`.
      const alias = /=\s*supabase\s*(?:[;,)\]}]|$)/m.test(src);
      const computado = /\bsupabase\s*\[/.test(src);
      if (alias || computado) sospechosos.push(rel + (alias ? ' (alias)' : ' (acceso computado)'));
    }
    expect(sospechosos, [
      'El parser ancla en `supabase.from(` / `supabase.rpc(` literal.',
      'Un alias o un acceso computado hace que esa lectura DESAPAREZCA del barrido:',
      'no sale como muda ni como escritura, simplemente no existe para el guard.',
      'Si hace falta el alias, extendé `lecturas()` para seguirlo — no lo silencies acá.',
    ].join('\n')).toEqual([]);
  });

  /**
   * Y los archivos tienen que existir y contener queries. Un `archivosDe` que devolviera
   * rutas mal armadas explotaría al leer, pero uno que devolviera sólo el `index.js` de un
   * directorio no: por eso el piso va sobre las lecturas encontradas y hay un caso explícito
   * para el submódulo.
   */
  it('encuentra las lecturas de todo el perímetro', () => {
    // El piso va cerca del conteo real (163 al escribir esto) y no en un número cómodo: con
    // un piso holgado se pueden mover lecturas a un helper no cubierto antes de que este
    // assert se entere, y mover queries a otro archivo es exactamente cómo está escrito medio
    // backend — es lo que creó este trabajo, y lo que la derivación de un solo salto no vio.
    expect(CON_ASIGNACION.length).toBeGreaterThanOrEqual(158);
    expect(ARCHIVOS).toContain('services/survey-triggers.js');
    expect(ARCHIVOS).toContain('services/subscriptions/detector.js');
  });
});

describe('el parser ve lo que dice ver', () => {
  /**
   * Cada fila es una forma que un guard más flojo daría por buena. Se ejecutan contra el
   * MISMO parser que corre sobre los archivos reales.
   */
  const EVASIONES = [
    ['const { data: usuarios } = await supabase.from("usuarios").select("*")', false, 'el bug original'],
    ['const { count } = await supabase.from("t").select("id", { count: "exact" })', false, 'la variante de conteo'],
    ['const r = await supabase.from("t").select("*")', false, 'sin destructuring: el error queda en r y nadie lo mira'],
    ['const { data: u, error: e } = await supabase.from("t").select("*")', true, 'la forma correcta'],
    ['const { data, error } = await supabase.from("t").select("*")', true, 'error suelto, sin renombrar'],
    ['const { data: errorPrevio } = await supabase.from("t").select("*")', false, 'una variable que CONTIENE "error" no es leer el error'],
    ['await supabase.from("t").insert({ a: 1 })', false, 'fire-and-forget: no hay LHS'],
    ['const [{ data: a, error: e }] = await Promise.all([supabase.from("t").select("*")])', true, 'Promise.all: el await esta sobre el all, no sobre la query'],
    ['const [{ data: a }] = await Promise.all([supabase.from("t").select("*")])', false, 'y dentro de un Promise.all tambien se exige el error'],
    // Este fixture NO discriminaba y estuvo a punto de quedarse: con `/* error */` en el
    // LHS, la regex estricta lo rechaza igual porque despues de `error` viene ` *`, no `:`
    // ni `,`. O sea que pasaba por OTRA condicion, y la mutacion "dejar de blanquear
    // comentarios" sobrevivia en verde. El de abajo es el que separa las hipotesis: lleva
    // `error }` adentro del comentario, que SI matchearia la regex sin el blanqueo.
    ['/* devuelve { data, error } */ const { data } = await supabase.from("t").select("*")', false, 'un comentario que menciona `error }` no es leer el error'],
    // Las cuatro de abajo las encontro una revision adversarial EJECUTANDOLAS contra este
    // parser, no leyendolo. Las cuatro pasaban: la regla vieja buscaba la cadena `error` en el
    // TEXTO del patron, y estas cuatro la ponen ahi sin leer ningun error.
    ['const { data, etiqueta = "error, " } = await supabase.from("t").select("*")', false, 'una CADENA que contiene `error,` no es una clave'],
    ['const { data, ...error } = await supabase.from("t").select("*")', false, 'un rest llamado error deja el error en error.error, que nadie mira'],
    ['const { data, meta: { error } = {} } = await supabase.from("t").select("*")', false, 'un error ANIDADO bajo una clave que la respuesta no tiene es siempre undefined'],
    ['const { data, error: e } = await supabase.from("t").select("*")', true, 'renombrar SI cuenta: es la forma idiomatica del repo'],
  ];

  it.each(EVASIONES)('%s → %s (%s)', (codigo, esperado) => {
    const encontrado = lecturas(codigo);
    expect(encontrado.length, 'el parser no vio este statement').toBe(1);
    expect(leeElError(encontrado[0].lhs, encontrado[0].indice)).toBe(esperado);
  });

  /**
   * **El falso positivo que reportaba una línea correcta.** Es la forma literal de
   * `registrarEvento` en `services/survey-triggers.js`: un parámetro por defecto en la firma
   * de la función, sin `;` entre la firma y la query. El parser viejo se quedaba con el primer
   * `=` de la ventana —el del `= null`— y devolvía la firma entera como LHS.
   */
  it('un parámetro por defecto en la firma no es la asignación de la query', () => {
    const real = [
      'async function registrarEvento({ userId, channel, responseData = null }) {',
      "  const { data, error } = await supabase.from('survey_events').insert({ user_id: userId })",
    ].join('\n');
    const [l] = lecturas(real);
    expect(l.lhs, 'el LHS extraído fue la firma de la función, no el destructuring').toBe('{ data, error }');
    expect(leeElError(l.lhs), 'una lectura que SÍ lee su error salió reportada como muda').toBe(true);
    // Y este caso es además el ESPEJO de la regla del balance de llaves: acá la firma abre un
    // bloque, pero el `=` elegido es el del destructuring, que ya está adentro. Balance 0, o
    // sea que la regla nueva no puede volver escritura a esta lectura.
  });

  /**
   * **El `;` que se comía el blanqueador.** Forma literal de `handlers/webhook.js:827-830`: una
   * cadena de copy que termina en un link, y en la línea siguiente una escritura sin asignar.
   * Con el blanqueo por regex, el `//` de `https://` borraba el resto de la línea —el `;`
   * incluido— y la escritura heredaba el `respuesta =` de arriba.
   */
  it('un `https://` dentro de una cadena no se come el `;` del statement', () => {
    const real = [
      "        respuesta = '📊 Revisa tu dashboard en *https://app.neto.pe*';",
      "      await supabase.from('usuarios').update({ recordatorios_activos: false }).eq('id', usuario.id);",
    ].join('\n');
    const [l] = lecturas(real);
    expect(l.lhs, 'el blanqueo se comió el `;` y la escritura heredó el LHS de la línea de arriba').toBe(null);
  });

  /**
   * **CONTROL, no aserción**, y va dicho porque no se distingue de un guard mirándolo: este
   * caso pasa con el arreglo puesto y también con el arreglo revertido — no lo mata ninguna
   * mutación. Existe para mostrar que el par de fixtures difiere en UNA cosa (el link), o sea
   * que el de arriba falla por el `//` y no por otra diferencia. Sin él, el de arriba podría
   * estar rechazando por cualquier motivo.
   */
  it('CONTROL: la misma forma sin el link ya daba escritura', () => {
    const real = [
      "        respuesta = '📊 Revisa tu dashboard';",
      "      await supabase.from('usuarios').update({ recordatorios_activos: false }).eq('id', usuario.id);",
    ].join('\n');
    expect(lecturas(real)[0].lhs).toBe(null);
  });

  /**
   * **El `=` de otro bloque, en sus dos formas vivas.** Las dos son ESCRITURAS que salían
   * reportadas como lecturas mudas, o sea el guard en rojo sobre código correcto.
   */
  it('una query en el cuerpo de una arrow no hereda el LHS de la arrow', () => {
    const real = [
      '        const marcarVerificado = async () => {',
      "          await supabase.from('webapp_otp').update({ verified_at: hoy }).eq('id', otp.id);",
      '        };',
    ].join('\n');
    const [l] = lecturas(real);
    expect(l.lhs, 'la escritura salió como lectura muda con LHS `marcarVerificado`').toBe(null);
  });

  it('un parámetro por defecto no es la asignación cuando la query NO asigna nada', () => {
    const real = [
      'async function registrarError(tag, mensaje, opts = {}) {',
      '  try {',
      "    await supabase.from('errores').insert({ tag });",
    ].join('\n');
    const [l] = lecturas(real);
    expect(l.lhs, 'la firma de la función salió como LHS de una escritura').toBe(null);
  });

  /**
   * **Las formas de regex que desincronizaban el recorrido.** Las encontró una revisión
   * adversarial ejecutándolas, y la segunda es la que enseña: con un número PAR de comillas
   * espurias el scanner **no tira** —se emparejan entre sí— y envenena en silencio todo lo
   * que hay en el medio. Ahí la query comentada RESUCITA, que es la peor dirección posible:
   * el guard señalando una línea que nadie ejecuta.
   */
  it('un literal de regex con comilla no abre una cadena', () => {
    const real = [
      "const limpio = valor.replace(/['\"]/g, '');",
      "const u = 'https://app.neto.pe';",
      "const { data } = await supabase.from('t').select('*');",
    ].join('\n');
    const encontradas = lecturas(real);
    expect(encontradas.length, 'la query desapareció del barrido').toBe(1);
    expect(leeElError(encontradas[0].lhs)).toBe(false);
  });

  it('dos regex con comilla no se emparejan entre sí y no resucitan código comentado', () => {
    const real = [
      'const a = s.replace(/"/g, "");',
      "// const { data } = await supabase.from('fantasma').select('*')",
      'const b = s.replace(/"/g, "");',
    ].join('\n');
    expect(lecturas(real), 'una query COMENTADA entró al barrido').toEqual([]);
  });

  it('una división no se confunde con un literal de regex', () => {
    const real = [
      'const pct = (a) / (b) / 2;',
      "const { data } = await supabase.from('t').select('*');",
    ].join('\n');
    expect(lecturas(real).length).toBe(1);
  });

  /**
   * **La asimetría comentario-sí / cadena-no.** El mismo texto dentro de un comentario se
   * blanqueaba desde siempre; dentro de una cadena, no. Así una escritura fire-and-forget
   * conseguía un LHS prestado que lee el error, o sea una EXENCIÓN — la peor de las tres
   * salidas. Lo encontró una revisión adversarial.
   */
  it('un LHS que vive dentro de una cadena no exime a la escritura de al lado', () => {
    // **Sin `;` a propósito, y la primera versión de este caso los llevaba y era VACUA**: con
    // el `;` el statement se corta ahí igual, así que pasaba con el arreglo y sin él. La
    // evasión necesita que no haya frontera, que es cuando el backtrack entra en la cadena.
    const real = [
      "const plantilla = 'const { data, error } = await supabase'",
      "await supabase.from('t').insert({ a: 1 })",
    ].join('\n');
    const [l] = lecturas(real);
    // **Lo que se exige es que no sea una EXENCIÓN, no que quede perfecta.** Sin el blanqueo
    // el LHS que se roba de la cadena es `{ data, error }`, o sea que la escritura sale
    // reportada como una lectura que SÍ lee su error: desaparece de las dos listas y el
    // build queda verde. Con el blanqueo queda `plantilla`, que sigue sin ser exacto —es una
    // escritura, no una lectura— pero cae en MUDA y rompe el build. De los tres destinos, el
    // único inaceptable es el que no rompe nada.
    expect(leeElError(l.lhs, l.indice), 'la cadena le prestó un LHS que lee el error: exención').toBe(false);
  });

  it('un `;` dentro de una cadena no corta el statement', () => {
    const real = "const { data, error } = await Promise.all([registrar('paso;1'), supabase.from('t').select('*')])";
    const [l] = lecturas(real);
    expect(l.lhs, 'el `;` de la cadena cortó el statement y perdió el LHS').not.toBe(null);
  });

  it('una llave suelta dentro de una cadena no dispara la regla de bloque', () => {
    const real = "const { data, error } = (avisar('formato {'), await supabase.from('t').select('*'));";
    const [l] = lecturas(real);
    expect(leeElError(l.lhs), 'una llave de TEXTO volvió escritura a una lectura correcta').toBe(true);
  });

  /**
   * El tripwire, sobre TODO el árbol de runtime y no sólo sobre el perímetro. Va más ancho a
   * propósito: los dos throws del recorrido ya corren sobre el perímetro al construir
   * `TODAS`, así que un caso ahí revienta antes de llegar acá — este `it` sería código
   * muerto. Lo que cubre de verdad son los archivos que el perímetro **todavía no incluye** y
   * que un `require` nuevo puede meter mañana: es donde vivían los 24 archivos con
   * `/['"]/` que rompían la primera versión del scanner.
   */
  it('el recorrido no se desincroniza en ningún archivo del árbol de runtime', () => {
    const js = (dir, out = []) => {
      let entradas;
      try { entradas = readdirSync(path.join(RAIZ, dir)); } catch { return out; }
      for (const f of entradas) {
        const rel = dir + '/' + f;
        if (statSync(path.join(RAIZ, rel)).isDirectory()) js(rel, out);
        else if (f.endsWith('.js')) out.push(rel);
      }
      return out;
    };
    const archivos = ['cron', 'services', 'handlers', 'lib', 'helpers', 'routes'].flatMap((d) => js(d));
    expect(archivos.length, 'el barrido no encontró archivos: dejó de mirar').toBeGreaterThan(60);
    const rotos = [];
    for (const rel of archivos) {
      const raw = readFileSync(path.join(RAIZ, rel), 'utf-8');
      try {
        expect(sinComentarios(raw, rel).length).toBe(raw.length);
        expect(sinLiterales(raw, rel).length).toBe(raw.length);
      } catch (e) { rotos.push(rel + ': ' + e.message); }
    }
    expect(rotos, 'el scanner perdió el hilo en estos archivos').toEqual([]);
  });

  /**
   * El espejo del anterior, y hace falta su propio caso: que el parser tome el último `=` no
   * puede volverlo indulgente. Acá el `error:` está en una variable ajena de la línea de
   * arriba, no en el LHS de la query.
   */
  it('un `error:` de la línea de arriba no cuenta como leer el error de esta query', () => {
    const evasion = [
      'const opciones = { error: true }',
      "  const { data } = await supabase.from('t').select('*')",
    ].join('\n');
    const [l] = lecturas(evasion);
    expect(l.lhs, 'el LHS arrastró la línea anterior').toBe('{ data }');
    expect(leeElError(l.lhs), 'un `error:` ajeno alcanzó para dar la lectura por buena').toBe(false);
  });

  /**
   * La ventana truncada convertía una lectura en una exención. Este fixture reproduce el
   * `Promise.all` largo de `recommendations.js`: la última query cae a más de 600 caracteres
   * del `=`, que era el tope de la ventana anterior.
   */
  it('un Promise.all largo no se le escapa a la ventana', () => {
    const relleno = ".eq('usuario_id', usuarioId).eq('tipo', 'gasto').gte('fecha', desde).lte('fecha', hasta).order('fecha', { ascending: false })";
    const largo = 'const [{ data: a, error: ea }, { data: b, error: eb }] = await Promise.all([\n'
      + `  supabase.from('transacciones').select('*')${relleno},\n`.repeat(4)
      + `  supabase.from('presupuestos').select('*')${relleno},\n])`;
    const encontradas = lecturas(largo);
    expect(encontradas.length).toBe(5);
    expect(encontradas.filter((l) => l.lhs === null),
      'una query quedó fuera de la ventana y se contó como escritura fire-and-forget').toEqual([]);
  });

  /**
   * Y el patrón de array se exige elemento por elemento. Sin esto, el error de la primera
   * query tapa a todas las demás del mismo `Promise.all`.
   */
  it('en un Promise.all cada query responde por SU elemento', () => {
    const mixto = 'const [{ data: a, error: e }, { data: b }] = await Promise.all([supabase.from("t").select("*"), supabase.from("u").select("*")])';
    const [primera, segunda] = lecturas(mixto);
    expect(primera.indice).toBe(0);
    expect(segunda.indice).toBe(1);
    expect(leeElError(primera.lhs, primera.indice), 'la query que SI lee su error salio reportada como muda').toBe(true);
    expect(leeElError(segunda.lhs, segunda.indice), 'el error de la primera query dio por buena a la segunda').toBe(false);
  });

  /**
   * Y el espejo, que es el falso positivo que abrio la version anterior: un `Promise.all` que
   * mezcla una query con cualquier otra promesa. Exigirle el error a TODOS los elementos
   * reportaba como muda una lectura correcta, solo porque el vecino no es una query.
   */
  it('un Promise.all que mezcla una query con otra promesa no reporta la query', () => {
    const mezcla = 'const [{ data, error }, otros] = await Promise.all([supabase.from("t").select("*"), calcular()])';
    const [l] = lecturas(mezcla);
    expect(leeElError(l.lhs, l.indice), 'el vecino que no es una query hizo caer a la que si lo es').toBe(true);
  });

  /**
   * El patrón builder, en sus DOS direcciones. Un solo caso no alcanza: con sólo el positivo,
   * un `lhsDelAwait` que devolviera siempre `'{ data, error }'` pasaría; con sólo el negativo,
   * pasaría uno que no resolviera nada. Las dos formas existen hoy dentro del perímetro
   * (`debts.js` lee su error, `metas.js` no lo leía).
   */
  it('el builder que lee su error en el `await` no es una lectura muda', () => {
    const builder = [
      "let q = supabase.from('deudas').select('*').eq('usuario_id', usuarioId);",
      "if (soloActivas) q = q.eq('estado', 'activa');",
      'const { data, error } = await q;',
    ].join('\n');
    const [l] = lecturas(builder);
    expect(leeElError(l.lhs), 'una lectura que ya leía su error salió reportada como muda').toBe(true);
  });

  it('y el builder que NO lo lee sigue siendo muda', () => {
    const builder = [
      "let q = supabase.from('metas_ahorro').select('*').eq('usuario_id', usuarioId);",
      "if (soloActivas) q = q.eq('completada', false);",
      'const { data } = await q;',
    ].join('\n');
    const [l] = lecturas(builder);
    expect(leeElError(l.lhs), 'el builder se volvió una exención: cualquier `await` lo daba por bueno').toBe(false);
  });

  /**
   * El otro efecto de blanquear comentarios, y hace falta su propio caso: un
   * `supabase.from(` COMENTADO no es código. Sin el blanqueo, el ejemplo de un docblock
   * entra a la lista de lecturas y el guard reporta una línea que nadie ejecuta — que es la
   * dirección de error que enseña a ignorarlo.
   */
  /**
   * El resultado entero en una variable y el error leido despues como `res.error`. La regla
   * general sigue siendo que un LHS sin destructuring es mudo —`const r = await …` deja el
   * error en `r` y nadie lo mira— pero eso vale hasta que ALGUIEN lo mire. Sin este caso, un
   * manejo perfectamente correcto salia reportado en rojo.
   */
  it('el error leido como propiedad despues del await tambien cuenta', () => {
    const forma = [
      "const res = await supabase.from('t').select('*');",
      'if (res.error) throw res.error;',
    ].join('\n');
    const [l] = lecturas(forma);
    expect(leeElError(l.lhs, l.indice), 'un manejo correcto salio reportado como mudo').toBe(true);
  });

  /** Y el negativo: la variable existe y nadie mira su `.error`. */
  it('pero si nadie mira su .error, sigue siendo muda', () => {
    const forma = [
      "const res = await supabase.from('t').select('*');",
      'return res.data || [];',
    ].join('\n');
    const [l] = lecturas(forma);
    expect(leeElError(l.lhs, l.indice)).toBe(false);
  });

  it('un await comentado no cuenta como lectura', () => {
    expect(lecturas('// const { data } = await supabase.from("t").select("*")')).toEqual([]);
    expect(lecturas('/* const { data } = await supabase.from("t") */')).toEqual([]);
  });

  /**
   * **La evasión que rompió un parser anterior.** Retrocedía hasta el último `const` de los
   * 400 caracteres previos, cruzando statements, así que una REASIGNACIÓN a una variable ya
   * declarada heredaba el LHS del destructuring de arriba.
   */
  it('una reasignación no hereda el LHS del statement anterior', () => {
    const evasion = [
      "const { data: a, error: e } = await supabase.from('x').select('*');",
      "      yaAviso = await supabase.from('notificaciones').select('id');",
    ].join('\n');
    const [primera, segunda] = lecturas(evasion);
    expect(leeElError(primera.lhs), 'la lectura correcta dejó de reconocerse').toBe(true);
    expect(leeElError(segunda.lhs), 'la reasignación heredó el error de la línea de arriba').toBe(false);
  });

  /**
   * Una flecha no es una asignación. La distinción `(?!=|>)` no evita una EVASIÓN sino un
   * falso positivo: sin ella, un `ids.forEach((id) => supabase.from(...))` se reportaría como
   * lectura muda con LHS `ids.forEach((id) `, y un guard que grita por lo que no es se
   * termina ignorando — que es la falla más cara de las dos.
   */
  it('una flecha no es una asignación', () => {
    const [l] = lecturas('ids.forEach((id) => supabase.from("t").delete());');
    expect(l.lhs, 'el `=>` se leyó como asignación: la query saldría reportada como muda').toBe(null);
  });

  it('ve el LHS aunque el await esté en otra línea', () => {
    const partido = 'const { data: u } =\n  await supabase.from("t")\n    .select("*")';
    const [l] = lecturas(partido);
    expect(l).toBeDefined();
    expect(leeElError(l.lhs)).toBe(false);
  });

  /**
   * El espejo del anterior: el parser tiene que reconocer la forma BUENA partida en dos
   * líneas. Sin este caso, un parser roto que devolviera `lhs: null` para todo pasaría el
   * test de arriba (nada lee el error) y dejaría la lista de mudas vacía por vacuidad.
   */
  it('y reconoce la forma correcta partida en dos líneas', () => {
    const partido = 'const { data: u, error: e } =\n  await supabase.from("t")\n    .select("*")';
    const [l] = lecturas(partido);
    expect(leeElError(l.lhs)).toBe(true);
  });
});

describe('toda lectura del perímetro lee su error', () => {
  /** `{ archivo: [líneas mudas] }`, sobre TODO el perímetro. */
  const MUDAS_POR_ARCHIVO = {};
  for (const l of CON_ASIGNACION.filter((x) => !leeElError(x.lhs, x.indice))) {
    (MUDAS_POR_ARCHIVO[l.archivo] || (MUDAS_POR_ARCHIVO[l.archivo] = [])).push(l.linea);
  }

  it('ninguna descarta el { error }', () => {
    const mudas = CON_ASIGNACION
      .filter((l) => !leeElError(l.lhs, l.indice) && !(l.archivo in PENDIENTES))
      .map((l) => l.archivo + ':' + l.linea + '  ' + l.lhs.slice(-70));

    expect(mudas, [
      'Estas lecturas descartan el { error } de supabase-js, que NO lanza.',
      'Sin leerlo, una caída de la base se lee igual que "no hay a quién avisar".',
      'Antes de agregar el guard, decidí QUÉ decide esta lectura:',
      '  · dedup / anti-fatiga → falla ABIERTO: un error reenvía. `if (err) { log; continue; }`',
      '  · población de destinatarios → `if (err) { log; return; }`',
      '  · decisión por usuario dentro del loop → `throw err` (el catch de abajo ya loguea)',
      '  · accesoria (un null degrada, no decide) → SÓLO log. Un continue de más apaga el cron.',
      'Y agregá el caso al funcional que corresponda (lecturas-con-error.test.js para el cron,',
      'lecturas-servicios-con-error.test.js para los servicios): la forma sola no prueba nada.',
    ].join('\n')).toEqual([]);
  });

  /**
   * Las escrituras sin asignación son OTRA clase: no deciden a quién se le avisa, así que no
   * producen el silencio que este archivo persigue. Lo que sí hacen es perder un ledger sin
   * decirlo — y cuando ese ledger es el que después se LEE para no repetir, la escritura muda
   * es un dedup roto con otro disfraz. Las cuatro de `cron/checks.js` que estaban en esta
   * lista (`survey_events` de inactividad, `activacion_nudge_at`, `recordatorios_enviados` y
   * `last_reminder_sent_at`) se cerraron por eso.
   *
   * Hoy no queda ninguna: las seis que había en `cron/checks.js`, las dos de `metas.js` y la
   * de `shared-spaces.js` se cerraron. Cuatro eran dedups disfrazados, una escribía al dueño
   * de un espacio compartido, y las cuatro restantes son accesorias de verdad y ahora loguean.
   * Que el número sea cero es lo que hace útil este assert: la próxima escritura muda que
   * entre al perímetro obliga a decidir su clase, en vez de sumarse a una excepción que nadie
   * eligió.
   */
  it('no queda ninguna escritura sin asignación (una nueva pide una decisión, no un default)', () => {
    const detalle = SIN_ASIGNACION
      .filter((l) => !(l.archivo in PENDIENTES_ESCRITURAS))
      .map((l) => l.archivo + ':' + l.linea);
    expect(detalle, 'líneas: ' + detalle.join(', ')).toEqual([]);
  });

  /**
   * El trinquete de los tres archivos que entraron con el cierre transitivo. Dos aserciones,
   * y las dos hacen falta:
   *
   *   · el conteo **no puede subir** — una lectura muda nueva ahí rompe igual que en el resto;
   *   · y **no puede bajar sin sacar la entrada**, porque una fila obsoleta con un número
   *     inflado le devuelve a ese archivo el permiso de sumar mudas en silencio. Es la forma
   *     que tiene una exención de sobrevivir al problema que la justificaba.
   */
  it.each(Object.keys(PENDIENTES))('el pendiente de %s sólo puede achicarse', (archivo) => {
    const hay = (MUDAS_POR_ARCHIVO[archivo] || []).length;
    expect(hay, 'líneas: ' + (MUDAS_POR_ARCHIVO[archivo] || []).join(', '))
      .toBeLessThanOrEqual(PENDIENTES[archivo]);
    expect(hay, `bajaron a ${hay}: actualizá PENDIENTES (y si es 0, sacá la entrada)`)
      .toBe(PENDIENTES[archivo]);
  });

  /** La misma tenaza, para la mitad de escrituras. */
  it.each(Object.keys(PENDIENTES_ESCRITURAS))('las escrituras pendientes de %s sólo pueden achicarse', (archivo) => {
    const lineas = SIN_ASIGNACION.filter((l) => l.archivo === archivo).map((l) => l.linea);
    expect(lineas.length, 'líneas: ' + lineas.join(', ')).toBeLessThanOrEqual(PENDIENTES_ESCRITURAS[archivo]);
    expect(lineas.length, `bajaron a ${lineas.length}: actualizá PENDIENTES_ESCRITURAS (y si es 0, sacá la entrada)`)
      .toBe(PENDIENTES_ESCRITURAS[archivo]);
  });

  /** Y un archivo que ya no tiene nada pendiente no puede quedarse en ninguna de las dos listas. */
  it('ningún pendiente está en cero', () => {
    const enCero = [
      ...Object.keys(PENDIENTES).filter((a) => PENDIENTES[a] === 0),
      ...Object.keys(PENDIENTES_ESCRITURAS).filter((a) => PENDIENTES_ESCRITURAS[a] === 0),
    ];
    expect(enCero, 'ya se barrieron: sacalos de la lista que corresponda').toEqual([]);
  });
});
