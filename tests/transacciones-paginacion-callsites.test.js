import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, posix } from 'node:path';
import ts from 'typescript';

/**
 * NINGUNA LECTURA DE `transacciones` DEL BACKEND PUEDE CORTARSE EN 1000 SIN DECIRLO.
 *
 * PostgREST corta cada respuesta en `max_rows` (1000 en este proyecto) y no avisa. El 01-oct-2026
 * el usuario real más grande tenía ~1105 transacciones y ~814 en una ventana de seis meses. La
 * webapp se barrió ese día (58534b9, 64a304a) con `webapp/src/lib/supabase/todas-las-filas.ts` y
 * su guard `webapp/src/lib/transacciones-paginacion-callsites.test.ts`. Este es el mismo guard para
 * el backend, y el paginador es `lib/todas-las-filas.js`, su espejo CommonJS.
 *
 * **Es un port, no una versión nueva, y eso es a propósito.** El de la webapp pasó cuatro rondas
 * de ataque adversarial; su docblock explica por qué seguir el builder por variables NO funciona
 * (13 y 7 evasiones en dos revisiones seguidas) y por qué falla cerrado. Usa el mismo parser
 * (`typescript`, devDependency de la raíz solo para esto: el CI del backend no instala la webapp).
 * Mira la cadena que nace en `.from('transacciones')` y acepta tres cosas:
 *
 * 1. **Una cota que nada posterior puede deshacer**: `.single()`, `.maybeSingle()`,
 *    `.eq('id', …)`, `.in('id', …)` o `head: true` en un `select` con opciones literales limpias.
 * 2. **La página de `todasLasFilas`, con UNA forma**: termina en `.range(desde, hasta)` con los
 *    parámetros de la página, sin `.limit`; sus `.order` llevan a lo sumo `{ ascending }` y el
 *    último es por `id`; el `select` trae `id` o `*` entre sus columnas PROPIAS; pide
 *    `count: 'exact'`; y la clave es exactamente `(t) => t.id`.
 * 3. **`.limit(1)`, o un TOP-N DECLARADO en `TOP_N`**, como ÚLTIMO limitador de una cadena
 *    CERRADA (se ejecuta ahí mismo): `await` directo (también a través de un ternario), elemento de
 *    un `Promise.all([...])`, retorno de una función `async`, o un `.then(...)`. El top-N tiene que
 *    resolverse a <= `TOPE_TOP_N` (100): `.limit(n)` con `n` literal, `const` del ámbito con
 *    aritmética, o `Math.min` con algún argumento chico, o un `.range` de ancho resuelto.
 *
 *    **Acá el backend es más estricto que la webapp, y lo decidieron dos ataques que encontraron la
 *    MISMA clase.** La webapp acepta cualquier límite hasta 1000: pasaba `.limit(TAMANO_PAGINA)`
 *    sobre una SUMA y un loop a mano de `range(desde, desde + 999)`. Con el tope en 100, la ronda
 *    siguiente pasó `.limit(100)` sobre una suma mensual (el usuario más grande ya hace ~135 por
 *    mes) y el mismo loop de a 100. Mover el número no cierra nada: ningún tope sintáctico separa
 *    "las 5 últimas" de "sumá el mes". Lo separa quien lo escribe, así que cada top-N va a `TOP_N`
 *    con su motivo y anclado a su texto. Lo que suma va por la página de `todasLasFilas`. El límite
 *    honesto: un humano puede declarar mal un top-N; lo que ya no puede es hacerlo sin escribirlo.
 *
 * Todo lo demás es rojo: un builder que sale a una variable, un argumento, una propiedad o un
 * `exports.x`, aunque lleve un `.limit(10)` perfecto. Si de verdad está bien, se cierra en el lugar
 * o va a EXENCIONES con una premisa verificable.
 *
 * **Lo que cambia respecto de la webapp, todo por CommonJS:**
 * - `todasLasFilas` se reconoce por un `const { … } = require(X)` (o `const ns = require(X)` y
 *   `ns.todasLasFilas`, o `const { … } = ns`) en el TOPE del archivo, donde X **resuelto desde el
 *   archivo** es `lib/todas-las-filas` (una copia con el mismo nombre en otra carpeta no cuenta), y
 *   además el nombre tiene que estar ligado UNA sola vez en todo el archivo. En CJS un `require`
 *   puede aparecer en cualquier ámbito y `var` se iza, así que en vez de seguir ámbitos (la trampa
 *   que la webapp ya pagó) cualquier otra ligadura del mismo nombre es rojo. El módulo exporta un
 *   objeto congelado, así que tampoco se le puede pisar la propiedad.
 * - **`import` ESM NO se reconoce**: un `.mjs` que importa el CJS congelado no recibe exports con
 *   nombre (medido en Node 24: `ns.TAMANO_PAGINA` es `undefined` y `.limit(undefined)` viaja como
 *   `limit=undefined`). Un `.mjs` lo trae con `createRequire`.
 * - No hay excepción para `queryFn`: el backend no usa React Query, y aceptar un retorno no-async
 *   por el NOMBRE de una propiedad era una puerta sin ningún uso acá.
 * - En la página, un spread de PostgREST (`...categorias(id, nombre)`) es rojo: aplana sus columnas
 *   en la fila, su `id` pisa el propio y la clave `t.id` colapsaría una categoría entera a una fila.
 *
 * Cuatro rondas de ataque sobre el port (01-oct-2026, fixtures `(E*)`, `(A*)`, `(R3)`, `(R4)` y
 * `docs/DEFECTOS.md`). La cuarta no encontró evasión en la declaración de TOP_N; sí el embebido de
 * `transacciones` desde otra tabla (PostgREST le aplica `max_rows` a cada nodo), que ahora es rojo.
 *
 * Lo que NO ve, declarado: `.in('id', lista)` no mira el largo de la lista; `.rpc()`, un `fetch`
 * directo a `/rest/v1/transacciones` y las vistas quedan fuera; un wrapper propio de
 * `todasLasFilas` es rojo; `.from` por `.bind`/`.call` tampoco se ve; y un humano puede declarar
 * en TOP_N una lectura que en realidad suma. `qa-e2e/` y `tests/` están fuera del barrido (no
 * corren en el servidor); `scripts/` está DENTRO, y entra todo archivo que no sea de un formato
 * conocido de no-código si nombra la tabla o llama `.from(`.
 *
 * Falsos positivos conocidos, a propósito (fallar cerrado cuesta escribir de una forma): una página
 * con filtros condicionales (`let q`), columnas en una constante, `{}` en vez de `undefined` en el
 * conteo, `.throwOnError()`/`.abortSignal()` después del `.range`, la clave `({ id }) => id`, y
 * `Promise.race` o un `.map` no async dentro de `Promise.all`.
 */

const TABLAS = new Set(['transacciones']);
// Literales a propósito, NO la constante del helper: si alguien sube `TAMANO_PAGINA` a 5000 "para
// hacer menos viajes", el helper sigue bien (avanza por lo recibido) pero un guard atado a esa
// constante pasaría a aceptar `.limit(5000)`, que PostgREST corta en 1000.
const MAX_ROWS = 1000; // el `max_rows` de PostgREST en este proyecto (medido: content-range 0-999/3535)
const TOPE_TOP_N = 100;
const MODULO = 'lib/todas-las-filas';
/**
 * `{ count: 'exact' }` o `cond ? { count: 'exact' } : undefined`, leído del AST. Por texto sin
 * espacios, `count: ' exact'` pasaba como `'exact'` y viajaba como `Prefer: count= exact` (sin
 * conteo): el helper caía a la regla débil sin avisar.
 */
function esConteoDePagina(e) {
  if (!e) return false;
  const n = pelar(e);
  const exacto = (o) => {
    const m = opciones(o && pelar(o));
    return m instanceof Map && m.size === 1 && literalTexto(m.get('count')) === 'exact';
  };
  if (ts.isConditionalExpression(n)) return ts.isIdentifier(pelar(n.condition)) && exacto(n.whenTrue) && ts.isIdentifier(pelar(n.whenFalse)) && pelar(n.whenFalse).text === 'undefined';
  return exacto(n);
}
const TOPN_SIN_DECLARAR = 'un .limit/.range de top-N sin declarar en TOP_N: si la respuesta SUMA o CUENTA estas filas, va por todasLasFilas';

/**
 * Lecturas que el guard no puede probar acotadas y están bien por otra razón. Cada una se ancla al
 * TEXTO de la cadena (sin espacios) y a una premisa que se verifica contra el archivo: si cambia la
 * consulta la exención deja de calzar, y si cambia la premisa el test de abajo falla.
 */
const EXENCIONES = [
  {
    archivo: 'handlers/intents/transacciones.js',
    consulta: "supabase.from('transacciones').select('*').eq('usuario_id',usuario.id)",
    motivo:
      '`qElim` arma con filtros condicionales los CANDIDATOS a eliminar (no un agregado) y termina en ' +
      '`.limit(20)` justo antes del único `await`: las ocho apariciones de `qElim` son esas cinco líneas',
    premisa: (c) =>
      (c.match(/\bqElim\b/g) ?? []).length === 8 &&
      /qElim = qElim\.order\('created_at', \{ ascending: false \}\)\.limit\(20\);\r?\n\s*const \{ data: candidatosElim \} = await qElim;/.test(c),
  },
  {
    archivo: 'cron/checks.js',
    consulta: "supabase.from(tabla).select('usuario_id')",
    motivo:
      '`existe(tabla, filtrar)` pregunta si hay UNA fila: el `.limit(1)` va después de `filtrar` y ' +
      'postgrest-js aplica el último limitador; los que la llaman solo agregan `.eq`',
    premisa: (c) =>
      c.includes("const { data, error } = await filtrar(supabase.from(tabla).select('usuario_id')).limit(1);") &&
      (c.match(/\bexiste\(/g) ?? []).length === (c.match(/\bexiste\('\w+', \(q\) => q\.eq\(/g) ?? []).length,
  },
  ...['supabase.from(t.table).select(`${t.pk},${t.col}`)', 'supabase.from(p.table).select(`${p.col}`).eq(p.pk,p.id).single()'].map((consulta) => ({
    archivo: 'scripts/backfill-encrypt-tokens.js',
    consulta,
    motivo: 'recorre TARGETS, que son `usuarios` y `gmail_cuentas` (tokens de Gmail): ninguna es transacciones',
    // Cada `table:` del archivo es uno de esos dos LITERALES: una constante importada cumpliría
    // un `!includes('transacciones')` sin probar nada.
    premisa: (c) => {
      const tablas = [...c.matchAll(/['"`]?\btable['"`]?\s*:\s*([^,}\s]+)/g)].map((m) => m[1]);
      return /const TARGETS = \[/.test(c) && tablas.length >= 2 && tablas.every((t) => t === "'usuarios'" || t === "'gmail_cuentas'");
    },
  })),
];

/**
 * LOS TOP-N, DECLARADOS UNO POR UNO. Dos rondas de ataque seguidas encontraron la misma clase: un
 * tope chico usado como si fuera la lista entera (`.limit(1000)` sobre una suma; después, con el
 * tope en 100, `.limit(100)` sobre una suma mensual, que ya corta al usuario más grande, ~135 por
 * mes). Ningún tope sintáctico separa "las 5 últimas" de "sumá el mes": lo separa quien lo escribe.
 * Por eso fuera de `todasLasFilas` solo `.limit(1)` pasa solo, y todo otro `.limit`/`.range` <= 100
 * tiene que estar acá, anclado al texto ENTERO de su cadena (sin espacios) y con el motivo de por qué
 * mostrar N filas es lo que la respuesta necesita. Una consulta que cambia deja de calzar y vuelve a
 * rojo, y una entrada que ya no calza con UNA lectura también es roja.
 */
const TOP_N = [
  { archivo: 'services/transactions.js', consulta: "supabase.from('transacciones').select('*').eq('usuario_id',usuarioId).ilike('comercio','%'+comercio+'%').order('fecha',{ascending:false}).limit(10)", motivo: 'candidatos a corregir: elige UNO de los 10 más recientes de ese comercio' },
  { archivo: 'services/transactions.js', consulta: "supabase.from('transacciones').select('*').eq('usuario_id',usuarioId).ilike('comercio','%'+comercio+'%').order('created_at',{ascending:false}).limit(5)", motivo: 'candidatos a recategorizar: usa la más reciente (`txs[0]`)' },
  { archivo: 'services/transactions.js', consulta: "supabase.from('transacciones').select('*').eq('usuario_id',usuarioId).ilike('comercio','%'+palabra+'%').order('created_at',{ascending:false}).limit(5)", motivo: 'el mismo reintento palabra por palabra: usa la más reciente' },
  { archivo: 'services/transactions.js', consulta: "supabase.from('transacciones').select('id,tarjeta_last4').eq('usuario_id',usuarioId).eq('dedup_hash',dedupHash).gte('created_at',ventanaInicio).limit(5)", motivo: 'dedup: busca UN duplicado del mismo hash en los últimos 10 segundos' },
  { archivo: 'handlers/intents/analytics.js', consulta: "supabase.from('transacciones').select('*').eq('usuario_id',usuario.id).gte('updated_at',hoyStr+'T00:00:00').order('updated_at',{ascending:false}).limit(10)", motivo: 'historial de cambios: lista las 10 últimas y lo dice ("Mostrando las últimas N"), no suma' },
];

// ─── El analizador ───────────────────────────────────────────────────────────────────────────

const ESCRITURAS = new Set(['insert', 'upsert', 'update', 'delete']);
const EMBEBE_TRANSACCIONES = /(^|[\s,(:])transacciones(![\w]+)?\s*\(/;
const NO_SUPABASE = /^(Array|Buffer|Object|Set|Map|String|Uint8Array|Int\w*Array|Float\w*Array|BigInt\w*Array)$/;

const envoltorio = (n) => ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isNonNullExpression(n) ||
  ts.isSatisfiesExpression(n) || ts.isTypeAssertionExpression(n);

/** Saca paréntesis (y aserciones, si las hubiera) de encima de una expresión. */
function pelar(n) {
  while (envoltorio(n)) n = n.expression;
  return n;
}

/** El padre de `n` saltando paréntesis. */
const subir = (n) => {
  let p = n.parent;
  while (p && envoltorio(p)) p = p.parent;
  return p;
};

/** El nombre del método si `n` es `x.m` o `x['m']`. */
function nombreMetodo(n) {
  if (ts.isPropertyAccessExpression(n)) return n.name.text;
  if (ts.isElementAccessExpression(n) && ts.isStringLiteralLike(n.argumentExpression)) return n.argumentExpression.text;
  return null;
}

/** Sube por `.metodo(...)` encadenados desde `inicio`: la expresión más externa y las llamadas. */
function cadena(inicio) {
  const llamadas = [];
  let actual = inicio;
  for (;;) {
    const acc = actual.parent;
    const metodo = acc && (ts.isPropertyAccessExpression(acc) || ts.isElementAccessExpression(acc)) && acc.expression === actual ? nombreMetodo(acc) : null;
    if (metodo && acc.parent && ts.isCallExpression(acc.parent) && acc.parent.expression === acc) {
      llamadas.push({ metodo, nodo: acc.parent });
      actual = acc.parent;
      continue;
    }
    return { externo: actual, llamadas };
  }
}

const literalTexto = (n) => (n && ts.isStringLiteralLike(n) ? n.text : null);

/** Los nombres que liga un parámetro o una declaración, desestructuración incluida. */
function nombresLigados(b) {
  if (ts.isIdentifier(b)) return [b.text];
  return b.elements.flatMap((e) => (ts.isOmittedExpression(e) ? [] : nombresLigados(e.name)));
}

/**
 * Las opciones de un `.limit`/`.range`/`.order`/`.select`, leídas sólo si son un objeto literal
 * LIMPIO: claves identificador, sin spread. `'sucio'` si vienen de otra forma; `null` si no hay.
 */
function opciones(n) {
  if (!n) return null;
  if (!ts.isObjectLiteralExpression(n)) return 'sucio';
  const m = new Map();
  for (const p of n.properties) {
    if (!ts.isPropertyAssignment(p) || !ts.isIdentifier(p.name)) return 'sucio';
    m.set(p.name.text, p.initializer);
  }
  return m;
}

// Del embebido solo si el VALOR es un literal: con `{ referencedTable: variable }` y la variable
// en `undefined`, postgrest-js usa el `limit` de PRIMER nivel (medido: `...&limit=5000`).
const deEmbebido = (o) => o instanceof Map && ['referencedTable', 'foreignTable'].some((k) => o.has(k) && ts.isStringLiteralLike(o.get(k)) && o.get(k).text !== '');

/** Las columnas propias de un select, sin los embebidos (`categorias(nombre, id)`). */
function columnasPropias(sel) {
  let s = sel;
  for (let prev = ''; prev !== s; ) { prev = s; s = s.replace(/[\w!:.]+\([^()]*\)/g, ''); }
  return s.split(',').map((c) => c.trim()).filter(Boolean);
}

function esFija(l) {
  const [a0, a1] = l.nodo.arguments;
  if (l.metodo === 'single' || l.metodo === 'maybeSingle') return true;
  if ((l.metodo === 'eq' || l.metodo === 'in') && literalTexto(a0) === 'id') return true;
  if (l.metodo === 'select') {
    // `head: true` sin `count` da `count: null`, y `'estimated'`/`'planned'` devuelven la estimación
    // del planner justo pasando `max_rows`: el único conteo de verdad es `'exact'`.
    const o = opciones(a1);
    return o instanceof Map && o.get('head')?.kind === ts.SyntaxKind.TrueKeyword && literalTexto(o.get('count')) === 'exact';
  }
  return false;
}

/**
 * ¿`e` es `require(X)` con X relativo que, resuelto desde `rel`, es `lib/todas-las-filas`? Por
 * RUTA y no por nombre: una copia `./todas-las-filas.js` en otra carpeta (con otra página, o
 * devolviendo la lista parcial con error) no es el paginador.
 */
const esRequireDelPaginador = (e, rel) => {
  const n = e && pelar(e);
  if (!n || !ts.isCallExpression(n) || !ts.isIdentifier(n.expression) || n.expression.text !== 'require' ||
    n.arguments.length !== 1 || !ts.isStringLiteralLike(n.arguments[0])) return false;
  const spec = n.arguments[0].text;
  if (!spec.startsWith('.')) return false;
  return posix.normalize(posix.join(posix.dirname(rel), spec)).replace(/\.js$/, '') === MODULO;
};

function analizar(rel, codigo) {
  const kind = /\.tsx$/.test(rel) ? ts.ScriptKind.TSX : /\.ts$/.test(rel) ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const sf = ts.createSourceFile(rel, codigo, ts.ScriptTarget.Latest, true, kind);
  const hallazgos = [];
  let lecturas = 0;

  // Cuántas veces se liga cada nombre en TODO el archivo, en cualquier ámbito.
  const veces = new Map();
  const ligar = (nombre) => veces.set(nombre, (veces.get(nombre) ?? 0) + 1);
  const contar = (m) => {
    if ((ts.isVariableDeclaration(m) || ts.isParameter(m) || ts.isBindingElement(m)) && ts.isIdentifier(m.name)) ligar(m.name.text);
    if ((ts.isFunctionDeclaration(m) || ts.isFunctionExpression(m) || ts.isClassDeclaration(m) || ts.isClassExpression(m)) && m.name) ligar(m.name.text);
    if (ts.isImportClause(m) && m.name) ligar(m.name.text);
    if (ts.isNamespaceImport(m) || ts.isImportSpecifier(m) || ts.isImportEqualsDeclaration(m)) ligar(m.name.text);
    ts.forEachChild(m, contar);
  };
  contar(sf);

  // Los nombres con que el archivo trae `todasLasFilas`: directo (`const { todasLasFilas } =
  // require(...)`), por namespace (`const p = require(...)`, `p.todasLasFilas`) o desestructurando
  // ese namespace (`const { todasLasFilas } = p`). Solo en el TOPE del archivo y con `const`. Un
  // `import` ESM no cuenta: contra el CJS congelado no trae exports con nombre (ver el docblock).
  // `require` no puede estar re-ligado (un `function require` al tope tapa el del wrapper de CJS),
  // salvo el `const require = createRequire(import.meta.url)` de un `.mjs`.
  // Tampoco reasignado (`require = envolver(require)`), y el `createRequire` tiene que venir de
  // `module`/`node:module` y no estar re-ligado: uno local con ese nombre puede devolver cualquier cosa.
  let reasigna = false;
  const buscarReasigna = (m) => {
    if (ts.isBinaryExpression(m) && m.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && m.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
      ts.isIdentifier(m.left) && (m.left.text === 'require' || m.left.text === 'createRequire')) reasigna = true;
    ts.forEachChild(m, buscarReasigna);
  };
  buscarReasigna(sf);
  const createRequireDeModule = veces.get('createRequire') === 1 && sf.statements.some((s) => ts.isImportDeclaration(s) &&
    ts.isStringLiteral(s.moduleSpecifier) && /^(node:)?module$/.test(s.moduleSpecifier.text) &&
    s.importClause?.namedBindings && ts.isNamedImports(s.importClause.namedBindings) &&
    s.importClause.namedBindings.elements.some((e) => e.name.text === 'createRequire' && (e.propertyName ?? e.name).text === 'createRequire'));
  const requireConfiable = !reasigna && (!veces.get('require') || (veces.get('require') === 1 && createRequireDeModule && sf.statements.some((s) => ts.isVariableStatement(s) &&
    (s.declarationList.flags & ts.NodeFlags.Const) !== 0 && s.declarationList.declarations.some((d) => ts.isIdentifier(d.name) && d.name.text === 'require' &&
      d.initializer && d.initializer.getText().replace(/\s+/g, '') === 'createRequire(import.meta.url)'))));
  // `with (obj) { … LIMITE … }` puede tapar cualquier nombre en runtime: con un `with` en el
  // archivo no se resuelve ninguna constante.
  let hayWith = false;
  const buscarWith = (m) => { if (m.kind === ts.SyntaxKind.WithStatement) hayWith = true; ts.forEachChild(m, buscarWith); };
  buscarWith(sf);
  const directos = new Set();
  const espacios = new Set();
  const constantesDelTope = sf.statements.filter((s) => ts.isVariableStatement(s) && (s.declarationList.flags & ts.NodeFlags.Const) !== 0)
    .flatMap((s) => [...s.declarationList.declarations]);
  const tomarDe = (patron) => {
    for (const e of patron.elements) {
      if (e.dotDotDotToken || !ts.isIdentifier(e.name)) continue;
      const orig = e.propertyName ? (ts.isIdentifier(e.propertyName) ? e.propertyName.text : null) : e.name.text;
      if (orig === 'todasLasFilas') directos.add(e.name.text);
    }
  };
  for (const d of constantesDelTope) {
    if (!requireConfiable || !esRequireDelPaginador(d.initializer, rel)) continue;
    if (ts.isIdentifier(d.name)) espacios.add(d.name.text);
    if (ts.isObjectBindingPattern(d.name)) tomarDe(d.name);
  }
  for (const d of constantesDelTope) {
    const ini = d.initializer && pelar(d.initializer);
    if (ini && ts.isIdentifier(ini) && espacios.has(ini.text) && ts.isObjectBindingPattern(d.name)) tomarDe(d.name);
  }
  const unica = (nombre) => veces.get(nombre) === 1;
  const esElPaginador = (n) => {
    if (ts.isIdentifier(n)) return directos.has(n.text) && unica(n.text);
    return ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression) && espacios.has(n.expression.text) &&
      unica(n.expression.text) && n.name.text === 'todasLasFilas';
  };

  /** Cómo liga `p` al `nombre`: `'opaca'` (import, require, parámetro, for, catch, let, var), su inicializador `const`, o nada. */
  const ligadura = (p, nombre) => {
    if (ts.isFunctionLike(p) && p.parameters.some((q) => nombresLigados(q.name).includes(nombre))) return 'opaca';
    if ((ts.isForOfStatement(p) || ts.isForInStatement(p) || ts.isForStatement(p)) && p.initializer && ts.isVariableDeclarationList(p.initializer) &&
      p.initializer.declarations.some((d) => nombresLigados(d.name).includes(nombre))) return 'opaca';
    if (ts.isCatchClause(p) && p.variableDeclaration && nombresLigados(p.variableDeclaration.name).includes(nombre)) return 'opaca';
    const sentencias = ts.isBlock(p) || ts.isSourceFile(p) || ts.isModuleBlock(p) || ts.isCaseClause(p) || ts.isDefaultClause(p) ? p.statements : null;
    if (!sentencias) return null;
    for (const s of sentencias) {
      if (ts.isImportDeclaration(s)) {
        const b = s.importClause;
        const liga = !!b && (b.name?.text === nombre || (!!b.namedBindings && (ts.isNamespaceImport(b.namedBindings) ? b.namedBindings.name.text === nombre : b.namedBindings.elements.some((e) => e.name.text === nombre))));
        if (liga) return 'opaca';
      }
      if ((ts.isFunctionDeclaration(s) || ts.isClassDeclaration(s)) && s.name?.text === nombre) return 'opaca';
      if (!ts.isVariableStatement(s)) continue;
      for (const d of s.declarationList.declarations) {
        if (!nombresLigados(d.name).includes(nombre)) continue;
        const esConst = (s.declarationList.flags & ts.NodeFlags.Const) !== 0;
        return esConst && ts.isIdentifier(d.name) && d.initializer ? d.initializer : 'opaca';
      }
    }
    return null;
  };

  /** El valor numérico de `e` (o una cota superior) si se sabe sin ejecutar nada; `null` si no. */
  const resolver = (e, prof = 0) => {
    if (!e || prof > 8) return null;
    const n = pelar(e);
    if (ts.isNumericLiteral(n)) return Number(n.text);
    if (ts.isBinaryExpression(n)) {
      const a = resolver(n.left, prof + 1);
      const b = resolver(n.right, prof + 1);
      if (a === null || b === null) return null;
      if (n.operatorToken.kind === ts.SyntaxKind.PlusToken) return a + b;
      if (n.operatorToken.kind === ts.SyntaxKind.MinusToken) return a - b;
      if (n.operatorToken.kind === ts.SyntaxKind.AsteriskToken) return a * b;
      return null;
    }
    // `Math.min(x, 200)` nunca pasa de 200, sepa o no cuánto vale `x`.
    if (ts.isCallExpression(n) && n.expression.getText() === 'Math.min') {
      const cotas = n.arguments.map((a) => resolver(a, prof + 1)).filter((v) => v !== null);
      return cotas.length ? Math.min(...cotas) : null;
    }
    if (!ts.isIdentifier(n) || hayWith) return null;
    // Un nombre ligado más de una vez en el archivo no se resuelve: `var` se iza, y seguir
    // ámbitos es exactamente lo que la webapp aprendió a no hacer.
    if (!unica(n.text)) return null;
    for (let p = n.parent; p; p = p.parent) {
      const l = ligadura(p, n.text);
      if (l === 'opaca') return null;
      if (l) return resolver(l, prof + 1);
    }
    return null;
  };

  /** Si `externo` es el cuerpo de la página de un `todasLasFilas` real, esa llamada y su función. */
  const paginaDe = (externo) => {
    const p = subir(externo);
    let fn = null;
    if (p && ts.isArrowFunction(p) && !ts.isBlock(p.body) && pelar(p.body) === externo) fn = p;
    if (p && ts.isReturnStatement(p)) for (let f = p.parent; f; f = f.parent) if (ts.isFunctionLike(f)) { fn = f; break; }
    if (!fn || !(ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) return null;
    const call = subir(fn);
    return call && ts.isCallExpression(call) && esElPaginador(call.expression) && call.arguments[0] === fn ? { todas: call, fn } : null;
  };

  /** ¿Se ejecuta ahí mismo, sin que se le pueda encadenar nada más? */
  const cerrada = (externo, llamadas) => {
    if (llamadas.some((l) => l.metodo === 'then')) return true;
    if (paginaDe(externo)) return true;
    let p = subir(externo);
    let hijo = externo;
    // `await (x ? a.limit(10) : b.limit(10))`: cada rama se juzga por donde termina el ternario.
    while (p && ts.isConditionalExpression(p) && hijo !== p.condition) { hijo = p; p = subir(p); }
    if (!p) return false;
    if (ts.isAwaitExpression(p)) return true;
    if (ts.isArrayLiteralExpression(p)) {
      const call = subir(p);
      return !!call && ts.isCallExpression(call) && /^Promise\.(all|allSettled)$/.test(call.expression.getText());
    }
    let fn = null;
    if (ts.isArrowFunction(p) && !ts.isBlock(p.body) && pelar(p.body) === hijo) fn = p;
    if (ts.isReturnStatement(p)) for (let f = p.parent; f; f = f.parent) if (ts.isFunctionLike(f)) { fn = f; break; }
    if (!fn) return false;
    // Lo que devuelve una función async se resuelve en el `return`: nadie recibe el builder.
    return (ts.getCombinedModifierFlags(fn) & ts.ModifierFlags.Async) !== 0;
  };

  /** La página de `todasLasFilas` tiene UNA forma aceptada y cualquier otra es roja. */
  const paginaInvalida = (llamadas, pag) => {
    const params = pag.fn.parameters.map((p) => p.name.getText());
    // `function (desde, desde, primera)` es válido en CJS no estricto, y `range(desde, desde)` calza
    // por texto con los dos primeros parámetros.
    if (new Set(params).size !== params.length) return 'la página de todasLasFilas pisa sus propios parámetros';
    let pisa = false;
    const v = (m) => {
      const objetivo = ts.isBinaryExpression(m) && m.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && m.operatorToken.kind <= ts.SyntaxKind.LastAssignment ? m.left
        : ts.isPrefixUnaryExpression(m) || ts.isPostfixUnaryExpression(m) ? m.operand : null;
      if (objetivo && ts.isIdentifier(objetivo) && params.includes(objetivo.text)) pisa = true;
      // Un `const ini = 0` en un bloque TAPA el parámetro, y `range(ini, fin)` lo nombra igual.
      if ((ts.isVariableDeclaration(m) || ts.isParameter(m) || ts.isBindingElement(m)) && m !== pag.fn && !pag.fn.parameters.includes(m) &&
        nombresLigados(m.name).some((x) => params.includes(x))) pisa = true;
      ts.forEachChild(m, v);
    };
    v(pag.fn.body);
    // Los parámetros se recorren también (un default `_r = (desde = 0)` pisa sin tocar el cuerpo), y
    // `arguments[0] = 0` en una `function` no estricta pisa `desde` sin nombrarlo.
    for (const p of pag.fn.parameters) if (p.initializer || !ts.isIdentifier(p.name) || p.dotDotDotToken) pisa = true;
    const usaArguments = (m) => (ts.isIdentifier(m) && m.text === 'arguments') || !!ts.forEachChild(m, usaArguments);
    if (usaArguments(pag.fn)) pisa = true;
    if (pisa) return 'la página de todasLasFilas pisa sus propios parámetros';
    const propias = llamadas.filter((l) => l.metodo !== 'returns');
    const ultima = propias.at(-1);
    if (!ultima || ultima.metodo !== 'range') return 'la página de todasLasFilas tiene que terminar en .range(desde, hasta)';
    const [a0, a1, a2] = ultima.nodo.arguments;
    if (!a0 || !a1 || a2 || a0.getText() !== params[0] || a1.getText() !== params[1]) return '.range() dentro de todasLasFilas sin los parámetros de la página';
    if (propias.some((l) => l.metodo === 'limit')) return 'un .limit dentro de la página de todasLasFilas';
    const ordenes = propias.filter((l) => l.metodo === 'order');
    for (const o of ordenes) {
      const op = opciones(o.nodo.arguments[1]);
      const booleana = (e) => e.kind === ts.SyntaxKind.TrueKeyword || e.kind === ts.SyntaxKind.FalseKeyword;
      // El VALOR también literal: `{ ascending: primera }` invierte el orden entre páginas.
      if (op === 'sucio' || (op && [...op.entries()].some(([k, e]) => (k !== 'ascending' && k !== 'nullsFirst') || !booleana(e)))) return 'un .order de la página con opciones que no son { ascending } literal';
    }
    if (literalTexto(ordenes.at(-1)?.nodo.arguments[0]) !== 'id') return 'todasLasFilas sin un orden que termine en id';
    const selects = propias.filter((l) => l.metodo === 'select');
    // postgrest-js: el ÚLTIMO `.select(cols)` pisa las columnas. Uno solo, y es el que se lee.
    if (selects.length !== 1) return 'la página de todasLasFilas con más de un .select: el último pisa las columnas que el guard leyó';
    const select = selects[0];
    const sel = literalTexto(select?.nodo.arguments[0]);
    if (sel !== null && /["'`]/.test(sel)) return 'todasLasFilas con comillas en el select: un alias citado (`"id":x`) no se puede leer como columna propia';
    const cols = sel === null ? [] : columnasPropias(sel);
    if (cols.some((c) => /^id\s*:/.test(c))) return 'todasLasFilas con un alias `id:` en el select: pisa el id propio y la clave deja de ser la fila';
    if (sel !== null && sel.includes('...')) return 'todasLasFilas con un spread en el select: aplana columnas ajenas en la fila y su `id` pisa el propio';
    if (!cols.includes('*') && !cols.includes('id')) return 'todasLasFilas con un select sin `id` propio: la clave sale undefined y deduplica todo a una fila';
    if (!esConteoDePagina(select?.nodo.arguments[1])) return "todasLasFilas sin count: 'exact' en la primera página";
    const clave = pag.todas.arguments[1];
    if (!clave || !ts.isArrowFunction(clave) || clave.parameters.length !== 1 || ts.isBlock(clave.body)) return 'todasLasFilas sin la clave (t) => t.id';
    const cuerpo = pelar(clave.body);
    const esId = ts.isPropertyAccessExpression(cuerpo) && cuerpo.expression.getText() === clave.parameters[0].name.getText() && cuerpo.name.text === 'id';
    return esId ? null : 'todasLasFilas sin la clave (t) => t.id';
  };

  /** El ancho de un `.range(a, b)`, también con `a` desconocido (`range(desde, desde + N - 1)`). */
  const anchoDeRange = (a0, a1) => {
    const d = resolver(a0);
    const h = resolver(a1);
    if (d !== null && h !== null) return h - d + 1;
    const hh = a1 && pelar(a1);
    if (!a0 || !hh || !ts.isBinaryExpression(hh)) return null;
    const base = a0.getText();
    if (hh.operatorToken.kind === ts.SyntaxKind.PlusToken && hh.left.getText() === base) {
      const k = resolver(hh.right);
      return k === null ? null : k + 1;
    }
    const izq = pelar(hh.left);
    if (hh.operatorToken.kind === ts.SyntaxKind.MinusToken && ts.isBinaryExpression(izq) && izq.operatorToken.kind === ts.SyntaxKind.PlusToken && izq.left.getText() === base) {
      const k = resolver(izq.right);
      const m = resolver(hh.right);
      return k === null || m === null ? null : k - m + 1;
    }
    return null;
  };

  /** El veredicto de una cadena de lectura: `null` si está acotada. */
  const veredicto = (externo, llamadas) => {
    const pag = paginaDe(externo);
    if (pag) return paginaInvalida(llamadas, pag);
    // Un conteo `estimated`/`planned` miente justo pasando `max_rows`, y entraba por `.limit(1)` o
    // `.maybeSingle()`. Cualquier `select` con `count` que no sea el literal `'exact'` es rojo.
    for (const l of llamadas.filter((x) => x.metodo === 'select')) {
      const a1 = l.nodo.arguments[1];
      if (esConteoDePagina(a1)) continue;
      const o = opciones(a1);
      if (o === 'sucio') return '.select() con opciones que no son un objeto literal: no se puede saber qué conteo pide';
      if (o instanceof Map && o.has('count') && literalTexto(o.get('count')) !== 'exact') return ".select() con un count que no es 'exact': estimado o planeado, miente pasando las 1000 filas";
    }
    // `.setHeader('Prefer', 'count=planned')` pisa el conteo que pidió el select, y nada en el
    // backend necesita cambiar headers de una lectura de transacciones.
    if (llamadas.some((l) => l.metodo === 'setHeader')) return '.setHeader() en una lectura de transacciones: puede pisar el Prefer del conteo';
    if (llamadas.some(esFija)) return null;
    const hasta = llamadas.findIndex((l) => l.metodo === 'then');
    const propias = hasta === -1 ? llamadas : llamadas.slice(0, hasta);
    let ultimo = null;
    for (const l of propias) {
      if (l.metodo !== 'limit' && l.metodo !== 'range') continue;
      const op = opciones(l.nodo.arguments[l.metodo === 'limit' ? 1 : 2]);
      if (op === 'sucio') return `.${l.metodo}() con opciones que no son un objeto literal: no se puede saber si son del embebido`;
      if (op instanceof Map && (op.has('referencedTable') || op.has('foreignTable')) && !deEmbebido(op)) return `.${l.metodo}() con un embebido que no es un literal no vacío: postgrest-js lo manda como otra cosa`;
      if (!deEmbebido(op)) ultimo = l;
    }
    if (!ultimo) return 'sin .range/.limit/head:true/filtro por id';
    const [a0, a1] = ultimo.nodo.arguments;
    let filas;
    if (ultimo.metodo === 'limit') {
      const n = resolver(a0);
      if (n === null) return `.limit(${a0?.getText()}) no se puede resolver a un número`;
      if (n > TOPE_TOP_N) return `.limit(${n}) pide más de ${TOPE_TOP_N} filas fuera de todasLasFilas: un top-N es chico, y lo que suma va paginado (PostgREST corta en ${MAX_ROWS})`;
      filas = n;
    } else {
      const ancho = anchoDeRange(a0, a1);
      if (ancho === null || ancho > TOPE_TOP_N) return `.range() fuera de todasLasFilas más ancho que un top-N (${TOPE_TOP_N}) o que no se resuelve`;
      filas = ancho;
    }
    if (!cerrada(externo, llamadas)) return 'el builder sale de la cadena (variable, argumento, ternario, propiedad) y alguien puede pisarle el límite: ciérrala en el lugar o va a EXENCIONES';
    // Una fila es "¿hay alguna? / ¿cuál es la última?": no hay suma que cortar. Cualquier otro tope
    // puede ser un top-N o una suma recortada, y eso no lo decide la sintaxis: va a TOP_N.
    return ultimo.metodo === 'limit' && filas <= 1 ? null : TOPN_SIN_DECLARAR;
  };

  const lee = (llamadas) =>
    !llamadas.some((l) => ESCRITURAS.has(l.metodo)) || llamadas.some((l) => l.metodo === 'select' || l.metodo === 'csv');

  const visitar = (n) => {
    if (ts.isCallExpression(n) && nombreMetodo(n.expression) === 'from' && n.arguments.length >= 1) {
      // postgrest-js arma la URL con `new URL`, que normaliza `./transacciones` y similares: se
      // compara el último segmento, sin query.
      const crudo = literalTexto(n.arguments[0]);
      const tabla = crudo === null ? null : (crudo.split(/[?#]/)[0].split('/').filter(Boolean).pop() ?? '');
      const receptor = n.expression.expression.getText();
      // `supabase.storage.from(bucket)` es Storage, no PostgREST: no tiene `max_rows`. EXACTAMENTE
      // ese receptor: `this.storage` o `deps.storage` pueden ser un cliente de base inyectado.
      const esStorage = receptor.replace(/\s+/g, '') === 'supabase.storage';
      if ((tabla === null && !NO_SUPABASE.test(receptor) && !esStorage) || (tabla !== null && TABLAS.has(tabla))) {
        const linea = sf.getLineAndCharacterOfPosition(n.getStart()).line + 1;
        const { externo, llamadas } = cadena(n);
        const p = subir(externo);
        const usos = [];
        if (llamadas.length === 0 && p && ts.isVariableDeclaration(p) && ts.isIdentifier(p.name) && p.initializer) {
          // El alias pelado (`const base = supabase.from(x)`) se juzga en cada uso.
          const nombre = p.name;
          const lista = p.parent;
          // `var` vive en toda la función, no en el bloque donde se escribió.
          const esVar = (lista.flags & (ts.NodeFlags.Const | ts.NodeFlags.Let)) === 0;
          let ambito = p;
          while (ambito.parent && !(esVar ? ts.isFunctionLike(ambito) || ts.isSourceFile(ambito) : ts.isBlock(ambito) || ts.isSourceFile(ambito))) ambito = ambito.parent;
          // En el tope del archivo el alias puede salir por `module.exports`/`exports.x`, y ahí
          // sus usos viven en otro archivo: se juzga además como lo que es acá, sin cota.
          if (ts.isSourceFile(ambito)) usos.push({ externo, llamadas });
          const v = (m) => {
            if (ts.isIdentifier(m) && m !== nombre && m.text === nombre.text && !(ts.isPropertyAccessExpression(m.parent) && m.parent.name === m)) usos.push(cadena(m));
            ts.forEachChild(m, v);
          };
          v(ambito);
        } else {
          usos.push({ externo, llamadas });
        }
        for (const u of usos) {
          if (!lee(u.llamadas)) continue;
          const consulta = u.externo.getText().replace(/\s+/g, '');
          if (tabla === null) {
            hallazgos.push({ rel, linea, consulta, motivo: 'tabla no literal que lee: no se puede saber que no es transacciones' });
            continue;
          }
          lecturas++;
          const motivo = veredicto(u.externo, u.llamadas);
          if (motivo) hallazgos.push({ rel, linea, consulta, motivo });
        }
      }
    }
    // PostgREST le aplica `max_rows` a CADA nodo del árbol (Plan.hs, treeRestrictRange): un
    // `categorias.select('…, transacciones(monto_pen)')` corta el embebido en 1000 sin avisar.
    if (ts.isCallExpression(n) && nombreMetodo(n.expression) === 'select') {
      const sel = literalTexto(n.arguments[0]);
      if (sel !== null && EMBEBE_TRANSACCIONES.test(sel)) {
        hallazgos.push({ rel, linea: sf.getLineAndCharacterOfPosition(n.getStart()).line + 1, consulta: n.getText().replace(/\s+/g, ''), motivo: 'embebe transacciones desde otra tabla: PostgREST corta el embebido en 1000 igual' });
      }
    }
    ts.forEachChild(n, visitar);
  };
  visitar(sf);
  return { hallazgos, lecturas };
}

// Con la cadena ENTERA, no con un fragmento: con `includes`, la tercera ronda reescribió lecturas
// declaradas por los dos lados (`.limit(10).range(0, 99)` adelante, `.select('monto_pen')` sin el
// filtro de usuario atrás) y siguieron calzando.
const declaradoTopN = (h) => h.motivo === TOPN_SIN_DECLARAR && TOP_N.some((e) => e.archivo === h.rel && h.consulta === e.consulta);
const exenta = (h) => declaradoTopN(h) || EXENCIONES.some((e) => e.archivo === h.rel && h.consulta === e.consulta);

// ─── El barrido ──────────────────────────────────────────────────────────────────────────────

const RAIZ = join(__dirname, '..');
// Lista NEGRA, como `railway.json`: un directorio de runtime nuevo nace barrido. Cada exclusión
// tiene su porqué: `webapp/` tiene su propio guard, `tests/` y `qa-e2e/` no corren en el servidor.
const FUERA = new Set(['node_modules', 'webapp', 'tests', 'qa-e2e', '.git', 'coverage']);
const NO_CODIGO = /\.(md|json|sql|txt|csv|html?|css|ya?ml|lock|env|log|png|jpe?g|gif|svg|webp|ico|pdf|xlsx?|py|map|gitignore|example)$/i;

// Las exclusiones valen SOLO en la raíz: un `routes/webapp/` o un `services/tests/` es runtime.
function archivos(dir, raiz = true) {
  return readdirSync(dir).flatMap((nombre) => {
    if (raiz && FUERA.has(nombre)) return [];
    if (nombre === 'node_modules') return [];
    const full = join(dir, nombre);
    if (statSync(full).isDirectory()) return archivos(full, false);
    if (/\.test\.[cm]?[jt]s$/.test(full) || /\.d\.ts$/.test(full)) return [];
    if (/\.[cm]?[jt]s$/.test(full)) return [full];
    // Node corre como CJS lo que le pasen (`node scripts/x`, `node x.v2`, `require('./x.v2')`), así
    // que no se decide por extensión: entra todo lo que no sea un formato conocido de no-código y
    // mencione la tabla. Lista NEGRA otra vez: un formato nuevo nace barrido.
    // `.from(` y no `transacciones`: con la tabla por argumento (`node scripts/x.v2 transacciones`)
    // el texto no la nombra, y el analizador ya trata una tabla no literal como roja.
    if (NO_CODIGO.test(nombre)) return [];
    const texto = readFileSync(full, 'utf-8');
    return texto.includes('transacciones') || texto.includes('.from(') ? [full] : [];
  });
}

const fuentes = archivos(RAIZ).map((full) => ({ rel: relative(RAIZ, full).replace(/\\/g, '/'), contenido: readFileSync(full, 'utf-8') }));
const resultados = fuentes.map((f) => ({ ...f, ...analizar(f.rel, f.contenido) }));
const todos = resultados.flatMap((r) => r.hallazgos);

const CABECERA = "const { todasLasFilas, TAMANO_PAGINA } = require('../lib/todas-las-filas');";

/** Un fragmento como si fuera `services/fixture.js`, que requiere el paginador real. */
const caso = (cuerpo, arriba = '', cabecera = CABECERA) => analizar(
  'services/fixture.js',
  `${cabecera}\n${arriba}\nasync function f(svc, u, x, ids, options) {\n${cuerpo}\n}`,
).hallazgos.map((h) => h.motivo);

const PAG = "(d, h, p) => svc.from('transacciones').select('*', p ? { count: 'exact' } : undefined)";
const SALE = 'el builder sale de la cadena (variable, argumento, ternario, propiedad) y alguien puede pisarle el límite: ciérrala en el lugar o va a EXENCIONES';
const SIN = 'sin .range/.limit/head:true/filtro por id';
const IRRESOLUBLE = /no se puede resolver a un número/;
const GRANDE = /pide más de 100 filas fuera de todasLasFilas/;
const FUERA_DE_TODAS = /\.range\(\) fuera de todasLasFilas/;

describe('las lecturas de transacciones del backend no se cortan en 1000 en silencio', () => {
  // Antivacuidad. Cuenta archivos y lecturas analizadas, no defectos: un contador anclado a que
  // el problema siga existiendo se rompe justo cuando se arregla.
  it('el barrido mira algo', () => {
    expect(fuentes.length).toBeGreaterThan(100);
    expect(resultados.reduce((n, r) => n + r.lecturas, 0)).toBeGreaterThanOrEqual(40);
    const conLecturas = resultados.filter((r) => r.lecturas > 0).map((r) => r.rel);
    for (const f of ['services/neto-score.js', 'services/summaries.js', 'services/budget.js', 'services/subscriptions/detector.js', 'handlers/intents/analytics.js', 'routes/admin.js', 'cron/checks.js']) {
      expect(conLecturas).toContain(f);
    }
    expect(fuentes.map((f) => f.rel)).toContain('index.js');
    expect(fuentes.map((f) => f.rel)).toContain('gmail.js');
  });

  describe('el detector', () => {
    // Las formas de reintroducir el corte que encontraron las cuatro rondas de la webapp, en JS,
    // más las propias de CommonJS. Cada una afirma el MOTIVO, no sólo que hubo un hallazgo: un
    // rojo por otra condición no prueba que esta forma se vea.
    it.each([
      ['el select pelado', "await svc.from('transacciones').select('*').eq('usuario_id', u);", SIN],
      ['comillas dobles', 'await svc.from("transacciones").select("*").eq("usuario_id", u);', SIN],
      ['template literal', 'await svc.from(`transacciones`).select(`*`);', SIN],
      ['el from por corchetes', "await svc['from']('transacciones').select('*');", SIN],
      ['el límite en un comentario', "await svc.from('transacciones').select('*') // .limit(10)\n;", SIN],
      ['el límite en OTRA consulta de la misma línea', "const a = await svc.from('transacciones').select('*'); const b = await svc.from('presupuestos').select('*').limit(1);", SIN],
      ['un filtro por usuario no es un filtro por id', "await svc.from('transacciones').select('*').eq('usuario_id', u).order('id');", SIN],
      ['count exacto sin head', "await svc.from('transacciones').select('*', { count: 'exact' });", SIN],
      ['head que no es el literal true', "await svc.from('transacciones').select('*', { count: 'exact', head: x });", SIN],
      ['un .limit del embebido', "await svc.from('transacciones').select('*, x(*)').limit(5, { referencedTable: 'x' });", SIN],
      ['todasLasFilas sin .range', "await todasLasFilas(() => svc.from('transacciones').select('*'));", /terminar en \.range/],
      ['un .limit mayor que la página', "await svc.from('transacciones').select('*').limit(5000);", GRANDE],
      ['un .limit por constante grande', "const TOPE_X = 5000;\nawait svc.from('transacciones').select('*').limit(TOPE_X);", GRANDE],
      ['un .limit por aritmética', "const MAX_FILAS = 5 * 1000;\nawait svc.from('transacciones').select('*').limit(MAX_FILAS);", GRANDE],
      ['una const chica de OTRO ámbito con el mismo nombre', "async function g() { const LIMITE = 20; return LIMITE; }\nasync function h() { const LIMITE = 5000; return svc.from('transacciones').select('*').limit(LIMITE); }\nawait h();", IRRESOLUBLE],
      ['un .limit por let', "let LIM = 5000;\nawait svc.from('transacciones').select('*').limit(LIM);", IRRESOLUBLE],
      ['un .limit requerido de otro módulo', "await svc.from('transacciones').select('*').limit(LIMITE_EXPORT);", IRRESOLUBLE, "const { LIMITE_EXPORT } = require('./limites');"],
      ['un .limit de una propiedad de un require', "await svc.from('transacciones').select('*').limit(LIMITES.tx);", IRRESOLUBLE, "const LIMITES = require('./limites');"],
      ['un .limit con ternario', "await svc.from('transacciones').select('*').limit(x ? 10000 : 50);", IRRESOLUBLE],
      ['un .limit de un parámetro', "await svc.from('transacciones').select('*').limit(options.limit);", IRRESOLUBLE],
      ['un parámetro desestructurado que tapa una const chica', "const limite = 50;\nasync function g({ usuarioId, limite }) { return svc.from('transacciones').select('*').eq('usuario_id', usuarioId).limit(limite); }\nawait g({});", IRRESOLUBLE],
      ['un .limit chico pisado por un .range', "await svc.from('transacciones').select('*').limit(100).range(0, options.total - 1);", FUERA_DE_TODAS],
      ['un .range suelto de varias páginas', "await svc.from('transacciones').select('*').range(0, 4999);", FUERA_DE_TODAS],
      ['un todasLasFilas que no es el requerido', "await todasLasFilas2((d, h) => svc.from('transacciones').select('*', { count: 'exact' }).order('id').range(d, h), (t) => t.id);", FUERA_DE_TODAS],
      ['todasLasFilas con un range fijo', `await todasLasFilas(${PAG}.order('id').range(0, 99999), (t) => t.id);`, /sin los parámetros de la página/],
      ['todasLasFilas sin orden por id', `await todasLasFilas(${PAG}.order('fecha').range(d, h), (t) => t.id);`, /orden que termine en id/],
      ['todasLasFilas con el id antes de otro orden', `await todasLasFilas(${PAG}.order('id').order('fecha').range(d, h), (t) => t.id);`, /orden que termine en id/],
      ['todasLasFilas con un select sin id', "await todasLasFilas((d, h, p) => svc.from('transacciones').select('monto, monto_pen', p ? { count: 'exact' } : undefined).eq('usuario_id', u).order('id').range(d, h), (t) => t.id);", /select sin `id`/],
      ['todasLasFilas sin clave', `await todasLasFilas(${PAG}.order('id').range(d, h));`, /clave \(t\) => t\.id/],
      ['todasLasFilas sin conteo', "await todasLasFilas((d, h) => svc.from('transacciones').select('*').order('id').range(d, h), (t) => t.id);", /count: 'exact'/],
      ['el límite chico en la base, pisado en una rama', "let q = svc.from('transacciones').select('*').limit(50);\nif (x) q = q.limit(10000);\nawait q;", SALE],
      ['el límite chico en las dos ramas de un if', "let q;\nif (x) { q = svc.from('transacciones').select('*').limit(50); } else { q = svc.from('transacciones').select('id').limit(50); }\nif (options.todo) q = q.limit(5000);\nawait q;", SALE],
      ['un ternario de builders acotados, paginado después', "const base = x ? svc.from('transacciones').select('*').limit(20) : svc.from('transacciones').select('id').limit(20);\nawait base.range(0, 9999);", SALE],
      ['un helper que recibe el builder acotado', "const tope = (q, n) => q.order('fecha').limit(n);\nawait tope(svc.from('transacciones').select('*').limit(100), 5000);", SALE],
      ['un builder en la propiedad de un objeto', "function consultas(id) { return { tx: svc.from('transacciones').select('*').eq('usuario_id', id).limit(10) }; }\nawait consultas(u).tx.range(0, 9999);", SALE],
      ['un builder devuelto por una función NO async', "const consulta = () => svc.from('transacciones').select('*').limit(10);\nawait consulta().limit(5000);", SALE],
      ['un builder acotado en una variable', "const q = svc.from('transacciones').select('*').limit(10);\nawait q;", SALE],
      ['el alias de la tabla', "const t = svc.from('transacciones');\nawait t.select('*');", SIN],
      ['un helper que recibe el builder pelado y le pone el select', "const delUsuario = (tabla, id) => tabla.select('*').eq('usuario_id', id);\nawait delUsuario(svc.from('transacciones'), u);", SIN],
      ['un .limit(TAMANO_PAGINA) después del range de la página', "await todasLasFilas((desde, hasta, primera) => svc.from('transacciones').select('monto_pen, fecha', primera ? { count: 'exact' } : undefined).order('fecha', { ascending: false }).range(desde, hasta).limit(TAMANO_PAGINA), (t) => t.id);", /terminar en \.range/],
      ['la página con .limit y sin .range', "await todasLasFilas((d, h, p) => svc.from('transacciones').select('*', p ? { count: 'exact' } : undefined).order('id').limit(TAMANO_PAGINA), (t) => t.id);", /terminar en \.range/],
      ['un id que es del embebido', "await todasLasFilas((d, h, p) => svc.from('transacciones').select('monto_pen, fecha, categorias(nombre, id, icono)', p ? { count: 'exact' } : undefined).order('id').range(d, h), (t) => t.id);", /select sin `id` propio/],
      ['un id alias de otra columna', "await todasLasFilas((d, h, p) => svc.from('transacciones').select('id:comercio, monto', p ? { count: 'exact' } : undefined).order('id').range(d, h), (t) => t.id);", /alias `id:`/],
      // Sexta ronda (segunda sobre el port CJS), ejecutadas con el guard verde.
      ['(A4) una suma mensual con un "top-N" de 100', "const { data } = await svc.from('transacciones').select('monto_pen').eq('usuario_id', u).eq('tipo', 'gasto').order('fecha', { ascending: false }).limit(100);", TOPN_SIN_DECLARAR],
      ['(A3) un loop a mano de a 100', "const POR_PAGINA = 100;\nfor (let desde = 0; ; desde += POR_PAGINA) { const { data } = await svc.from('transacciones').select('monto_pen').eq('usuario_id', u).order('fecha', { ascending: false }).range(desde, desde + POR_PAGINA - 1); if (data.length < POR_PAGINA) break; }", TOPN_SIN_DECLARAR],
      ['(A2) un embebido por variable que en runtime es el limit de primer nivel', "return svc.from('transacciones').select('monto_pen, fecha, categorias(nombre)').eq('usuario_id', u).order('fecha', { ascending: false }).limit(20).limit(options.cuantas ?? 5000, { referencedTable: options.embebido });", /embebido que no es un literal/],
      ['(R3) un embebido vacío', "await svc.from('transacciones').select('*').limit(5000).limit(1, { referencedTable: '' });", /embebido que no es un literal/],
      ['(A5) head:true sin count', "const { count } = await svc.from('transacciones').select('id', { head: true }).eq('usuario_id', u);", SIN],
      ['(A5) head:true con count estimado', "const { count } = await svc.from('transacciones').select('id', { count: 'estimated', head: true }).eq('usuario_id', u);", /count que no es 'exact'/],
      ['(R3) un count estimado con .limit(1)', "await svc.from('transacciones').select('id', { count: 'estimated' }).eq('usuario_id', u).limit(1);", /count que no es 'exact'/],
      ['(R3) un count planeado con maybeSingle', "await svc.from('transacciones').select('id, fecha', { count: 'planned' }).eq('usuario_id', u).limit(1).maybeSingle();", /count que no es 'exact'/],
      ['(R3) un segundo select en la página', "await todasLasFilas((desde, hasta, primera) => svc.from('transacciones').select('*', primera ? { count: 'exact' } : undefined).select('id:categoria_id, monto_pen').eq('usuario_id', u).order('id').range(desde, hasta), (t) => t.id);", /más de un \.select/],
      ['(R3) un alias id citado', "await todasLasFilas((desde, hasta, primera) => svc.from('transacciones').select('*, \"id\":categoria_id', primera ? { count: 'exact' } : undefined).order('id').range(desde, hasta), (t) => t.id);", /comillas en el select/],
      ['(R3) un default que pisa el parámetro', "await todasLasFilas((desde, hasta, primera, _r = (desde = 0)) => svc.from('transacciones').select('*', primera ? { count: 'exact' } : undefined).order('id').range(desde, hasta), (t) => t.id);", /pisa sus propios parámetros/],
      ['(R3) arguments[0] en una function', "await todasLasFilas(function (desde, hasta, primera) { arguments[0] = 0; return svc.from('transacciones').select('*', primera ? { count: 'exact' } : undefined).order('id').range(desde, hasta); }, (t) => t.id);", /pisa sus propios parámetros/],
      ['(R3) un range de ancho 1 en un loop', "for (let i = 0; i < 5000; i++) { await svc.from('transacciones').select('monto_pen').eq('usuario_id', u).order('fecha').range(i, i + 0); }", TOPN_SIN_DECLARAR],
      ['(R3) require reasignado', `require = ((real) => (id) => /todas-las-filas$/.test(id) ? { todasLasFilas: async (c) => c(0, 999, false) } : real(id))(require);\nawait todasLasFilas(${PAG}.order('id').range(d, h), (t) => t.id);`, FUERA_DE_TODAS],
      ['(R3) un createRequire local en un .mjs', `await todasLasFilas(${PAG}.order('id').range(d, h), (t) => t.id);`, FUERA_DE_TODAS, '', "const createRequire = () => () => ({ todasLasFilas: async (c) => c(0, 999, false) });\nconst require = createRequire(import.meta.url);\nconst { todasLasFilas } = require('../lib/todas-las-filas');"],
      ['(R4) embeber transacciones desde otra tabla', "await svc.from('categorias').select('id, nombre, transacciones(monto_pen, tipo)').eq('usuario_id', u);", /embebe transacciones/],
      ['(R4) embeber con alias y hint', "await svc.from('usuarios').select('id, txs:transacciones!fk_usuario(monto_pen)').eq('id', u).single();", /embebe transacciones/],
      ['(R4) setHeader que pisa el conteo', "await svc.from('transacciones').select('id', { count: 'exact', head: true }).eq('usuario_id', u).setHeader('Prefer', 'count=planned');", /setHeader/],
      ['(R4) la tabla con ./ delante', "await svc.from('./transacciones').select('monto_pen').eq('usuario_id', u);", SIN],
      ['(R4) la tabla con query', "await svc.from('transacciones?x=1').select('monto_pen').eq('usuario_id', u);", SIN],
      ['(R4) parámetros duplicados en una function', "await todasLasFilas(function (desde, desde, primera) { return svc.from('transacciones').select('*', primera ? { count: 'exact' } : undefined).order('id').range(desde, desde); }, (t) => t.id);", /pisa sus propios parámetros/],
      ['(R4) ascending que cambia entre páginas', "await todasLasFilas((d, h, p) => svc.from('transacciones').select('*', p ? { count: 'exact' } : undefined).order('id', { ascending: p }).range(d, h), (t) => t.id);", /order de la página/],
      ['(R4) count con un espacio adentro', "await todasLasFilas((d, h, p) => svc.from('transacciones').select('*', p ? { count: ' exact' } : undefined).order('id').range(d, h), (t) => t.id);", /count: 'exact'/],
      ['(R3) un with que puede tapar la constante', "const LIMITE = 1;\nwith (options) { await svc.from('transacciones').select('monto_pen').eq('usuario_id', u).limit(LIMITE); }", IRRESOLUBLE],
      ['(A1) from con un segundo argumento', "await svc.from('transacciones', { schema: 'public' }).select('monto_pen').eq('usuario_id', u);", SIN],
      ['(A7) un const de bloque que tapa el parámetro de la página', "await todasLasFilas((ini, fin, primera) => { if (x) { const ini = 0; return svc.from('transacciones').select('*', primera ? { count: 'exact' } : undefined).order('id').range(ini, fin); } return svc.from('transacciones').select('*', primera ? { count: 'exact' } : undefined).order('id').range(ini, fin); }, (t) => t.id);", /pisa sus propios parámetros/],
      ['(A6) un require propio que tapa el del wrapper', `await todasLasFilas(${PAG}.order('id').range(d, h), (t) => t.id);`, FUERA_DE_TODAS, '', "function require(id) { return { todasLasFilas: async (c) => c(0, 999, false) }; }\nconst { todasLasFilas } = require('../lib/todas-las-filas');"],
      ['(A8) un alias id: con asterisco', "await todasLasFilas((d, h, p) => svc.from('transacciones').select('*, id:categoria_id', p ? { count: 'exact' } : undefined).order('id').range(d, h), (t) => t.id);", /alias `id:`/],
      ['una clave que no es el id', "await todasLasFilas((d, h, p) => svc.from('transacciones').select('*', p ? { count: 'exact' } : undefined).order('id').range(d, h), (t) => `${t.fecha}|${t.monto}|${t.comercio}`);", /clave \(t\) => t\.id/],
      ['el orden por id de un embebido como último orden', "await todasLasFilas((d, h, p) => svc.from('transacciones').select('*, categorias(id)', p ? { count: 'exact' } : undefined).order('fecha').order('id', { referencedTable: 'categorias' }).range(d, h), (t) => t.id);", /order de la página/],
      ['opciones de embebido en una constante', "const UNA = { referencedTable: 'categorias' };\nawait svc.from('transacciones').select('*, categorias(*)').limit(1, UNA);", /opciones que no son un objeto literal/],
      ['head:true con spread', "await svc.from('transacciones').select('*', { head: true, count: 'exact', ...options });", /opciones que no son un objeto literal/],
      ['una const tapada por la variable de un for-of', "const limite = 100;\nfor (const limite of [100, 5000]) { await svc.from('transacciones').select('*').limit(limite); }", IRRESOLUBLE],
      ['un alias var dentro de un if, usado afuera', "if (x) { var t = svc.from('transacciones'); }\nawait t.select('*');", SIN],
      ['una tabla en constante y un helper que le pone el select', "const TABLA_TX = 'transacciones';\nconst delUsuario = (q, id) => q.select('*').eq('usuario_id', id);\nawait delUsuario(svc.from(TABLA_TX), u);", /tabla no literal/],
      ['un .in(id) dentro de una página mal armada', "await todasLasFilas((d, h, p) => svc.from('transacciones').select('fecha, monto_pen, comercio', p ? { count: 'exact' } : undefined).in('id', ids).order('fecha').range(d, h), (t) => `${t.fecha}|${t.monto_pen}|${t.comercio}`);", /orden que termine en id/],
      ['la página que pisa su parámetro', "await todasLasFilas((desde, hasta, p) => { if (x) desde = 0; return svc.from('transacciones').select('*', p ? { count: 'exact' } : undefined).order('id').range(desde, hasta); }, (t) => t.id);", /pisa sus propios parámetros/],
      ['un TAMANO_PAGINA local que tapa el requerido', "const TAMANO_PAGINA = 5000;\nawait svc.from('transacciones').select('*').limit(TAMANO_PAGINA);", IRRESOLUBLE],
      ['un todasLasFilas inyectado como parámetro', "async function g(todasLasFilas) { return todasLasFilas((d, h, p) => svc.from('transacciones').select('*', p ? { count: 'exact' } : undefined).order('id').range(d, h), (t) => t.id); }\nawait g(null);", FUERA_DE_TODAS],
      ['un var izado que tapa una const chica', "const LIMITE = 50;\nasync function g(c) { if (c) { var LIMITE = 5000; } return svc.from('transacciones').select('*').limit(LIMITE); }\nawait g(x);", IRRESOLUBLE],
      ['una tabla por variable con select', "const T = 'transacciones';\nawait svc.from(T).select('*');", /tabla no literal/],
      ['un cliente llamado storage (no es svc.storage)', "const storage = svc;\nawait storage.from(options.tabla).select('*');", /tabla no literal/],
      // Propias de CommonJS.
      ['un todasLasFilas requerido de OTRO módulo en un ámbito interno', "async function g() { const { todasLasFilas } = require('./paginador-propio'); return todasLasFilas((d, h, p) => svc.from('transacciones').select('*', p ? { count: 'exact' } : undefined).order('id').range(d, h), (t) => t.id); }\nawait g();", FUERA_DE_TODAS],
      ['un var izado que tapa el todasLasFilas requerido', "if (x) { var todasLasFilas = async (c) => c(0, 99999, true); }\nawait todasLasFilas((d, h, p) => svc.from('transacciones').select('*', p ? { count: 'exact' } : undefined).order('id').range(d, h), (t) => t.id);", FUERA_DE_TODAS],
      ['el paginador con let (se puede reasignar)', `todasLasFilas = async (c) => c(0, 99999, true);\nawait todasLasFilas(${PAG}.order('id').range(d, h), (t) => t.id);`, FUERA_DE_TODAS, '', "let { todasLasFilas, TAMANO_PAGINA } = require('../lib/todas-las-filas');"],
      ['el paginador requerido dentro de una función', `const { todasLasFilas: pag } = require('../lib/todas-las-filas');\nawait pag(${PAG}.order('id').range(d, h), (t) => t.id);`, FUERA_DE_TODAS, '', '// sin require arriba'],
      ['un alias del paginador', `const paginar = todasLasFilas;\nawait paginar(${PAG}.order('id').range(d, h), (t) => t.id);`, FUERA_DE_TODAS],
      ['un TAMANO_PAGINA de otro módulo', "await svc.from('transacciones').select('*').limit(TAMANO_PAGINA);", IRRESOLUBLE, '', "const { TAMANO_PAGINA } = require('./otro-modulo');"],
      // Quinta ronda (la primera sobre el port CJS), todas ejecutadas con el guard verde.
      ['(E1) un .limit(TAMANO_PAGINA) sobre una suma', "const { data } = await svc.from('transacciones').select('monto_pen').eq('usuario_id', u).limit(TAMANO_PAGINA);", IRRESOLUBLE],
      ['(E1) un .limit(1000) literal', "await svc.from('transacciones').select('monto_pen').eq('usuario_id', u).limit(1000);", GRANDE],
      ['(E1) un .limit(999)', "await svc.from('transacciones').select('monto_pen').eq('usuario_id', u).limit(999);", GRANDE],
      ['(E1) un .range de una página entera', "await svc.from('transacciones').select('*').range(0, 999);", /más ancho que un top-N/],
      ['(E5) un loop a mano de a 1000 con orden inestable', "for (let desde = 0; ; desde += 1000) { const { data } = await svc.from('transacciones').select('id, monto_pen').eq('usuario_id', u).order('fecha', { ascending: false }).range(desde, desde + 999); if (data.length < 1000) break; }", /más ancho que un top-N/],
      ['(E3) un cliente de base inyectado como this.storage', "class Repo { constructor({ storage }) { this.storage = storage; } async todas(id) { return this.storage.from(options.tabla).select('*').eq('usuario_id', id); } }", /tabla no literal/],
      ['(E4) una copia local del paginador con el mismo nombre', `await todasLasFilas(${PAG}.order('id').range(d, h), (t) => t.id);`, FUERA_DE_TODAS, '', "const { todasLasFilas } = require('./todas-las-filas');"],
      ['(E4) el paginador de la webapp requerido por ruta', `await todasLasFilas(${PAG}.order('id').range(d, h), (t) => t.id);`, FUERA_DE_TODAS, '', "const { todasLasFilas } = require('../webapp/src/lib/supabase/todas-las-filas');"],
      ['(E6) un spread de PostgREST en la página', "await todasLasFilas((d, h, p) => svc.from('transacciones').select('id, fecha, monto_pen, ...categorias(id, nombre)', p ? { count: 'exact' } : undefined).eq('usuario_id', u).order('fecha').order('id').range(d, h), (t) => t.id);", /spread en el select/],
      ['(E7) un import ESM del CJS congelado', `await paginacion.todasLasFilas(${PAG}.order('id').range(d, h), (t) => t.id);`, FUERA_DE_TODAS, '', "import * as paginacion from '../lib/todas-las-filas.js';"],
      ['(E7) un .limit con la constante por import ESM', "await svc.from('transacciones').select('*').limit(paginacion.TAMANO_PAGINA);", IRRESOLUBLE, '', "import * as paginacion from '../lib/todas-las-filas.js';"],
      ['un builder exportado por exports.x', "exports.tx = svc.from('transacciones').select('*').eq('usuario_id', u).limit(10);", SALE],
      ['un builder exportado por module.exports', "module.exports = { tx: () => svc.from('transacciones').select('*').eq('usuario_id', u).limit(10) };", SALE],
      ['un builder devuelto por una function no async', "function tx() { return svc.from('transacciones').select('*').limit(10); }\nawait tx().limit(5000);", SALE],
      ['un alias de la tabla en el tope del archivo, exportado', '', SIN, "const tablaTx = supabase.from('transacciones');\nmodule.exports = { tablaTx };"],
    ])('ve %s', (_n, cuerpo, motivo, arriba = '', cabecera = CABECERA) => {
      const motivos = caso(cuerpo, arriba, cabecera);
      expect(motivos.length, JSON.stringify(motivos)).toBeGreaterThanOrEqual(1);
      expect(motivos.every((m) => (typeof motivo === 'string' ? m === motivo : motivo.test(m))), JSON.stringify(motivos)).toBe(true);
    });

    // Y no grita sobre lo que está bien: un detector que marca todo lleva a llenar EXENCIONES
    // y deja de mirar.
    it.each([
      ['todasLasFilas con .range', `await todasLasFilas(${PAG}.order('id').range(d, h), (t) => t.id);`],
      ['todasLasFilas requerido con otro nombre', "await paginar((d, h, p) => svc.from('transacciones').select('id, monto', p ? { count: 'exact' } : undefined).order('id').range(d, h), (t) => t.id);", '', "const { todasLasFilas: paginar } = require('../lib/todas-las-filas');"],
      ['(FP) namespace desestructurado en el tope', `await todasLasFilas(${PAG}.order('id').range(d, h), (t) => t.id);`, '', "const paginacion = require('../lib/todas-las-filas');\nconst { todasLasFilas } = paginacion;"],
      ['un .mjs con createRequire', `await todasLasFilas(${PAG}.order('id').range(d, h), (t) => t.id);`, '', "import { createRequire } from 'module';\nconst require = createRequire(import.meta.url);\nconst { todasLasFilas } = require('../lib/todas-las-filas');"],
      ['todasLasFilas por namespace', "await paginacion.todasLasFilas((d, h, p) => svc.from('transacciones').select('*', p ? { count: 'exact' } : undefined).order('id').range(d, h), (t) => t.id);", '', "const paginacion = require('../lib/todas-las-filas.js');"],
      ['la página con return en vez de cuerpo de expresión', "await todasLasFilas((d, h, p) => { return svc.from('transacciones').select('*', p ? { count: 'exact' } : undefined).order('id').range(d, h); }, (t) => t.id);"],
      ['la página con el cuerpo entre paréntesis', "await todasLasFilas((d, h, p) => (\n  svc.from('transacciones').select('*', p ? { count: 'exact' } : undefined).order('id').range(d, h)\n), (t) => t.id);"],
      ['la página con orden fecha, created_at e id', "await todasLasFilas((d, h, p) => svc.from('transacciones').select('id, monto_pen, fecha', p ? { count: 'exact' } : undefined).eq('usuario_id', u).gte('fecha', '2026-01-01').order('fecha', { ascending: false }).order('created_at', { ascending: false }).order('id', { ascending: false }).range(d, h), (t) => t.id);"],
      ['un conteo', "await svc.from('transacciones').select('id', { count: 'exact', head: true }).eq('usuario_id', u);"],
      ['un conteo en variable con filtros condicionales', "let q = svc.from('transacciones').select('*', { count: 'exact', head: true });\nif (x) q = q.eq('tipo', 'g');\nawait q;"],
      ['un conteo devuelto por una función exportada', "return 1;\n}\nfunction contarTx(svc, u) { return svc.from('transacciones').select('id', { count: 'exact', head: true }).eq('usuario_id', u);"],
      ['una por id devuelta por una función no async', "return 1;\n}\nfunction unaTx(svc, id) { return svc.from('transacciones').select('*').eq('id', id).single();"],
      ['por id', "await svc.from('transacciones').select('*').eq('id', u).single();"],
      ['por maybeSingle', "await svc.from('transacciones').select('id').eq('usuario_id', u).eq('gmail_msg_id', x).maybeSingle();"],
      ['por lista de ids', "await svc.from('transacciones').select('comercio').in('id', ids).eq('usuario_id', u);"],
      ['una escritura sin select', "await svc.from('transacciones').update({ a: 1 }).eq('usuario_id', u);"],
      ['un insert que devuelve UNA fila', "await svc.from('transacciones').insert({ a: 1 }).select('id').single();"],
      ['un borrado', "await svc.from('transacciones').delete().eq('id', u);"],
      ['un borrado por alias', "const base = svc.from('transacciones');\nconst op = x ? base.delete() : base.update({ a: 1 });\nawait op.eq('usuario_id', u);"],
      ['una tabla por variable que sólo escribe, por alias', "const base = svc.from(options.tabla);\nconst op = x ? base.delete() : base.update({ a: 1 });\nawait op.eq('usuario_id', u);"],
      ['otra tabla', "await svc.from('presupuestos').select('*');"],
      ['otra tabla cuyo nombre contiene transacciones', "await svc.from('transacciones_eliminadas').select('*').eq('usuario_id', u);"],
      ['un embebido de otra tabla que no es transacciones', "await svc.from('transacciones').select('*, categorias(nombre)').eq('id', u).single();"],
      ['Array.from', 'Array.from(new Set([1])).map((n) => n);'],
      ['Buffer.from con una variable', "Buffer.from(u).toString('base64');"],
      ['un bucket de Storage', "await supabase.storage.from(options.bucket).list(u, { limit: 1000 });"],
      ['un .in(id) dentro de una página bien armada', "await todasLasFilas((d, h, p) => svc.from('transacciones').select('*', p ? { count: 'exact' } : undefined).in('id', ids).order('id').range(d, h), (t) => t.id);"],
    ])('no marca %s', (_n, cuerpo, arriba = '', cabecera = CABECERA) => {
      expect(caso(cuerpo, arriba, cabecera)).toEqual([]);
    });

    // Un top-N bien armado no es rojo por su forma: es rojo hasta que alguien lo DECLARA en TOP_N,
    // porque solo quien lo escribe sabe si la respuesta muestra N filas o las suma.
    it.each([
      ['un limit chico', "await svc.from('transacciones').select('*').limit(5);"],
      ['un limit por constante chica de un ámbito de arriba', "const MAX = 2 * 3;\nconst g = async () => svc.from('transacciones').select('*').limit(MAX);\nawait g();"],
      ['un limit chico dentro de Promise.all', "await Promise.all([svc.from('transacciones').select('*').limit(5), svc.from('x').select('*')]);"],
      ['un limit chico con .then', "svc.from('transacciones').select('*').limit(5).then((r) => r);"],
      ['un limit chico devuelto por una async function', "async function ultimas() { return svc.from('transacciones').select('*').order('fecha').limit(5); }\nawait ultimas();"],
      ['un range chico', "await svc.from('transacciones').select('*').order('fecha').range(0, 49);"],
      ['un Math.min con un tope chico', "await svc.from('transacciones').select('*').limit(Math.min(options.pedido || 50, 80));"],
      ['un ternario de cadenas acotadas dentro del await', "await (x ? svc.from('transacciones').select('*').order('fecha').limit(10) : svc.from('transacciones').select('*').order('monto').limit(10));"],
      ['paginación de UI con desde + N - 1', "const POR_PAGINA = 20;\nconst desde = options.pagina * POR_PAGINA;\nawait svc.from('transacciones').select('*').order('fecha').range(desde, desde + POR_PAGINA - 1);"],
    ])('pide declarar como top-N %s', (_n, cuerpo, arriba = '', cabecera = CABECERA) => {
      expect(caso(cuerpo, arriba, cabecera)).toEqual(expect.arrayContaining([TOPN_SIN_DECLARAR]));
      expect(caso(cuerpo, arriba, cabecera).every((m) => m === TOPN_SIN_DECLARAR)).toBe(true);
    });

    it('un .limit(1) no pide declaración: una fila no tiene suma que cortar', () => {
      expect(caso("await svc.from('transacciones').select('id').eq('usuario_id', u).order('created_at', { ascending: false }).limit(1);")).toEqual([]);
    });

    it('(A12, ronda 7) barre lo que Node puede correr aunque no tenga extensión .js', () => {
      const dir = mkdtempSync(join(tmpdir(), 'guard-pag-'));
      try {
        mkdirSync(join(dir, 'bin'));
        const leer = "supabase.from('transacciones').select('monto_pen');\n";
        writeFileSync(join(dir, 'bin', 'recalcular'), '#!/usr/bin/env node\n' + leer);
        writeFileSync(join(dir, 'bin', 'sin-shebang'), leer);
        writeFileSync(join(dir, 'bin', 'otra.v2'), '#!/usr/bin/nodejs\n' + leer);
        writeFileSync(join(dir, 'bin', 'LEEME'), 'texto sin la tabla\n');
        writeFileSync(join(dir, 'bin', 'por-arg.v2'), "const t = process.argv[2];\nsupabase.from(t).select('monto_pen');\n");
        writeFileSync(join(dir, 'bin', 'notas.md'), leer);
        expect(archivos(dir).map((f) => relative(dir, f).replace(/\\/g, '/')).sort()).toEqual(['bin/otra.v2', 'bin/por-arg.v2', 'bin/recalcular', 'bin/sin-shebang']);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  it('ninguna lectura de transacciones del backend queda sin cota', () => {
    const culpables = todos.filter((h) => !exenta(h)).map((h) => `${h.rel}:${h.linea}  ${h.motivo}\n    ${h.consulta}`);
    expect(
      culpables,
      'Una lectura de transacciones sin cota devuelve como mucho 1000 filas sin avisar. Si necesita ' +
        'todas, pásala a `todasLasFilas` (lib/todas-las-filas.js) con un orden que termine en `id` y ' +
        'clave `(t) => t.id`. Si de verdad está acotada por otra razón, ciérrala con un .limit o ' +
        'agrégala a EXENCIONES con su motivo y una premisa que se pueda verificar.',
    ).toEqual([]);
  });

  it('(R3) una lectura declarada que se reescribe por adelante o por atrás deja de calzar', () => {
    const e = TOP_N[0];
    const h = (consulta) => ({ rel: e.archivo, linea: 1, consulta, motivo: TOPN_SIN_DECLARAR });
    expect(declaradoTopN(h(e.consulta))).toBe(true);
    expect(declaradoTopN(h(e.consulta + '.range(0,99)'))).toBe(false);
    expect(declaradoTopN(h(e.consulta.replace(".select('*').eq('usuario_id',usuarioId)", ".select('monto_pen')")))).toBe(false);
  });

  it.each(TOP_N)('el top-N declarado de $archivo sigue calzando con UNA lectura', (e) => {
    const calzan = todos.filter((h) => h.motivo === TOPN_SIN_DECLARAR && h.rel === e.archivo && h.consulta === e.consulta);
    expect(calzan, `top-N vencido: "${e.consulta}" ya no está en ${e.archivo}`).toHaveLength(1);
  });

  it.each(EXENCIONES.length ? EXENCIONES : [null])('la exención %# sigue calzando con UNA lectura y su premisa se cumple', (e) => {
    if (!e) return;
    const calzan = todos.filter((h) => h.rel === e.archivo && h.consulta === e.consulta);
    expect(calzan, `exención vencida: "${e.consulta}" ya no está en ${e.archivo}`).toHaveLength(1);
    const contenido = fuentes.find((f) => f.rel === e.archivo).contenido;
    expect(e.premisa(contenido), `la premisa de la exención ya no se cumple: ${e.motivo}`).toBe(true);
  });
});
