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
 * **Es un port, no una versión nueva, y eso es a propósito.** Los dos guards pasaron ocho rondas
 * de ataque adversarial entre los dos (01-oct-2026, `docs/DEFECTOS.md`). La última sincronización
 * es la de 8947a64: la webapp cerró 22 huecos que acá siguieron verdes hasta que se ejecutaron como
 * fixtures `(W*)`. Usa el mismo parser (`typescript`, devDependency de la raíz solo para esto: el CI
 * del backend no instala la webapp). **Falla cerrado**: seguir el builder por variables y funciones
 * dejó verdes 13 y 7 evasiones en dos revisiones seguidas, así que no sigue nada. Mira la cadena que
 * nace en `.from('transacciones')` y acepta tres cosas, las tres en una cadena CERRADA (se ejecuta
 * ahí mismo: `await` directo, también a través de un ternario, elemento de un `Promise.all([...])`,
 * retorno de una función `async`, o un `.then(...)`):
 *
 * 1. **Una cota que nada posterior puede deshacer**: `.single()`, `.maybeSingle()`,
 *    `.eq('id', …)`, `.in('id', …)` o `head: true` con `count: 'exact'` en el PRIMER `select`. Desde
 *    el 01-oct también tiene que estar cerrada: guardada en una variable se deshacía por fuera de la
 *    cadena (`q = q.setHeader(…)`, `q = q.csv()`, `Object.assign(q, { method: 'GET' })`).
 * 2. **La página de `todasLasFilas`, con UNA forma**: termina en `.range(desde, hasta)` con los
 *    parámetros de la página, que nadie pisa y que solo se LEEN ahí y en la condición del conteo; con
 *    cuerpo de bloque, una sola sentencia; sin `.limit`; sus `.order` con columna literal y a lo sumo
 *    `{ ascending }` literal, y el último es por `id`; UN solo `select` de texto estático, leído como
 *    lo manda postgrest-js (sin los espacios de fuera de comillas), sin comillas, sin spread, sin
 *    alias `id:` en ningún nivel, con `id` o `*` entre sus columnas PROPIAS; `count: 'exact'`
 *    condicionado al TERCER parámetro; y la clave exactamente `(t) => t.id`.
 * 3. **`.limit(1)` (resuelto exacto), o un TOP-N DECLARADO en `TOP_N`**, como ÚLTIMO limitador. El
 *    top-N tiene que resolverse a <= `TOPE_TOP_N` (100): `.limit(n)` con `n` literal o `const` del
 *    ámbito con aritmética exacta, `Math.min` como cota solo arriba de todo (dentro de una resta la
 *    cota se invierte) y solo si nadie liga ni asigna `Math`, o un `.range` con los DOS extremos
 *    resueltos.
 *
 *    **Acá el backend fue más estricto que la webapp primero, y lo decidieron dos ataques que
 *    encontraron la MISMA clase.** Con el tope en 1000 pasaba `.limit(TAMANO_PAGINA)` sobre una SUMA;
 *    con el tope en 100, `.limit(100)` sobre una suma mensual (el usuario más grande ya hace ~135 por
 *    mes). Ningún tope sintáctico separa "las 5 últimas" de "sumá el mes": lo separa quien lo escribe,
 *    así que cada top-N va a `TOP_N` con su motivo y anclado al texto ENTERO de su cadena.
 *
 * Todo lo demás es rojo: un builder que sale a una variable, un argumento, una propiedad o un
 * `exports.x`, aunque lleve un `.limit(10)` perfecto. Si de verdad está bien, va a EXENCIONES con una
 * premisa anclada al bloque ENTERO (sin comentarios) y que cuenta identificadores por AST.
 *
 * **Y lo que cambia una consulta por fuera de su cadena es rojo en cualquier archivo del barrido**:
 * `transacciones` embebida desde otra tabla, buscada en todo texto estático del archivo (constantes,
 * `+`, templates, el nombre de la FK y varios hints) después de borrar los espacios como postgrest-js;
 * un `.select()` con columnas que no son texto estático; `.setHeader`, el header `Prefer`,
 * `.csv/.geojson/.explain` y asignar `method/url/headers/fetch/…`; una llamada por clave que no se
 * puede leer; `Object.assign`/`defineProperty`/`setPrototypeOf` sobre un objeto que no sea un `const`
 * literal; `eval`, `Function`, `Reflect` y `vm`; `.from.bind/call/apply`; y un cliente de Supabase
 * con `fetch`, `headers`, `global`, `db` u opciones que no se pueden leer, seguido por la LIGADURA del
 * `require` (o el `import` de un `.mjs`), no por el nombre. La tabla tiene que ser un identificador
 * limpio (`/^[a-z_][a-z0-9_]*$/`): postgrest-js arma la URL con `new URL`, que recorta, borra tabs,
 * pasa `\` a `/` y decodifica `%74`. No hay excepción de Storage: se decidía por el TEXTO del
 * receptor, y los buckets reales son literales.
 *
 * **Lo que cambia respecto de la webapp, todo por CommonJS:**
 * - `todasLasFilas` se reconoce por un `const { … } = require(X)` (o `const ns = require(X)` y
 *   `ns.todasLasFilas`, o `const { … } = ns`) en el TOPE del archivo, donde X **resuelto desde el
 *   archivo** es `lib/todas-las-filas`, y el nombre tiene que estar ligado UNA sola vez en el archivo.
 *   El módulo exporta un objeto congelado, así que tampoco se le puede pisar la propiedad.
 * - **`import` ESM NO se reconoce**: un `.mjs` que importa el CJS congelado no recibe exports con
 *   nombre (medido en Node 24: `ns.TAMANO_PAGINA` es `undefined`). Un `.mjs` usa `createRequire`.
 * - **`require` es la puerta por la que llega el cliente, así que se vigila como tal**: un specifier
 *   que no es texto estático, `require` usado como valor, `require.cache`, `x.require(…)`,
 *   `require('module')`/`vm` y un `createRequire` ligado a otro nombre son rojos. El único `require`
 *   dinámico del árbol (el auto-loader de `handlers/intents/`) va a EXENCIONES.
 * - `Object.assign`, las asignaciones a `headers`/`url`/… y las llamadas por clave dinámica se
 *   aceptan sobre un objeto plano propio: un nombre cuya ligadura más cercana es `const x = { … }`, sin
 *   un `var` izado que lo tape. Es el `updates` de las ediciones, el `payload` de Resend y la tabla de
 *   copys de un script; ninguno puede ser un builder. Y una clave dinámica pasa si todas sus formas
 *   posibles se conocen y ninguna es un método de consulta (`log[grave ? 'error' : 'info']`).
 * - No hay `PASAN_COLUMNAS`: ningún helper del backend recibe columnas para un `.select()`.
 *
 * Lo que NO ve, declarado: `.in('id', lista)` no mira el largo de la lista; `.rpc()`, un `fetch`
 * directo a `/rest/v1/transacciones` y las vistas quedan fuera; un wrapper propio de `todasLasFilas`
 * es rojo; un embebido por el nombre de una FK que no contenga `transacciones` (hoy la única es
 * `transacciones_usuario_id_fkey`); y un humano puede declarar en TOP_N una lectura que en realidad
 * suma. Lo que es del CLIENTE o de la PÁGINA en runtime (un fetch que repite páginas, un filtro que
 * cambia entre páginas, una clave que no es única, un borrado entre páginas) lo cierra además
 * `todasLasFilas`, que devuelve error cuando llegan menos filas distintas que el conteo.
 *
 * El barrido es lista NEGRA, como `railway.json`: fuera quedan `webapp/` (su propio guard), `tests/`
 * y `qa-e2e/` (no corren en el servidor), y un test falla si un archivo del barrido requiere algo de
 * ahí. Los `.test.js` de cualquier otra carpeta ENTRAN: el auto-loader de intents carga todo `.js`.
 *
 * Falsos positivos conocidos, a propósito (fallar cerrado cuesta escribir de una forma): una página
 * con filtros condicionales (`let q`), `{}` en vez de `undefined` en el conteo,
 * `.throwOnError()`/`.abortSignal()` después del `.range`, la clave `({ id }) => id`, un conteo
 * guardado en una variable, y `Promise.race` o un `.map` no async dentro de `Promise.all`.
 */

const TABLAS = new Set(['transacciones']);
// Literales a propósito, NO la constante del helper: si alguien sube `TAMANO_PAGINA` a 5000 "para
// hacer menos viajes", el helper sigue bien (avanza por lo recibido) pero un guard atado a esa
// constante pasaría a aceptar `.limit(5000)`, que PostgREST corta en 1000.
const MAX_ROWS = 1000; // el `max_rows` de PostgREST en este proyecto (medido: content-range 0-999/3535)
const TOPE_TOP_N = 100;
const MODULO = 'lib/todas-las-filas';
const SALE = 'el builder sale de la cadena (variable, argumento, ternario, propiedad) y alguien puede pisarle el límite: ciérrala en el lugar o va a EXENCIONES';
const TOPN_SIN_DECLARAR = 'un .limit/.range de top-N sin declarar en TOP_N: si la respuesta SUMA o CUENTA estas filas, va por todasLasFilas';
const SIN_COTA = 'sin .range/.limit/head:true/filtro por id';
const TABLA_NO_LITERAL = 'tabla no literal que lee: no se puede saber que no es transacciones';
const EMBEBIDO = 'embebe transacciones desde otra tabla: PostgREST corta el embebido en 1000 igual';
const SELECT_DINAMICO = 'un .select() con columnas que no son texto estático: no se puede saber si embebe transacciones';
const CLAVE_DINAMICA = 'una llamada por una clave que no es texto estático: puede ser un select, un limit o un from';
const TOCA_LA_CONSULTA = 'cambia el estado de una consulta por fuera de su cadena (header Prefer, setHeader, method/url/headers, Object.assign): puede pisar el conteo o el límite';
/** Propiedades del builder de postgrest-js que, asignadas, cambian lo que se pide. */
const ESTADO_DE_CONSULTA = new Set(['method', 'url', 'headers', 'isMaybeSingle', 'fetch', 'schema', 'signal', 'rest']);
const CLIENTE_RARO = 'un cliente de Supabase con fetch, headers u opciones que no se pueden leer, o usado fuera de una llamada directa: cambia todas sus consultas';
const PAQUETES_SUPABASE = new Set(['@supabase/supabase-js', '@supabase/ssr', '@supabase/postgrest-js']);
const OPCIONES_DE_CLIENTE = new Set(['global', 'fetch', 'headers', 'db', 'accessToken']);
const REFLEXION = 'código armado en un string o llamado por reflexión (eval, Function, Reflect, vm): no se puede saber qué consulta hace';
const POR_BIND = 'un .from por bind/call/apply: la consulta no se puede seguir';
const REQUIRE_OPACO = 'un require que no se puede seguir (specifier dinámico, require como valor, require.cache, x.require, require de module, createRequire con otro nombre): puede traer un cliente de Supabase o pisar un módulo por un camino que el guard no ve';
/** Módulos de Node que ejecutan código o reemplazan módulos: `vm` es un `eval`, `module` reescribe `require`. */
const MODULOS_PELIGROSOS = { vm: REFLEXION, 'node:vm': REFLEXION, module: REQUIRE_OPACO, 'node:module': REQUIRE_OPACO };

const sinEspaciosTexto = (c) => c.replace(/\s+/g, '');

/**
 * El archivo como lo ejecuta Node, sin comentarios ni espacios: lo que ancla una premisa. Con el
 * texto crudo, un bloque con comentarios adentro no se puede anclar entero, y con una regex de
 * comentarios un `'//'` dentro de un string cambia lo que se compara.
 */
function plano(codigo) {
  const sf = ts.createSourceFile('premisa.js', codigo, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  return ts.createPrinter({ removeComments: true }).printFile(sf).replace(/\s+/g, '');
}

/** Cuántas veces aparece el identificador `nombre`, por AST: `\u0071` también es `q`. */
function cuentaIdentificador(codigo, nombre) {
  const sf = ts.createSourceFile('premisa.js', codigo, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  let n = 0;
  const v = (m) => { if (ts.isIdentifier(m) && m.text === nombre) n++; ts.forEachChild(m, v); };
  v(sf);
  return n;
}

/**
 * Lecturas que el guard no puede probar acotadas y están bien por otra razón. Cada una se ancla al
 * TEXTO ENTERO del hallazgo (sin espacios), a los motivos que exime, y a una premisa que se verifica
 * contra el archivo: el bloque entero sin comentarios y sus identificadores contados por AST. Si
 * cambia la consulta la exención deja de calzar, y si cambia la premisa el test de abajo falla.
 */
const EXENCIONES = [
  {
    archivo: 'handlers/intents/transacciones.js',
    consulta: "supabase.from('transacciones').select('*').eq('usuario_id',usuario.id)",
    hallazgos: [SIN_COTA],
    motivo:
      '`qElim` arma con filtros condicionales los CANDIDATOS a eliminar (no un agregado) y termina en ' +
      '`.limit(20)` justo antes del único `await`: las ocho apariciones de `qElim` son esas cinco líneas',
    premisa: (c) =>
      cuentaIdentificador(c, 'qElim') === 8 &&
      plano(c).includes("letqElim=supabase.from('transacciones').select('*').eq('usuario_id',usuario.id);if(comercioElim)qElim=qElim.ilike('comercio','%'+comercioElim+'%');if(fechaElimReq)qElim=qElim.eq('fecha',fechaElimReq);qElim=qElim.order('created_at',{ascending:false}).limit(20);const{data:candidatosElim}=awaitqElim;"),
  },
  {
    archivo: 'cron/checks.js',
    consulta: "supabase.from(tabla).select('usuario_id')",
    hallazgos: [TABLA_NO_LITERAL],
    motivo:
      '`existe(tabla, filtrar)` pregunta si hay UNA fila: el `.limit(1)` va después de `filtrar` y ' +
      'postgrest-js aplica el último limitador; sus dos llamadas solo agregan `.eq`',
    // La función ENTERA y sus dos llamadas, y `existe`/`filtrar` contados por AST: una tercera
    // llamada, un alias o un `filtrar` que agregue algo más que `.eq` dejan de calzar.
    premisa: (c) =>
      cuentaIdentificador(c, 'existe') === 3 && cuentaIdentificador(c, 'filtrar') === 2 &&
      plano(c).includes("constexiste=async(tabla,filtrar)=>{const{data,error}=awaitfiltrar(supabase.from(tabla).select('usuario_id')).limit(1);if(error)thrownewError(tabla+':'+error.message);return(data||[]).length>0;};letactivados,avisados;try{const[tx,avisos]=awaitPromise.all([Promise.all(ids.map((id)=>existe('transacciones',(q)=>q.eq('usuario_id',id)))),Promise.all(ids.map((id)=>existe('notification_deliveries',(q)=>q.eq('tipo','onboarding').eq('usuario_id',id)))),]);"),
  },
  // `scripts/backfill-encrypt-tokens.js` recorre TARGETS, que son `usuarios` y `gmail_cuentas`
  // (tokens de Gmail): la tabla y las columnas salen de ahí, así que el guard ve una tabla no
  // literal y un select de un template.
  ...[
    ['supabase.from(t.table).select(`${t.pk},${t.col}`)', [TABLA_NO_LITERAL, SELECT_DINAMICO]],
    ['supabase.from(p.table).select(`${p.col}`).eq(p.pk,p.id).single()', [TABLA_NO_LITERAL]],
    ['supabase.from(p.table).select(`${p.col}`)', [SELECT_DINAMICO]],
  ].map(([consulta, hallazgos]) => ({
    archivo: 'scripts/backfill-encrypt-tokens.js',
    consulta,
    hallazgos,
    motivo: 'recorre TARGETS, que son `usuarios` y `gmail_cuentas` (tokens de Gmail), con columnas literales',
    premisa: (c) => premisaBackfillTokens(c),
  })),
  {
    archivo: 'handlers/intent-registry.js',
    consulta: 'require(path.join(intentsDir,file))',
    hallazgos: [REQUIRE_OPACO],
    motivo:
      'el auto-loader carga cada `.js` de `handlers/intents/`, y esos archivos están en el barrido (el ' +
      'barrido ya no excluye los `.test.js` de fuera de `tests/`, justamente por este loader)',
    premisa: (c) =>
      cuentaIdentificador(c, 'intentsDir') === 3 && cuentaIdentificador(c, 'file') === 2 && cuentaIdentificador(c, 'require') === 4 &&
      plano(c).includes("constintentsDir=path.join(__dirname,'intents');constfiles=fs.readdirSync(intentsDir).filter(f=>f.endsWith('.js'));for(constfileoffiles){constmod=require(path.join(intentsDir,file));"),
  },
  {
    archivo: 'scripts/inventario-escrituras-intents.mjs',
    consulta: "newFunction('readFileSync','readdirSync','statSync','path','RAIZ',cuerpo+'\\nreturn{lecturas,leeElError};')",
    hallazgos: [REFLEXION],
    motivo:
      'herramienta de análisis estático que no toca la base: compila el parser de ' +
      '`tests/cron/lecturas-leen-el-error.test.js` para no copiarlo, y le pasa solo funciones de fs',
    // Por AST: sus únicos imports son `node:fs` y `node:path`, y no llama ningún `.from(`, `require`
    // ni `import()`. Con texto, el `.from(` de un comentario que documenta el helper ya lo tumbaba.
    premisa: (c) =>
      cuentaIdentificador(c, 'Function') === 1 && cuentaIdentificador(c, 'cuerpo') === 2 && cuentaIdentificador(c, 'construir') === 2 &&
      soloImportaYNoConsulta(c, ['node:fs', 'node:path']) &&
      plano(c).includes("constcuerpo=fuenteGuard.slice(desde,hasta).replace('constRAIZ=process.cwd();','');constconstruir=newFunction('readFileSync','readdirSync','statSync','path','RAIZ',cuerpo+'\\nreturn{lecturas,leeElError};');const{lecturas,leeElError}=construir(readFileSync,readdirSync,statSync,path,RAIZ);"),
  },
];

/** ¿El archivo importa exactamente `permitidos` y no llama `.from(`, `require` ni `import()`? (por AST) */
function soloImportaYNoConsulta(c, permitidos) {
  const sf = ts.createSourceFile('premisa.mjs', c, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const imports = [];
  let llama = false;
  const v = (m) => {
    if (ts.isImportDeclaration(m) || ts.isExportDeclaration(m)) imports.push(m.moduleSpecifier ? m.moduleSpecifier.getText() : '?');
    if (ts.isCallExpression(m) && (m.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(m.expression) && m.expression.text === 'require'))) llama = true;
    if ((ts.isPropertyAccessExpression(m) || ts.isElementAccessExpression(m)) && (ts.isPropertyAccessExpression(m) ? m.name.text : literalTexto(m.argumentExpression)) === 'from') llama = true;
    ts.forEachChild(m, v);
  };
  v(sf);
  return !llama && imports.length === permitidos.length && imports.every((s, i) => s.slice(1, -1) === permitidos[i]);
}

/**
 * TARGETS por AST: cuatro objetos de literales, tablas `usuarios`/`gmail_cuentas` y columnas que son
 * identificadores limpios (ningún `transacciones(…)` puede entrar por `col`). Y `plan`, de donde salen
 * los `p`, solo se llena con `{ ...t }` de esos TARGETS.
 */
function premisaBackfillTokens(c) {
  const sf = ts.createSourceFile('premisa.js', c, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const decl = sf.statements.filter(ts.isVariableStatement).flatMap((s) => [...s.declarationList.declarations])
    .find((d) => ts.isIdentifier(d.name) && d.name.text === 'TARGETS');
  const arr = decl && decl.initializer && ts.isArrayLiteralExpression(decl.initializer) ? decl.initializer.elements : null;
  const limpio = /^[a-z_][a-z0-9_]*$/;
  const objetosOk = !!arr && arr.length === 4 && arr.every((o) => ts.isObjectLiteralExpression(o) && o.properties.every((p) =>
    ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && ts.isStringLiteral(p.initializer) && (
      (p.name.text === 'table' && ['usuarios', 'gmail_cuentas'].includes(p.initializer.text)) ||
      (['pk', 'col'].includes(p.name.text) && limpio.test(p.initializer.text)) ||
      p.name.text === 'tipo')));
  return objetosOk && cuentaIdentificador(c, 'TARGETS') === 2 && cuentaIdentificador(c, 'plan') === 5 && cuentaIdentificador(c, 'cambios') === 4 &&
    plano(c).includes('for(consttofTARGETS){const{data,error}=awaitsupabase.from(t.table).select(`${t.pk},${t.col}`);') &&
    plano(c).includes('plan.push({...t,id:row[t.pk],action,reason,original:value});') &&
    plano(c).includes("constcambios=plan.filter(p=>p.action==='encrypt'||p.action==='null');");
}

/**
 * LOS TOP-N, DECLARADOS UNO POR UNO. Fuera de `todasLasFilas` solo `.limit(1)` pasa solo; todo otro
 * `.limit`/`.range` <= 100 tiene que estar acá, anclado al texto ENTERO de su cadena (sin espacios)
 * y con el motivo de por qué mostrar N filas es lo que la respuesta necesita. Una consulta que
 * cambia deja de calzar y vuelve a rojo, y una entrada que ya no calza con UNA lectura también.
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
const FORMATOS = new Set(['csv', 'geojson', 'explain']);
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

const literalTexto = (n) => (n && ts.isStringLiteralLike(n) ? n.text : null);

/**
 * El nombre del método si `n` es `x.m` o `x[k]`, con `k` resuelto por `clave` (un `const LEER =
 * 'select'` también es `select`).
 */
function nombreMetodo(n, clave = literalTexto) {
  if (ts.isPropertyAccessExpression(n)) return n.name.text;
  if (ts.isElementAccessExpression(n)) return clave(n.argumentExpression);
  return null;
}

/** Sube por `.metodo(...)` encadenados desde `inicio`: la expresión más externa y las llamadas. */
function cadena(inicio, clave = literalTexto) {
  const llamadas = [];
  let actual = inicio;
  for (;;) {
    const acc = actual.parent;
    const metodo = acc && (ts.isPropertyAccessExpression(acc) || ts.isElementAccessExpression(acc)) && acc.expression === actual ? nombreMetodo(acc, clave) : null;
    if (metodo && acc.parent && ts.isCallExpression(acc.parent) && acc.parent.expression === acc) {
      llamadas.push({ metodo, nodo: acc.parent });
      actual = acc.parent;
      continue;
    }
    return { externo: actual, llamadas };
  }
}

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

// Del embebido solo si el VALOR es un literal no vacío: con `{ referencedTable: variable }` y la
// variable en `undefined`, postgrest-js usa el `limit` de PRIMER nivel (medido: `...&limit=5000`).
const deEmbebido = (o) => o instanceof Map && ['referencedTable', 'foreignTable'].some((k) => {
  const v = o.get(k);
  return !!v && ts.isStringLiteralLike(v) && v.text !== '';
});
const nombraEmbebido = (o) => o instanceof Map && (o.has('referencedTable') || o.has('foreignTable'));

/** Lo que postgrest-js hace con las columnas de un `select`: borra los espacios fuera de comillas. */
function limpiarSelect(s) {
  let comillas = false;
  return [...s].map((c) => {
    if (/\s/.test(c) && !comillas) return '';
    if (c === '"') comillas = !comillas;
    return c;
  }).join('');
}

// El nombre de la FK (`transacciones_usuario_id_fkey(`) y varios hints (`!fk!inner(`) también.
const embebeTransacciones = (s) =>
  /(^|[^a-z0-9_$])transacciones[a-z0-9_]*(![a-z0-9_]+)*\(/.test(limpiarSelect(s).replace(/"/g, '').toLowerCase());

/** Las columnas propias de un select ya limpio, sin los embebidos (`categorias(nombre,id)`). */
function columnasPropias(sel) {
  let s = sel;
  for (let prev = ''; prev !== s; ) { prev = s; s = s.replace(/[\w!:.]+\([^()]*\)/g, ''); }
  return s.split(',').map((c) => c.trim()).filter(Boolean);
}

/**
 * `{ count: 'exact' }` o `cond ? { count: 'exact' } : undefined`, leído del AST. Por texto sin
 * espacios, `count: ' exact'` pasaba como `'exact'` y viajaba como `Prefer: count= exact` (sin
 * conteo): el helper caía a la regla débil sin avisar.
 */
function esConteoDePagina(e) {
  if (!e) return false;
  const n = pelar(e);
  const exacto = (o) => {
    const m = opciones(pelar(o));
    return m instanceof Map && m.size === 1 && literalTexto(m.get('count')) === 'exact';
  };
  if (ts.isConditionalExpression(n)) {
    const no = pelar(n.whenFalse);
    return ts.isIdentifier(pelar(n.condition)) && exacto(n.whenTrue) && ts.isIdentifier(no) && no.text === 'undefined';
  }
  return exacto(n);
}

/** Lo que está mal en las opciones de un `select`, o `null`. Un ternario se juzga por sus dos ramas. */
function conteoMalo(e) {
  if (!e) return null;
  const n = pelar(e);
  if (ts.isConditionalExpression(n)) return conteoMalo(n.whenTrue) ?? conteoMalo(n.whenFalse);
  if (ts.isIdentifier(n) && n.text === 'undefined') return null;
  const o = opciones(n);
  if (o === 'sucio') return '.select() con opciones que no son un objeto literal: no se puede saber qué conteo pide';
  if (o instanceof Map && o.has('count') && literalTexto(o.get('count')) !== 'exact') return ".select() con un count que no es 'exact': estimado o planeado, miente pasando las 1000 filas";
  return null;
}

function esFija(l, i) {
  const [a0, a1] = l.nodo.arguments;
  if (l.metodo === 'single' || l.metodo === 'maybeSingle') return true;
  if ((l.metodo === 'eq' || l.metodo === 'in') && literalTexto(a0) === 'id') return true;
  // `head` solo vale en el PRIMER `select`, el de `.from()`: el que viene después es el del
  // TransformBuilder, que ignora las opciones, y la consulta ya quedó en GET.
  if (l.metodo === 'select' && i === 0) {
    // `head: true` sin `count` da `count: null`, y `'estimated'`/`'planned'` devuelven la
    // estimación del planner justo pasando `max_rows`: el único conteo de verdad es `'exact'`.
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

/** ¿`n` es el nombre que se LIGA (import, variable, parámetro, función, clase), no una referencia? */
function esLigadura(n) {
  const p = n.parent;
  if (!p) return false;
  if (ts.isImportSpecifier(p) || ts.isImportClause(p) || ts.isNamespaceImport(p)) return true;
  if ((ts.isVariableDeclaration(p) || ts.isBindingElement(p) || ts.isParameter(p) || ts.isFunctionDeclaration(p) ||
    ts.isFunctionExpression(p) || ts.isClassDeclaration(p) || ts.isClassExpression(p)) && p.name === n) return true;
  return ts.isBindingElement(p) && p.propertyName === n;
}

/**
 * ¿`n` es el nombre de una propiedad (`x.n`, `{ n: … }`)? No es una referencia al nombre ligado,
 * pero `globalThis.eval` SÍ es `eval`: la reflexión no lo salta.
 */
function esNombreDePropiedad(n) {
  const p = n.parent;
  return !!p && (ts.isPropertyAccessExpression(p) || ts.isPropertyAssignment(p) || ts.isMethodDeclaration(p) || ts.isPropertyDeclaration(p)) && p.name === n;
}
const esDeclaracion = (n) => esLigadura(n) || esNombreDePropiedad(n);

/** Los métodos de un builder de postgrest-js o del cliente: una clave que puede ser uno de estos cambia la consulta. */
const METODOS_DE_CONSULTA = new Set(['from', 'rpc', 'schema', 'select', 'insert', 'upsert', 'update', 'delete', 'eq', 'neq', 'gt', 'gte', 'lt', 'lte',
  'like', 'likeAllOf', 'likeAnyOf', 'ilike', 'ilikeAllOf', 'ilikeAnyOf', 'is', 'isDistinct', 'in', 'contains', 'containedBy', 'rangeGt', 'rangeGte',
  'rangeLt', 'rangeLte', 'rangeAdjacent', 'overlaps', 'textSearch', 'match', 'not', 'or', 'filter', 'order', 'limit', 'range', 'abortSignal',
  'single', 'maybeSingle', 'csv', 'geojson', 'explain', 'rollback', 'returns', 'overrideTypes', 'setHeader', 'throwOnError', 'then']);

function analizar(rel, codigo) {
  const kind = /\.tsx$/.test(rel) ? ts.ScriptKind.TSX : /\.ts$/.test(rel) ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const sf = ts.createSourceFile(rel, codigo, ts.ScriptTarget.Latest, true, kind);
  const hallazgos = [];
  let lecturas = 0;
  const lineaDe = (n) => sf.getLineAndCharacterOfPosition(n.getStart()).line + 1;
  const sinEspacios = (n) => n.getText().replace(/\s+/g, '');
  const hallazgo = (n, consulta, motivo) => hallazgos.push({ rel, linea: lineaDe(n), consulta, motivo });

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
  const unica = (nombre) => veces.get(nombre) === 1;

  // `with (obj) { … LIMITE … }` puede tapar cualquier nombre en runtime: con un `with` en el
  // archivo no se resuelve ninguna constante.
  let hayWith = false;
  const buscarWith = (m) => { if (m.kind === ts.SyntaxKind.WithStatement) hayWith = true; ts.forEachChild(m, buscarWith); };
  buscarWith(sf);

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
  /** ¿`d` es exactamente `const require = createRequire(import.meta.url)`? */
  const esRequireDeMjs = (d) => ts.isIdentifier(d.name) && d.name.text === 'require' && (d.parent.flags & ts.NodeFlags.Const) !== 0 &&
    !!d.initializer && d.initializer.getText().replace(/\s+/g, '') === 'createRequire(import.meta.url)';
  const requireConfiable = !reasigna && (!veces.get('require') || (veces.get('require') === 1 && createRequireDeModule && sf.statements.some((s) => ts.isVariableStatement(s) &&
    (s.declarationList.flags & ts.NodeFlags.Const) !== 0 && s.declarationList.declarations.some(esRequireDeMjs))));
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

  /** El inicializador `const` del identificador, si está ligado una sola vez y se puede leer. */
  const constanteDe = (n) => {
    // Un nombre ligado más de una vez en el archivo no se resuelve: `var` se iza, y seguir
    // ámbitos es exactamente lo que la webapp aprendió a no hacer.
    if (hayWith || !unica(n.text)) return null;
    for (let p = n.parent; p; p = p.parent) {
      const l = ligadura(p, n.text);
      if (l === 'opaca') return null;
      if (l) return l;
    }
    return null;
  };

  /**
   * ¿`raiz` (una función o el archivo) declara `nombre` con `var`, o con una `function` dentro de un
   * bloque, en cualquier profundidad que no cruce otra función? Eso se iza hasta `raiz` y tapa lo que
   * haya afuera, aunque `ligadura` no lo vea porque no está en las sentencias directas de un bloque.
   */
  const declaraVar = (raiz, nombre) => {
    let hay = false;
    const v = (m) => {
      if (hay) return;
      if (ts.isFunctionLike(m)) {
        if (ts.isFunctionDeclaration(m) && m.name?.text === nombre) hay = true;
        return;
      }
      if (ts.isVariableDeclarationList(m) && (m.flags & (ts.NodeFlags.Const | ts.NodeFlags.Let)) === 0 &&
        m.declarations.some((d) => nombresLigados(d.name).includes(nombre))) hay = true;
      ts.forEachChild(m, v);
    };
    if (ts.isSourceFile(raiz)) raiz.statements.forEach(v);
    else if (raiz.body) v(raiz.body);
    return hay;
  };

  /**
   * ¿`e` es un objeto plano propio: un literal, o un nombre cuya ligadura MÁS CERCANA es
   * `const x = { … }`? Es el `updates` de las ediciones y el `payload` de Resend: un objeto que nace
   * literal en ese ámbito no es un builder ni un cliente, así que mutarlo no cambia ninguna consulta.
   * No alcanza con "todas las ligaduras del archivo son objetos" (`payload` también es un string en
   * otras dos funciones de `lib/email.js`), así que acá sí se sigue el ámbito, y por eso cada función
   * y el archivo que se cruzan se revisan por un `var` izado que tape el nombre.
   */
  const esObjetoLocal = (e) => {
    const n = e && pelar(e);
    if (!n) return false;
    if (ts.isObjectLiteralExpression(n)) return true;
    if (!ts.isIdentifier(n) || hayWith) return false;
    for (let p = n.parent; p; p = p.parent) {
      if ((ts.isFunctionLike(p) || ts.isSourceFile(p)) && declaraVar(p, n.text)) return false;
      const l = ligadura(p, n.text);
      if (l === 'opaca') return false;
      if (l) return ts.isObjectLiteralExpression(pelar(l));
    }
    return false;
  };

  // `Math.min` solo es el de la plataforma si nadie liga ni asigna `Math` en el archivo.
  let tocaMath = veces.has('Math');
  const buscarMath = (m) => {
    if (ts.isBinaryExpression(m) && m.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && m.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
      /^(globalThis\.|global\.)?Math\b/.test(m.left.getText())) tocaMath = true;
    ts.forEachChild(m, buscarMath);
  };
  buscarMath(sf);

  /**
   * El valor numérico de `e` si se sabe sin ejecutar nada; `null` si no. Con `cota`, también una
   * cota SUPERIOR (`Math.min(x, 80)`), pero solo arriba de todo: dentro de una resta la cota se
   * invierte (`100 - Math.min(x, 99)` puede valer 5000), así que la aritmética exige valores exactos.
   */
  const resolver = (e, prof = 0, cota = false) => {
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
    // `Math.min(x, 80)` nunca pasa de 80, sepa o no cuánto vale `x`.
    if (cota && ts.isCallExpression(n) && !tocaMath && n.expression.getText() === 'Math.min') {
      const cotas = n.arguments.map((a) => resolver(a, prof + 1)).filter((v) => v !== null);
      return cotas.length ? Math.min(...cotas) : null;
    }
    if (!ts.isIdentifier(n)) return null;
    const c = constanteDe(n);
    return c ? resolver(c, prof + 1, cota) : null;
  };

  /** El texto de `e` si se sabe sin ejecutar nada (literales, `+`, templates, `const`); `null` si no. */
  const estatico = (e, prof = 0) => {
    if (!e || prof > 8) return null;
    const n = pelar(e);
    if (ts.isStringLiteralLike(n)) return n.text;
    if (ts.isTemplateExpression(n)) {
      let s = n.head.text;
      for (const span of n.templateSpans) {
        const v = estatico(span.expression, prof + 1);
        if (v === null) return null;
        s += v + span.literal.text;
      }
      return s;
    }
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const a = estatico(n.left, prof + 1);
      const b = estatico(n.right, prof + 1);
      return a === null || b === null ? null : a + b;
    }
    if (ts.isIdentifier(n)) {
      const c = constanteDe(n);
      return c ? estatico(c, prof + 1) : null;
    }
    return null;
  };

  /** Los textos que puede valer `e`: el estático, o las dos ramas de un ternario. `null` si alguno no se sabe. */
  const clavesPosibles = (e, prof = 0) => {
    if (!e || prof > 8) return null;
    const n = pelar(e);
    const s = estatico(n);
    if (s !== null) return [s];
    if (!ts.isConditionalExpression(n)) return null;
    const a = clavesPosibles(n.whenTrue, prof + 1);
    const b = clavesPosibles(n.whenFalse, prof + 1);
    return a === null || b === null ? null : [...a, ...b];
  };

  /** Como `estatico`, pero lo que no se conoce vale vacío: para BUSCAR un embebido, no para leer columnas. */
  const aproximado = (e, prof = 0) => {
    if (prof > 8) return '';
    const n = pelar(e);
    const conocido = estatico(n);
    if (conocido !== null) return conocido;
    if (ts.isTemplateExpression(n)) return n.head.text + n.templateSpans.map((sp) => aproximado(sp.expression, prof + 1) + sp.literal.text).join('');
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken) return aproximado(n.left, prof + 1) + aproximado(n.right, prof + 1);
    return '';
  };

  // Los nombres locales de lo que se trae como VALOR de los paquetes de Supabase: por `require`
  // (desestructurado o como namespace) o por `import` en un `.mjs`. Se sigue la LIGADURA, no el
  // nombre: un alias (`createClient: crear`) o un `new SupabaseClient` esquivaban un chequeo por
  // nombre. Un `require` del paquete que no termina en una declaración que se pueda leer es rojo.
  const clientes = new Set();
  const espaciosClientes = new Set();
  for (const s of sf.statements) {
    if (!ts.isImportDeclaration(s) || !ts.isStringLiteral(s.moduleSpecifier) || !PAQUETES_SUPABASE.has(s.moduleSpecifier.text) || s.importClause?.isTypeOnly) continue;
    if (s.importClause?.name) clientes.add(s.importClause.name.text);
    const b = s.importClause?.namedBindings;
    if (b && ts.isNamespaceImport(b)) espaciosClientes.add(b.name.text);
    if (b && ts.isNamedImports(b)) for (const e of b.elements) if (!e.isTypeOnly) clientes.add(e.name.text);
  }
  const esRequireLlamada = (n) => ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'require';
  const requiresSueltos = [];
  const buscarRequires = (m) => {
    if (esRequireLlamada(m) && m.arguments.length === 1 && PAQUETES_SUPABASE.has(estatico(m.arguments[0]))) {
      const p = subir(m);
      const decl = p && ts.isVariableDeclaration(p) && p.initializer && pelar(p.initializer) === m ? p : null;
      const legible = (e) => !e.dotDotDotToken && ts.isIdentifier(e.name) && (!e.propertyName || ts.isIdentifier(e.propertyName) || ts.isStringLiteralLike(e.propertyName));
      if (decl && ts.isIdentifier(decl.name)) espaciosClientes.add(decl.name.text);
      else if (decl && ts.isObjectBindingPattern(decl.name) && decl.name.elements.every(legible)) for (const e of decl.name.elements) clientes.add(e.name.text);
      else requiresSueltos.push(m);
    }
    ts.forEachChild(m, buscarRequires);
  };
  buscarRequires(sf);
  for (const m of requiresSueltos) hallazgo(m, sinEspacios(subir(m) ?? m).slice(0, 200), CLIENTE_RARO);

  /** ¿Las opciones de este cliente cambian sus consultas, o no se pueden leer? */
  const clienteRaro = (c) => {
    let raro = false;
    (c.arguments ?? []).forEach((a, i) => {
      if (ts.isSpreadElement(a)) { raro = true; return; }
      const o = pelar(a);
      // url y key van primero (en `PostgrestClient`, la url sola): desde ahí son opciones.
      const esOpcion = i >= 2 || ts.isObjectLiteralExpression(o);
      if (!esOpcion) return;
      if (!ts.isObjectLiteralExpression(o)) { raro = true; return; }
      const v = (m) => {
        if (ts.isSpreadAssignment(m) || ts.isComputedPropertyName(m)) raro = true;
        if ((ts.isPropertyAssignment(m) || ts.isShorthandPropertyAssignment(m) || ts.isMethodDeclaration(m)) &&
          OPCIONES_DE_CLIENTE.has(m.name.getText().replace(/['"`]/g, ''))) raro = true;
        ts.forEachChild(m, v);
      };
      v(o);
    });
    return raro;
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

  /**
   * La página de `todasLasFilas` tiene UNA forma aceptada y cualquier otra es roja. Los chequeos
   * sueltos que hubo antes (¿hay un range? ¿algún orden por id?) se evadieron con un `.limit`
   * después del range, un `id` dentro de un embebido y una clave que no era el id.
   */
  const paginaInvalida = (llamadas, pag) => {
    // Con cuerpo de bloque, UNA sentencia: el `return` de la consulta. Un `if (desde >= TOPE)
    // return { data: [] }` antes corta el paginador en la primera página (medido en la webapp: 1000
    // de 1105 con `error: null`), y ese `return` no es una cadena que el guard juzgue.
    if (ts.isBlock(pag.fn.body) && pag.fn.body.statements.length !== 1) return 'la página de todasLasFilas tiene que ser SOLO la consulta: un return temprano corta el paginador';
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
    // Los parámetros se LEEN solo en el `.range()` y en la condición del conteo: un filtro u orden
    // que depende de `primera` (`.lt('fecha', primera ? manana : hoy)`) cambia la consulta entre
    // páginas (medido en la webapp: 1085 y 1089 de 1105).
    const conteoArg = propias.find((l) => l.metodo === 'select')?.nodo.arguments[1];
    const condicion = conteoArg && ts.isConditionalExpression(pelar(conteoArg)) ? pelar(pelar(conteoArg).condition) : null;
    let fuera = false;
    const w = (m) => {
      if (ts.isIdentifier(m) && params.includes(m.text) && m !== pelar(a0) && m !== pelar(a1) && m !== condicion &&
        !(ts.isPropertyAccessExpression(m.parent) && m.parent.name === m) && !(ts.isPropertyAssignment(m.parent) && m.parent.name === m)) fuera = true;
      ts.forEachChild(m, w);
    };
    w(pag.fn.body);
    if (fuera) return 'la página de todasLasFilas usa sus parámetros fuera del .range() y de la condición del conteo';
    const ordenes = propias.filter((l) => l.metodo === 'order');
    if (ordenes.some((o) => !ts.isStringLiteralLike(o.nodo.arguments[0] ?? o.nodo))) return 'un .order de la página con una columna que no es un literal';
    const booleana = (e) => e.kind === ts.SyntaxKind.TrueKeyword || e.kind === ts.SyntaxKind.FalseKeyword;
    for (const o of ordenes) {
      const op = opciones(o.nodo.arguments[1]);
      // El VALOR también literal: `{ ascending: primera }` invierte el orden entre páginas.
      if (op === 'sucio' || (op && [...op.entries()].some(([k, e]) => (k !== 'ascending' && k !== 'nullsFirst') || !booleana(e)))) return 'un .order de la página con opciones que no son { ascending } literal';
    }
    if (literalTexto(ordenes.at(-1)?.nodo.arguments[0]) !== 'id') return 'todasLasFilas sin un orden que termine en id';
    const selects = propias.filter((l) => l.metodo === 'select');
    // postgrest-js: el ÚLTIMO `.select(cols)` pisa las columnas. Uno solo, y es el que se lee.
    if (selects.length !== 1) return 'la página de todasLasFilas con más de un .select: el último pisa las columnas que el guard leyó';
    const crudo = estatico(selects[0].nodo.arguments[0]);
    if (crudo !== null && /["'`]/.test(crudo)) return 'todasLasFilas con comillas en el select: un alias citado (`"id":x`) no se puede leer como columna propia';
    // Lo que viaja, no el texto fuente: `'*, i d:categoria_id'` llega como el alias `id:`.
    const sel = crudo === null ? null : limpiarSelect(crudo);
    const cols = sel === null ? [] : columnasPropias(sel);
    // En cualquier nivel: `'*, id:usuarios(plan)'` es un embebido llamado `id`, y `columnasPropias`
    // lo borraba antes de mirar.
    if (sel !== null && /(^|[,(])id:/.test(sel)) return 'todasLasFilas con un alias `id:` en el select: pisa el id propio y la clave deja de ser la fila';
    if (sel !== null && sel.includes('...')) return 'todasLasFilas con un spread en el select: aplana columnas ajenas en la fila y su `id` pisa el propio';
    if (!cols.includes('*') && !cols.includes('id')) return 'todasLasFilas con un select sin `id` propio: la clave sale undefined y deduplica todo a una fila';
    if (!esConteoDePagina(selects[0].nodo.arguments[1])) return "todasLasFilas sin count: 'exact' en la primera página";
    // Y condicionado a `primera`, el tercer parámetro: con `desde ? … : …` la primera página va sin
    // conteo y el helper cae a la regla débil.
    const conteo = pelar(selects[0].nodo.arguments[1]);
    if (ts.isConditionalExpression(conteo) && pelar(conteo.condition).getText() !== params[2]) return 'todasLasFilas con el count condicionado a algo que no es el tercer parámetro (`primera`)';
    const clave = pag.todas.arguments[1];
    if (!clave || !ts.isArrowFunction(clave) || clave.parameters.length !== 1 || ts.isBlock(clave.body)) return 'todasLasFilas sin la clave (t) => t.id';
    const cuerpo = pelar(clave.body);
    const esId = ts.isPropertyAccessExpression(cuerpo) && cuerpo.expression.getText() === clave.parameters[0].name.getText() && cuerpo.name.text === 'id';
    return esId ? null : 'todasLasFilas sin la clave (t) => t.id';
  };

  /**
   * El ancho de un `.range(a, b)` con los DOS extremos resueltos. `range(desde, desde + 49)` ya no
   * se acepta: con `desde` string `desde + 49` concatena (en la webapp viajó `offset=10&limit=1040`).
   */
  const anchoDeRange = (a0, a1) => {
    const d = resolver(a0);
    const h = resolver(a1);
    return d !== null && h !== null ? h - d + 1 : null;
  };

  /** El veredicto de una cadena de lectura: `null` si está acotada. */
  const veredicto = (externo, llamadas) => {
    // Esto va ANTES de la página: un `.setHeader('Prefer', 'count=planned')` dentro de una página
    // perfecta hacía que el conteo del planner (subestimado) la cortara en la primera. Un conteo
    // `estimated`/`planned` miente justo pasando `max_rows`, y entraba por `.limit(1)` o
    // `.maybeSingle()`. Cualquier `select` con `count` que no sea el literal `'exact'` es rojo.
    for (const l of llamadas.filter((x) => x.metodo === 'select')) {
      const malo = conteoMalo(l.nodo.arguments[1]);
      if (malo) return malo;
    }
    // `.setHeader('Prefer', 'count=planned')` pisa el conteo que pidió el select, y nada en el
    // backend necesita cambiar headers de una lectura de transacciones.
    if (llamadas.some((l) => l.metodo === 'setHeader')) return '.setHeader() en una lectura de transacciones: puede pisar el Prefer del conteo';
    // `.csv()`/`.geojson()`/`.explain()` cambian el `Accept`, y `single`/`maybeSingle` dejan de
    // acotar: `.maybeSingle().csv()` trae un CSV de 1000 líneas con `error: null`.
    const formato = llamadas.find((l) => FORMATOS.has(l.metodo));
    if (formato) return `.${formato.metodo}() en una lectura de transacciones: cambia el formato y single/maybeSingle dejan de acotar`;
    const pag = paginaDe(externo);
    if (pag) return paginaInvalida(llamadas, pag);
    // Una cota fija también tiene que estar CERRADA: guardada en una variable se deshace por fuera
    // de la cadena (`q = q.setHeader(…)`, `q = q.csv()`, `Object.assign(q, { method: 'GET' })`,
    // `q.url.searchParams.delete('id')`). Prohibirlas una por una era tapar el caso.
    if (llamadas.some((l, i) => esFija(l, i))) return cerrada(externo, llamadas) ? null : SALE;
    const hasta = llamadas.findIndex((l) => l.metodo === 'then');
    const propias = hasta === -1 ? llamadas : llamadas.slice(0, hasta);
    let ultimo = null;
    for (const l of propias) {
      if (l.metodo !== 'limit' && l.metodo !== 'range') continue;
      const op = opciones(l.nodo.arguments[l.metodo === 'limit' ? 1 : 2]);
      if (op === 'sucio') return `.${l.metodo}() con opciones que no son un objeto literal: no se puede saber si son del embebido`;
      if (nombraEmbebido(op) && !deEmbebido(op)) return `.${l.metodo}() con un embebido que no es un literal no vacío: postgrest-js lo manda como otra cosa`;
      if (!deEmbebido(op)) ultimo = l;
    }
    if (!ultimo) return SIN_COTA;
    const [a0, a1] = ultimo.nodo.arguments;
    let filas;
    if (ultimo.metodo === 'limit') {
      const n = resolver(a0, 0, true);
      if (n === null) return `.limit(${a0?.getText()}) no se puede resolver a un número`;
      if (n < 1) return `.limit(${n}) no es un número positivo de filas`;
      if (n > TOPE_TOP_N) return `.limit(${n}) pide más de ${TOPE_TOP_N} filas fuera de todasLasFilas: un top-N es chico, y lo que suma va paginado (PostgREST corta en ${MAX_ROWS})`;
      filas = n;
    } else {
      const ancho = anchoDeRange(a0, a1);
      if (ancho === null || ancho < 1 || ancho > TOPE_TOP_N) return `.range() fuera de todasLasFilas más ancho que un top-N (${TOPE_TOP_N}) o que no se resuelve`;
      filas = ancho;
    }
    if (!cerrada(externo, llamadas)) return SALE;
    // Una fila es "¿hay alguna? / ¿cuál es la última?": no hay suma que cortar. Cualquier otro
    // tope puede ser un top-N o una suma recortada, y eso no lo decide la sintaxis: va a TOP_N.
    // Exacto: `Math.min(1, pedido)` tiene cota 1 pero viaja `limit=NaN` o `limit=-5`.
    return ultimo.metodo === 'limit' && filas === 1 && resolver(a0) === 1 ? null : TOPN_SIN_DECLARAR;
  };

  const lee = (llamadas) =>
    !llamadas.some((l) => ESCRITURAS.has(l.metodo)) || llamadas.some((l) => l.metodo === 'select' || l.metodo === 'csv');

  // Lo que puede llevar texto: un literal, un template o una suma de ellos. Se mira el MAYOR (la
  // suma entera, no cada pedazo), que es lo que viaja.
  const textual = (n) => ts.isStringLiteralLike(n) || ts.isTemplateExpression(n) ||
    (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken);
  const dentroDeOtroTexto = (n) => {
    const p = subir(n);
    return !!p && (ts.isTemplateSpan(p) || (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.PlusToken));
  };

  const visitar = (n) => {
    if (ts.isCallExpression(n) && nombreMetodo(n.expression, estatico) === 'from' && n.arguments.length >= 1) {
      // Solo un identificador limpio se compara. postgrest-js arma `new URL(`${url}/${tabla}`)`, y el
      // parser de URL recorta espacios del final, borra tabs, pasa `\` a `/`, normaliza `./` y
      // decodifica `%74`: `'transacciones '`, `'.\\transacciones'` y `'%74ransacciones'` llegan como
      // `transacciones`. Normalizar como `new URL` sería perseguir al parser; cualquier otra cosa vale
      // como tabla no literal. Y sin excepción de Storage: se decidía por el TEXTO del receptor
      // (`const supabase = { storage: cliente }` pasaba), y los buckets del backend son literales.
      const crudo = estatico(n.arguments[0]);
      const tabla = crudo !== null && /^[a-z_][a-z0-9_]*$/.test(crudo) ? crudo : null;
      const receptor = n.expression.expression.getText();
      // `Array.from(x)` no es una consulta, salvo que `Array` sea un nombre del archivo
      // (`const Map = cliente; Map.from(T)`).
      const global = NO_SUPABASE.test(receptor) && !veces.has(receptor);
      if ((tabla === null && !global) || (tabla !== null && TABLAS.has(tabla))) {
        const linea = lineaDe(n);
        const { externo, llamadas } = cadena(n, estatico);
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
            if (ts.isIdentifier(m) && m !== nombre && m.text === nombre.text && !(ts.isPropertyAccessExpression(m.parent) && m.parent.name === m)) usos.push(cadena(m, estatico));
            ts.forEachChild(m, v);
          };
          v(ambito);
        } else {
          usos.push({ externo, llamadas });
        }
        for (const u of usos) {
          if (!lee(u.llamadas)) continue;
          const consulta = sinEspacios(u.externo);
          if (tabla === null) {
            hallazgos.push({ rel, linea, consulta, motivo: TABLA_NO_LITERAL });
            continue;
          }
          lecturas++;
          const motivo = veredicto(u.externo, u.llamadas);
          if (motivo) hallazgos.push({ rel, linea, consulta, motivo });
        }
      }
    }
    // Un `.select()` de cualquier tabla con columnas que no se pueden leer: puede embeber
    // transacciones y no hay forma de saberlo.
    if (ts.isCallExpression(n) && nombreMetodo(n.expression, estatico) === 'select' && n.arguments.length >= 1 && estatico(n.arguments[0]) === null) {
      hallazgo(n, sinEspacios(n), SELECT_DINAMICO);
    }
    // PostgREST le aplica `max_rows` a CADA nodo del árbol (Plan.hs, treeRestrictRange): un
    // `categorias.select('…, transacciones(monto_pen)')` corta el embebido en 1000 sin avisar. Se
    // mira todo texto del archivo, no solo el argumento del select: las columnas pueden venir de una
    // constante o de una suma. Lo que no se conoce vale vacío: `'id, transacciones(' + x` también
    // embebe, y un pedazo vacío es una de las cosas que puede valer.
    if (textual(n) && !dentroDeOtroTexto(n) && embebeTransacciones(aproximado(n))) {
      hallazgo(n, sinEspacios(n), EMBEBIDO);
    }
    // Una llamada por clave que no se puede leer (`consulta[metodo](...)`) puede ser un `select`, un
    // `limit` o un `from`, y no hay forma de saber cuál. Pasa si todas las claves posibles se conocen
    // y ninguna es un método de consulta (`log[grave ? 'error' : 'info'](…)`), o si se llama sobre un
    // objeto plano propio (`const c = { reminder_d3: … }; c[trigger](…)`), que no es un builder.
    if (ts.isCallExpression(n) && ts.isElementAccessExpression(n.expression) && estatico(n.expression.argumentExpression) === null &&
      !ts.isNumericLiteral(pelar(n.expression.argumentExpression))) {
      const posibles = clavesPosibles(n.expression.argumentExpression);
      const inocua = posibles !== null && posibles.every((k) => !METODOS_DE_CONSULTA.has(k));
      if (!inocua && !esObjetoLocal(n.expression.expression)) hallazgo(n, sinEspacios(n), CLAVE_DINAMICA);
    }
    // El estado de una consulta se puede cambiar por fuera de su cadena. Nada en el backend lo
    // necesita, así que es rojo en cualquier lugar (Express pone headers con `res.set`).
    const metodoSuelto = ts.isCallExpression(n) ? nombreMetodo(n.expression, estatico) : null;
    if (metodoSuelto === 'setHeader' || (metodoSuelto !== null && FORMATOS.has(metodoSuelto))) {
      hallazgo(n, sinEspacios(n), TOCA_LA_CONSULTA);
    }
    if (textual(n) && !dentroDeOtroTexto(n) && aproximado(n).trim().toLowerCase() === 'prefer') {
      hallazgo(n, sinEspacios(n), TOCA_LA_CONSULTA);
    }
    if ((ts.isPropertyAssignment(n) || ts.isShorthandPropertyAssignment(n)) && ts.isIdentifier(n.name) && n.name.text.toLowerCase() === 'prefer') {
      hallazgo(n, sinEspacios(n), TOCA_LA_CONSULTA);
    }
    // Asignar `method/url/headers/…` cambia lo que se pide, salvo sobre un objeto plano propio (el
    // `payload` de Resend, que lleva sus `headers`).
    if (ts.isBinaryExpression(n) && n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && n.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
      const izq = pelar(n.left);
      const prop = ts.isPropertyAccessExpression(izq) || ts.isElementAccessExpression(izq) ? nombreMetodo(izq, estatico) : null;
      if (prop !== null && ESTADO_DE_CONSULTA.has(prop) && !esObjetoLocal(izq.expression)) hallazgo(n, sinEspacios(n), TOCA_LA_CONSULTA);
    }
    // Un cliente con `fetch` o headers propios cambia lo que pasa con TODAS sus consultas, y el
    // guard juzga consultas: un fetch que memoiza por ruta le devolvía a la página 2 la página 1. Se
    // sigue la LIGADURA: fuera de la posición de callee (en una variable, un spread) no se puede
    // seguir, y es rojo.
    if (ts.isIdentifier(n) && (clientes.has(n.text) || espaciosClientes.has(n.text)) && !esDeclaracion(n)) {
      let llamada = n;
      if (espaciosClientes.has(n.text) && (ts.isPropertyAccessExpression(n.parent) || ts.isElementAccessExpression(n.parent)) && n.parent.expression === n) llamada = n.parent;
      const p = llamada.parent;
      const esCallee = !!p && (ts.isCallExpression(p) || ts.isNewExpression(p)) && p.expression === llamada;
      if (!esCallee || clienteRaro(p)) hallazgo(n, sinEspacios(esCallee ? p : n.parent).slice(0, 200), CLIENTE_RARO);
    }
    // `require` es la puerta por la que llega el cliente: lo que no se puede leer, o lo que trae
    // módulos que reemplazan `require` o ejecutan código, es rojo.
    if (esRequireLlamada(n) || (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword)) {
      const spec = n.arguments.length === 1 ? estatico(n.arguments[0]) : null;
      if (spec === null) hallazgo(n, sinEspacios(n), REQUIRE_OPACO);
      else if (MODULOS_PELIGROSOS[spec]) hallazgo(n, sinEspacios(n), MODULOS_PELIGROSOS[spec]);
      else if (n.expression.kind === ts.SyntaxKind.ImportKeyword && PAQUETES_SUPABASE.has(spec)) hallazgo(n, sinEspacios(n), CLIENTE_RARO);
    }
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier) && MODULOS_PELIGROSOS[n.moduleSpecifier.text]) {
      // `import { createRequire } from 'module'` es la forma de un `.mjs`; nada más de ahí.
      const b = n.importClause?.namedBindings;
      const soloCreateRequire = !n.importClause?.name && !!b && ts.isNamedImports(b) &&
        b.elements.every((e) => (e.propertyName ?? e.name).text === 'createRequire' && e.name.text === 'createRequire');
      if (!(/^(node:)?module$/.test(n.moduleSpecifier.text) && soloCreateRequire)) hallazgo(n, sinEspacios(n).slice(0, 200), MODULOS_PELIGROSOS[n.moduleSpecifier.text]);
    }
    if (ts.isIdentifier(n) && n.text === 'require' && !esDeclaracion(n)) {
      const p = n.parent;
      const esCallee = ts.isCallExpression(p) && p.expression === n;
      const deLectura = ts.isPropertyAccessExpression(p) && p.expression === n && ['main', 'resolve'].includes(p.name.text);
      if (!esCallee && !deLectura) hallazgo(n, sinEspacios(p).slice(0, 200), REQUIRE_OPACO);
    }
    if (ts.isPropertyAccessExpression(n) && n.name.text === 'require') hallazgo(n, sinEspacios(n.parent).slice(0, 200), REQUIRE_OPACO);
    if (ts.isIdentifier(n) && n.text === 'createRequire' && !esDeclaracion(n)) {
      const call = n.parent;
      const decl = ts.isCallExpression(call) && call.expression === n ? subir(call) : null;
      if (!(decl && ts.isVariableDeclaration(decl) && esRequireDeMjs(decl))) hallazgo(n, sinEspacios(n.parent).slice(0, 200), REQUIRE_OPACO);
    }
    // Lo que muta un objeto que ya existe por la puerta de atrás: `Object.assign(q, { method:
    // 'GET' })`, `Object.assign(globalThis, { fetch })`. Sobre un objeto plano propio (`const
    // updates = { … }`) pasa, y también por alias (`const { assign } = Object` es rojo).
    if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'Object' && !veces.has('Object') &&
      ['assign', 'defineProperty', 'defineProperties', 'setPrototypeOf'].includes(n.name.text)) {
      const call = n.parent;
      const esCallee = ts.isCallExpression(call) && call.expression === n;
      const destino = esCallee ? call.arguments[0] : null;
      if (!esCallee || n.name.text !== 'assign' || !esObjetoLocal(destino)) hallazgo(n, sinEspacios(esCallee ? call : n.parent).slice(0, 200), TOCA_LA_CONSULTA);
    }
    if (ts.isElementAccessExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'Object' && !veces.has('Object')) {
      const k = estatico(n.argumentExpression);
      if (k === null || ['assign', 'defineProperty', 'defineProperties', 'setPrototypeOf'].includes(k)) hallazgo(n, sinEspacios(n.parent).slice(0, 200), TOCA_LA_CONSULTA);
    }
    if (ts.isIdentifier(n) && n.text === 'Object' && !veces.has('Object') && !esDeclaracion(n) &&
      !((ts.isPropertyAccessExpression(n.parent) || ts.isElementAccessExpression(n.parent)) && n.parent.expression === n)) {
      hallazgo(n, sinEspacios(n.parent).slice(0, 200), TOCA_LA_CONSULTA);
    }
    // Código en un string no se puede analizar (`new Function('svc', "return svc.from(…)")`), y el
    // nombre no hace falta llamarlo para usarlo: `const compilar = Function`, `globalThis.eval`,
    // `(0, eval)(x)`. Ni `Reflect`, que llama `.from` sin que se vea una llamada.
    if (ts.isIdentifier(n) && ['Function', 'eval', 'Reflect'].includes(n.text) && !esLigadura(n)) {
      hallazgo(n, sinEspacios(n.parent).slice(0, 200), REFLEXION);
    }
    // `svc.from.bind(svc)`, `.call`, `.apply`: el `from` sin llamarlo ahí.
    if (ts.isPropertyAccessExpression(n) && n.name.text === 'from' && ts.isPropertyAccessExpression(n.parent) && n.parent.expression === n &&
      ['bind', 'call', 'apply'].includes(n.parent.name.text)) {
      hallazgo(n, sinEspacios(n.parent), POR_BIND);
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
const eximidoPor = (e, h) => e.archivo === h.rel && h.consulta === e.consulta && e.hallazgos.includes(h.motivo);
const exenta = (h) => declaradoTopN(h) || EXENCIONES.some((e) => eximidoPor(e, h));

// ─── El barrido ──────────────────────────────────────────────────────────────────────────────

const RAIZ = join(__dirname, '..');
// Lista NEGRA, como `railway.json`: un directorio de runtime nuevo nace barrido. Cada exclusión
// tiene su porqué: `webapp/` tiene su propio guard, `tests/` y `qa-e2e/` no corren en el servidor
// (y un test de abajo falla si un archivo del barrido requiere algo de ahí).
const FUERA = new Set(['node_modules', 'webapp', 'tests', 'qa-e2e', '.git', 'coverage']);
// Los scripts de shell también: Node no los corre, y parseados como JS daban un AST sin sentido
// (`restore-verify.sh` imprime "transacciones huerfanas (sin usuario)" y salía como embebido).
const NO_CODIGO = /\.(md|json|sql|txt|csv|html?|css|ya?ml|lock|env|log|png|jpe?g|gif|svg|webp|ico|pdf|xlsx?|py|map|gitignore|example|sh|bash|ps1|bat|cmd)$/i;

// Las exclusiones valen SOLO en la raíz: un `routes/webapp/` o un `services/tests/` es runtime. Y
// un `.test.js` fuera de `tests/` también: el auto-loader de `handlers/intents/` carga todo `.js`,
// así que excluirlo por nombre dejaba una puerta (hoy no hay ninguno; medido el 01-oct).
function archivos(dir, raiz = true) {
  return readdirSync(dir).flatMap((nombre) => {
    if (raiz && FUERA.has(nombre)) return [];
    if (nombre === 'node_modules') return [];
    const full = join(dir, nombre);
    if (statSync(full).isDirectory()) return archivos(full, false);
    if (/\.d\.ts$/.test(full)) return [];
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
const CON_CLIENTE = "const { createClient } = require('@supabase/supabase-js');";

/** Un fragmento como si fuera `services/fixture.js`, que requiere el paginador real. */
const caso = (cuerpo, arriba = '', cabecera = CABECERA) => analizar(
  'services/fixture.js',
  `${cabecera}\n${arriba}\nasync function f(svc, u, x, ids, options) {\n${cuerpo}\n}`,
).hallazgos.map((h) => h.motivo);

const PAG = "(d, h, p) => svc.from('transacciones').select('*', p ? { count: 'exact' } : undefined)";
const SIN = SIN_COTA;
const IRRESOLUBLE = /no se puede resolver a un número/;
const GRANDE = /pide más de 100 filas fuera de todasLasFilas/;
const FUERA_DE_TODAS = /\.range\(\) fuera de todasLasFilas/;
const ANCHO = /más ancho que un top-N/;
const NO_LITERAL = /tabla no literal/;
const DESHACE = /sale de la cadena|cambia el estado|reflexión/;

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
    expect(fuentes.map((f) => f.rel)).toContain('lib/db.js');
  });

  describe('el detector', () => {
    // Las formas de reintroducir el corte que encontraron las ocho rondas de los dos guards, en JS,
    // más las propias de CommonJS. Cada una afirma el MOTIVO, no sólo que hubo un hallazgo: un rojo
    // por otra condición no prueba que esta forma se vea.
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
      ['(A3) un loop a mano de a 100', "const POR_PAGINA = 100;\nfor (let desde = 0; ; desde += POR_PAGINA) { const { data } = await svc.from('transacciones').select('monto_pen').eq('usuario_id', u).order('fecha', { ascending: false }).range(desde, desde + POR_PAGINA - 1); if (data.length < POR_PAGINA) break; }", ANCHO],
      ['(A2) un embebido por variable que en runtime es el limit de primer nivel', "return svc.from('transacciones').select('monto_pen, fecha, categorias(nombre)').eq('usuario_id', u).order('fecha', { ascending: false }).limit(20).limit(options.cuantas ?? 5000, { referencedTable: options.embebido });", /embebido que no es un literal/],
      ['(R3) un embebido vacío', "await svc.from('transacciones').select('*').limit(5000).limit(1, { referencedTable: '' });", /embebido que no es un literal/],
      ['(A5) head:true sin count', "const { count } = await svc.from('transacciones').select('id', { head: true }).eq('usuario_id', u);", SIN],
      ['(A5) head:true con count estimado', "const { count } = await svc.from('transacciones').select('id', { count: 'estimated', head: true }).eq('usuario_id', u);", /count que no es 'exact'/],
      ['(R3) un count estimado con .limit(1)', "await svc.from('transacciones').select('id', { count: 'estimated' }).eq('usuario_id', u).limit(1);", /count que no es 'exact'/],
      ['(R3) un count planeado con maybeSingle', "await svc.from('transacciones').select('id, fecha', { count: 'planned' }).eq('usuario_id', u).limit(1).maybeSingle();", /count que no es 'exact'/],
      ['(R3) un segundo select en la página', "await todasLasFilas((desde, hasta, primera) => svc.from('transacciones').select('*', primera ? { count: 'exact' } : undefined).select('id:categoria_id, monto_pen').eq('usuario_id', u).order('id').range(desde, hasta), (t) => t.id);", /más de un \.select/],
      ['(R3) un alias id citado', "await todasLasFilas((desde, hasta, primera) => svc.from('transacciones').select('*, \"id\":categoria_id', primera ? { count: 'exact' } : undefined).order('id').range(desde, hasta), (t) => t.id);", /comillas en el select/],
      ['(R3) un default que pisa el parámetro', "await todasLasFilas((desde, hasta, primera, _r = (desde = 0)) => svc.from('transacciones').select('*', primera ? { count: 'exact' } : undefined).order('id').range(desde, hasta), (t) => t.id);", /pisa sus propios parámetros/],
      ['(R3) arguments[0] en una function', "await todasLasFilas(function (desde, hasta, primera) { arguments[0] = 0; return svc.from('transacciones').select('*', primera ? { count: 'exact' } : undefined).order('id').range(desde, hasta); }, (t) => t.id);", /SOLO la consulta/],
      ['(R3) arguments[0] en una function de una sola sentencia', "await todasLasFilas(function (desde, hasta, primera) { return (arguments[0] = 0, svc.from('transacciones').select('*', primera ? { count: 'exact' } : undefined).order('id').range(desde, hasta)); }, (t) => t.id);", /pisa sus propios parámetros|tiene que terminar en \.range|fuera de todasLasFilas/],
      ['(R3) un range de ancho 1 en un loop', "for (let i = 0; i < 5000; i++) { await svc.from('transacciones').select('monto_pen').eq('usuario_id', u).order('fecha').range(i, i + 0); }", ANCHO],
      ['(R3) require reasignado', `require = ((real) => (id) => /todas-las-filas$/.test(id) ? { todasLasFilas: async (c) => c(0, 999, false) } : real(id))(require);\nawait todasLasFilas(${PAG}.order('id').range(d, h), (t) => t.id);`, /fuera de todasLasFilas|require/],
      ['(R3) un createRequire local en un .mjs', `await todasLasFilas(${PAG}.order('id').range(d, h), (t) => t.id);`, FUERA_DE_TODAS, '', "const createRequire = () => () => ({ todasLasFilas: async (c) => c(0, 999, false) });\nconst require = createRequire(import.meta.url);\nconst { todasLasFilas } = require('../lib/todas-las-filas');"],
      ['(R4) embeber transacciones desde otra tabla', "await svc.from('categorias').select('id, nombre, transacciones(monto_pen, tipo)').eq('usuario_id', u);", EMBEBIDO],
      ['(R4) embeber con alias y hint', "await svc.from('usuarios').select('id, txs:transacciones!fk_usuario(monto_pen)').eq('id', u).single();", EMBEBIDO],
      ['(R4) setHeader que pisa el conteo', "await svc.from('transacciones').select('id', { count: 'exact', head: true }).eq('usuario_id', u).setHeader('Prefer', 'count=planned');", /setHeader/],
      ['(R4) la tabla con ./ delante', "await svc.from('./transacciones').select('monto_pen').eq('usuario_id', u);", NO_LITERAL],
      ['(R4) la tabla con query', "await svc.from('transacciones?x=1').select('monto_pen').eq('usuario_id', u);", NO_LITERAL],
      ['(R4) parámetros duplicados en una function', "await todasLasFilas(function (desde, desde, primera) { return svc.from('transacciones').select('*', primera ? { count: 'exact' } : undefined).order('id').range(desde, desde); }, (t) => t.id);", /pisa sus propios parámetros/],
      ['(R4) ascending que cambia entre páginas', "await todasLasFilas((d, h, p) => svc.from('transacciones').select('*', p ? { count: 'exact' } : undefined).order('id', { ascending: p }).range(d, h), (t) => t.id);", /order de la página|usa sus parámetros/],
      ['(R4) count con un espacio adentro', "await todasLasFilas((d, h, p) => svc.from('transacciones').select('*', p ? { count: ' exact' } : undefined).order('id').range(d, h), (t) => t.id);", /count que no es 'exact'/],
      ['(R3) un with que puede tapar la constante', "const LIMITE = 1;\nwith (options) { await svc.from('transacciones').select('monto_pen').eq('usuario_id', u).limit(LIMITE); }", IRRESOLUBLE],
      ['(A1) from con un segundo argumento', "await svc.from('transacciones', { schema: 'public' }).select('monto_pen').eq('usuario_id', u);", SIN],
      ['(A7) un const de bloque que tapa el parámetro de la página', "await todasLasFilas((ini, fin, primera) => { if (x) { const ini = 0; return svc.from('transacciones').select('*', primera ? { count: 'exact' } : undefined).order('id').range(ini, fin); } return svc.from('transacciones').select('*', primera ? { count: 'exact' } : undefined).order('id').range(ini, fin); }, (t) => t.id);", /SOLO la consulta/],
      ['(A6) un require propio que tapa el del wrapper', `await todasLasFilas(${PAG}.order('id').range(d, h), (t) => t.id);`, FUERA_DE_TODAS, '', "function require(id) { return { todasLasFilas: async (c) => c(0, 999, false) }; }\nconst { todasLasFilas } = require('../lib/todas-las-filas');"],
      ['(A8) un alias id: con asterisco', "await todasLasFilas((d, h, p) => svc.from('transacciones').select('*, id:categoria_id', p ? { count: 'exact' } : undefined).order('id').range(d, h), (t) => t.id);", /alias `id:`/],
      ['una clave que no es el id', "await todasLasFilas((d, h, p) => svc.from('transacciones').select('*', p ? { count: 'exact' } : undefined).order('id').range(d, h), (t) => `${t.fecha}|${t.monto}|${t.comercio}`);", /clave \(t\) => t\.id/],
      ['el orden por id de un embebido como último orden', "await todasLasFilas((d, h, p) => svc.from('transacciones').select('*, categorias(id)', p ? { count: 'exact' } : undefined).order('fecha').order('id', { referencedTable: 'categorias' }).range(d, h), (t) => t.id);", /order de la página/],
      ['el orden de un embebido después del id', "await todasLasFilas((d, h, p) => svc.from('transacciones').select('*, x(*)', p ? { count: 'exact' } : undefined).order('id').order('n', { referencedTable: 'x' }).range(d, h), (t) => t.id);", /order de la página/],
      ['opciones de embebido en una constante', "const UNA = { referencedTable: 'categorias' };\nawait svc.from('transacciones').select('*, categorias(*)').limit(1, UNA);", /opciones que no son un objeto literal/],
      ['head:true con spread', "await svc.from('transacciones').select('*', { head: true, count: 'exact', ...options });", /opciones que no son un objeto literal/],
      ['una const tapada por la variable de un for-of', "const limite = 100;\nfor (const limite of [100, 5000]) { await svc.from('transacciones').select('*').limit(limite); }", IRRESOLUBLE],
      ['un alias var dentro de un if, usado afuera', "if (x) { var t = svc.from('transacciones'); }\nawait t.select('*');", SIN],
      ['una tabla en constante y un helper que le pone el select', "const TABLA_TX = 'transacciones';\nconst delUsuario = (q, id) => q.select('*').eq('usuario_id', id);\nawait delUsuario(svc.from(TABLA_TX), u);", SIN],
      ['un .in(id) dentro de una página mal armada', "await todasLasFilas((d, h, p) => svc.from('transacciones').select('fecha, monto_pen, comercio', p ? { count: 'exact' } : undefined).in('id', ids).order('fecha').range(d, h), (t) => `${t.fecha}|${t.monto_pen}|${t.comercio}`);", /orden que termine en id/],
      ['la página que pisa su parámetro', "await todasLasFilas((desde, hasta, p) => svc.from('transacciones').select('*', p ? { count: 'exact' } : undefined).eq('n', desde++).order('id').range(desde, hasta), (t) => t.id);", /pisa sus propios parámetros/],
      ['la página que pisa su parámetro en un bloque', "await todasLasFilas((desde, hasta, p) => { if (x) desde = 0; return svc.from('transacciones').select('*', p ? { count: 'exact' } : undefined).order('id').range(desde, hasta); }, (t) => t.id);", /SOLO la consulta/],
      ['un TAMANO_PAGINA local que tapa el requerido', "const TAMANO_PAGINA = 5000;\nawait svc.from('transacciones').select('*').limit(TAMANO_PAGINA);", IRRESOLUBLE],
      ['un todasLasFilas inyectado como parámetro', "async function g(todasLasFilas) { return todasLasFilas((d, h, p) => svc.from('transacciones').select('*', p ? { count: 'exact' } : undefined).order('id').range(d, h), (t) => t.id); }\nawait g(null);", FUERA_DE_TODAS],
      ['un var izado que tapa una const chica', "const LIMITE = 50;\nasync function g(c) { if (c) { var LIMITE = 5000; } return svc.from('transacciones').select('*').limit(LIMITE); }\nawait g(x);", IRRESOLUBLE],
      ['una tabla en una constante con select', "const T = 'transacciones';\nawait svc.from(T).select('*');", SIN],
      ['una tabla por variable con select', "await svc.from(options.tabla).select('*');", NO_LITERAL],
      ['un cliente llamado storage (no es svc.storage)', "const storage = svc;\nawait storage.from(options.tabla).select('*');", NO_LITERAL],
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
      ['(E1) un .range de una página entera', "await svc.from('transacciones').select('*').range(0, 999);", ANCHO],
      ['(E5) un loop a mano de a 1000 con orden inestable', "for (let desde = 0; ; desde += 1000) { const { data } = await svc.from('transacciones').select('id, monto_pen').eq('usuario_id', u).order('fecha', { ascending: false }).range(desde, desde + 999); if (data.length < 1000) break; }", ANCHO],
      ['(E3) un cliente de base inyectado como this.storage', "class Repo { constructor({ storage }) { this.storage = storage; } async todas(id) { return this.storage.from(options.tabla).select('*').eq('usuario_id', id); } }", NO_LITERAL],
      ['(E4) una copia local del paginador con el mismo nombre', `await todasLasFilas(${PAG}.order('id').range(d, h), (t) => t.id);`, FUERA_DE_TODAS, '', "const { todasLasFilas } = require('./todas-las-filas');"],
      ['(E4) el paginador de la webapp requerido por ruta', `await todasLasFilas(${PAG}.order('id').range(d, h), (t) => t.id);`, FUERA_DE_TODAS, '', "const { todasLasFilas } = require('../webapp/src/lib/supabase/todas-las-filas');"],
      ['(E6) un spread de PostgREST en la página', "await todasLasFilas((d, h, p) => svc.from('transacciones').select('id, fecha, monto_pen, ...categorias(id, nombre)', p ? { count: 'exact' } : undefined).eq('usuario_id', u).order('fecha').order('id').range(d, h), (t) => t.id);", /spread en el select/],
      ['(E7) un import ESM del CJS congelado', `await paginacion.todasLasFilas(${PAG}.order('id').range(d, h), (t) => t.id);`, FUERA_DE_TODAS, '', "import * as paginacion from '../lib/todas-las-filas.js';"],
      ['(E7) un .limit con la constante por import ESM', "await svc.from('transacciones').select('*').limit(paginacion.TAMANO_PAGINA);", IRRESOLUBLE, '', "import * as paginacion from '../lib/todas-las-filas.js';"],
      ['un builder exportado por exports.x', "exports.tx = svc.from('transacciones').select('*').eq('usuario_id', u).limit(10);", SALE],
      ['un builder exportado por module.exports', "module.exports = { tx: () => svc.from('transacciones').select('*').eq('usuario_id', u).limit(10) };", SALE],
      ['un builder devuelto por una function no async', "function tx() { return svc.from('transacciones').select('*').limit(10); }\nawait tx().limit(5000);", SALE],
      ['un alias de la tabla en el tope del archivo, exportado', '', SIN, "const tablaTx = supabase.from('transacciones');\nmodule.exports = { tablaTx };"],
      // Los 22 huecos que la webapp cerró el 01-oct (8947a64) y quedaron VERDES acá: reproducidos con
      // el guard sin tocar, los 22 salían con CERO hallazgos.
      ['(W1) un alias id: con un espacio en el medio', "await todasLasFilas((d, h, p) => svc.from('transacciones').select('*, i d:categoria_id', p ? { count: 'exact' } : undefined).order('id').range(d, h), (t) => t.id);", /alias `id:`/],
      ['(W2) un embebido con un espacio en el nombre', "await svc.from('categorias').select('id, transac ciones(monto_pen)').eq('usuario_id', u);", EMBEBIDO],
      ['(W3) un embebido en una constante', "const COLS = 'id, nombre, transacciones(monto_pen)';\nawait svc.from('categorias').select(COLS).eq('usuario_id', u);", EMBEBIDO],
      ['(W4) un embebido armado con +', "await svc.from('categorias').select('id, transac' + 'ciones(monto_pen)').eq('usuario_id', u);", EMBEBIDO],
      ['(W5) un embebido como spread de PostgREST', "await svc.from('categorias').select('id, ...transacciones(monto_pen)').eq('usuario_id', u);", EMBEBIDO],
      ['(W6) un Math propio que miente', "const Math = { min: () => 5000 };\nawait svc.from('transacciones').select('monto_pen').eq('usuario_id', u).limit(Math.min(options.pedido, 1));", IRRESOLUBLE],
      ['(W7) una cota de Math.min invertida por una resta', "await svc.from('transacciones').select('monto_pen').eq('usuario_id', u).limit(100 - Math.min(options.pedido, 99));", IRRESOLUBLE],
      ['(W8) un return temprano en la página', "await todasLasFilas(async (desde, hasta, primera) => { if (desde >= 1000) return { data: [], error: null, count: null }; return svc.from('transacciones').select('id, monto_pen', primera ? { count: 'exact' } : undefined).eq('usuario_id', u).order('fecha', { ascending: false }).order('id', { ascending: false }).range(desde, hasta); }, (t) => t.id);", /SOLO la consulta/],
      ['(W9) setHeader dentro de una página perfecta', "await todasLasFilas((desde, hasta, primera) => svc.from('transacciones').select('id, monto_pen, fecha', primera ? { count: 'exact' } : undefined).setHeader('Prefer', 'count=planned').eq('usuario_id', u).order('fecha', { ascending: false }).order('id', { ascending: false }).range(desde, hasta), (t) => t.id);", /setHeader|Prefer/],
      ['(W10) un conteo en variable con setHeader después', "let q = svc.from('transacciones').select('id', { count: 'exact', head: true }).eq('usuario_id', u);\nif (x) q = q.setHeader('Prefer', 'count=planned');\nconst { count } = await q;", /sale de la cadena|Prefer/],
      ['(W11) head:true en un segundo select', "await svc.from('transacciones').select('monto_pen').eq('usuario_id', u).select('monto_pen', { count: 'exact', head: true });", SIN],
      ['(W12) maybeSingle y después csv', "await svc.from('transacciones').select('fecha, comercio, monto_pen').eq('usuario_id', u).order('fecha', { ascending: false }).maybeSingle().csv();", /\.csv\(\)|Prefer/],
      ['(W13) un embebido con hint y join type', "await svc.from('categorias').select('id, nombre, transacciones!transacciones_categoria_id_fkey!inner(monto_pen)').eq('usuario_id', u);", EMBEBIDO],
      ['(W14) la tabla codificada', "await svc.from('%74ransacciones').select('monto_pen').eq('usuario_id', u);", NO_LITERAL],
      ['(W15) la tabla con un espacio al final', "await svc.from('transacciones ').select('monto_pen').eq('usuario_id', u).gte('fecha', '2026-01-01');", NO_LITERAL],
      ['(W16) la tabla con barra invertida', "await svc.from('.\\\\transacciones').select('monto_pen').eq('usuario_id', u);", NO_LITERAL],
      ['(W17) un conteo en variable con Object.assign', "const q = svc.from('transacciones').select('monto_pen', { count: 'exact', head: true }).eq('usuario_id', u);\nObject.assign(q, { method: 'GET' });\nawait q;", DESHACE],
      ['(W18) un cliente con un fetch propio', "const c = createClient(url, key, { global: { fetch: fetchConCache } });", /cliente de Supabase/, CON_CLIENTE],
      ['(W19) un embebido llamado id en la página', "await todasLasFilas((d, h, p) => svc.from('transacciones').select('*, id:usuarios(plan)', p ? { count: 'exact' } : undefined).order('id').range(d, h), (t) => t.id);", /alias `id:`/],
      ['(W20) el conteo de la página condicionado a desde', "await todasLasFilas((desde, hasta, primera) => svc.from('transacciones').select('*', desde ? { count: 'exact' } : undefined).order('id').range(desde, hasta), (t) => t.id);", /tercer parámetro/],
      ['(W21) embeber por el nombre de la FK', "await svc.from('usuarios').select('id, transacciones_usuario_id_fkey(monto_pen)').eq('id', u).single();", EMBEBIDO],
      ['(W22) un Math.min con un 1 que no es el valor', "await svc.from('transacciones').select('monto_pen').eq('usuario_id', u).limit(Math.min(1, options.pedido));", TOPN_SIN_DECLARAR],
      // Las otras formas que la webapp cerró en las mismas rondas y que no estaban en la lista de los
      // 22 porque acá ya salían rojas por otra causa, o porque eran de una clase ya cerrada.
      ['un select con columnas armadas en runtime', "await svc.from('categorias').select(['id', options.extra].join(',')).eq('usuario_id', u);", SELECT_DINAMICO],
      ['(E11) el select por clave en una constante', "const LEER = 'select';\nawait svc.from('categorias')[LEER](`id, nombre, transacciones(${options.campos})`).eq('usuario_id', u);", /embebe transacciones|columnas que no son texto/],
      ['(E11) un método por clave dinámica', "await svc.from('transacciones')[options.metodo]('monto_pen').eq('usuario_id', u);", /clave que no es texto|sin \.range/],
      ['(E4) el header Prefer por objeto', "let q = svc.from('transacciones').select('id', { count: 'exact', head: true }).eq('usuario_id', u);\nq.headers = new Headers({ Prefer: 'count=planned' });\nawait q;", /sale de la cadena|Prefer/],
      ['(E4) el method pisado', "const q = svc.from('transacciones').select('monto_pen', { count: 'exact', head: true }).eq('usuario_id', u);\nq['method'] = 'GET';\nawait q;", /sale de la cadena|Prefer/],
      ['(E7) un single en variable, csv después', "let q = svc.from('transacciones').select('*').eq('usuario_id', u).single();\nif (x) q = q.csv();\nawait q;", /sale de la cadena|Prefer/],
      ['(R2) un receptor con nombre de global', "const Map = svc;\nawait Map.from(['transac', 'ciones'].join('')).select('monto_pen');", NO_LITERAL],
      ['(R3) la consulta dentro de un string', "const q = new Function('svc', 'u', \"return svc.from('transacciones').select('monto_pen').eq('usuario_id', u)\");\nawait q(svc, u);", /código armado en un string/],
      ['(R1) un limit negativo', "await svc.from('transacciones').select('monto_pen').eq('usuario_id', u).limit(0 - 1);", /no es un número positivo/],
      ['(S1) un single en variable con el Accept borrado', "const q = svc.from('transacciones').select('*').eq('usuario_id', u).single();\nq.headers.delete('Accept');\nawait q;", SALE],
      ['(S2) un eq(id) en variable con el filtro borrado de la URL', "const q = svc.from('transacciones').select('*').eq('id', u);\nq.url.searchParams.delete('id');\nawait q;", SALE],
      ['(S4) un maybeSingle en variable con Reflect.set', "const q = svc.from('transacciones').select('*').eq('usuario_id', u).maybeSingle();\nReflect.set(q, 'isMaybeSingle', false);\nawait q;", DESHACE],
      ['(S) un conteo dentro de Object.assign', "await Object.assign(svc.from('transacciones').select('monto_pen', { count: 'exact', head: true }).eq('usuario_id', u), { method: 'GET' });", DESHACE],
      ['(C2) un cliente con headers globales', "const c = createClient(url, key, { auth: {}, global: { headers: { Range: '0-999' } } });", /cliente de Supabase/, CON_CLIENTE],
      ['un cliente con opciones que no se pueden leer', "const c = createClient(url, key, options);", /cliente de Supabase/, CON_CLIENTE],
      ['(C6) un objeto con forma de supabase.storage', "const supabase = { storage: svc };\nawait supabase.storage.from(options.tabla).select('monto_pen').eq('usuario_id', u);", NO_LITERAL],
      ['un bucket de Storage por variable', "await supabase.storage.from(options.bucket).list(u, { limit: 1000 });", NO_LITERAL],
      ['(A01) createClient requerido con alias y un fetch propio', "const c = crearClienteSupabase(url, key, { global: { fetch: fetchDeduplicado } });", /cliente de Supabase/, "const { createClient: crearClienteSupabase } = require('@supabase/supabase-js');"],
      ['(A01) el alias con opciones limpias y headers globales', "const c = createServiceClient(url, key, { auth: { persistSession: false }, global: { headers: { Range: '0-999' } } });", /cliente de Supabase/, "const { createClient: createServiceClient } = require('@supabase/supabase-js');"],
      ['(A02) new SupabaseClient con un fetch', "const c = new SupabaseClient(url, key, { global: { fetch } });", /cliente de Supabase/, "const { SupabaseClient } = require('@supabase/supabase-js');"],
      ['(A03) new PostgrestClient con un fetch', "const c = new PostgrestClient(`${url}/rest/v1`, { headers: { apikey: key }, fetch });", /cliente de Supabase/, "const { PostgrestClient } = require('@supabase/postgrest-js');"],
      ['(A04) Object.assign sobre globalThis', "Object.assign(globalThis, { fetch: fetchDeduplicado });", /cambia el estado/],
      ['(A04b) Object.assign sobre el rest del cliente', "Object.assign(svc.rest, { fetch: fetchDeduplicado });", /cambia el estado/],
      ['(A19) createClient en una variable', "const crear = createClient;\nconst c = crear(url, key);", /cliente de Supabase/, CON_CLIENTE],
      ['(A19) createClient por namespace con corchetes', "const c = supabaseJs['createClient'](url, key, { global: { fetch } });", /cliente de Supabase|clave/, "const supabaseJs = require('@supabase/supabase-js');"],
      ['(A19) createClient con argumentos en spread', "const c = createClient(...argumentos);", /cliente de Supabase/, CON_CLIENTE],
      ['un import dinámico de supabase-js', "const { createClient } = await import('@supabase/supabase-js');", /cliente de Supabase/],
      ['(B05) un filtro de la página que depende de primera', "await todasLasFilas((desde, hasta, primera) => svc.from('transacciones').select('id, fecha, monto_pen', primera ? { count: 'exact' } : undefined).eq('usuario_id', u).lt('fecha', primera ? options.manana : options.hoy).order('fecha', { ascending: false }).order('id', { ascending: false }).range(desde, hasta), (t) => t.id);", /usa sus parámetros/],
      ['(B06) la columna de un orden que depende de primera', "await todasLasFilas((desde, hasta, primera) => svc.from('transacciones').select('id, fecha', primera ? { count: 'exact' } : undefined).order(primera ? 'fecha' : 'created_at', { ascending: false }).order('id', { ascending: false }).range(desde, hasta), (t) => t.id);", /usa sus parámetros|columna que no es un literal/],
      ['una columna de orden en una variable', "await todasLasFilas((desde, hasta, primera) => svc.from('transacciones').select('id, fecha', primera ? { count: 'exact' } : undefined).order(options.col).order('id').range(desde, hasta), (t) => t.id);", /columna que no es un literal/],
      ['(11) Function en una variable', "const compilar = Function;\nawait compilar('svc', 'u', options.codigo)(svc, u);", /reflexión/],
      ['(11) globalThis.eval', "await globalThis.eval(options.codigo);", /reflexión/],
      ['(11) eval indirecto', "await (0, eval)(options.codigo);", /reflexión/],
      ['(12) Reflect.apply sobre from', "await Reflect.apply(svc.from, svc, ['transacciones']).select('monto_pen');", /reflexión/],
      ['un from por bind', "const desde = svc.from.bind(svc);\nawait desde('transacciones').select('monto_pen');", /bind\/call\/apply/],
      ['(13) un range relativo a un desde que puede ser string', "const desde = options.desde;\nawait svc.from('transacciones').select('*').order('fecha').range(desde, desde + 49);", ANCHO],
      ['(era FP) paginación de UI con desde + N - 1', "const POR_PAGINA = 20;\nconst desde = options.pagina * POR_PAGINA;\nawait svc.from('transacciones').select('*').order('fecha').range(desde, desde + POR_PAGINA - 1);", ANCHO],
      ['un Math.min reasignado', "Math.min = () => 5000;\nawait svc.from('transacciones').select('*').limit(Math.min(options.pedido, 50));", IRRESOLUBLE],
      ['un conteo en variable con filtros condicionales', "let q = svc.from('transacciones').select('*', { count: 'exact', head: true });\nif (x) q = q.eq('tipo', 'g');\nawait q;", SALE],
      ['un conteo devuelto por una función NO async', "return 1;\n}\nfunction contarTx(svc, u) { return svc.from('transacciones').select('id', { count: 'exact', head: true }).eq('usuario_id', u);", SALE],
      ['una por id devuelta por una función NO async', "return 1;\n}\nfunction unaTx(svc, id) { return svc.from('transacciones').select('*').eq('id', id).single();", SALE],
      ['un queryFn NO async que devuelve el builder', "const q = { queryFn: () => svc.from('transacciones').select('*').eq('usuario_id', u).limit(5) };\nawait q.queryFn().limit(5000);", SALE],
      // Propias del port CJS de esta ronda: `require` es la puerta por la que llega el cliente.
      ['un require con specifier dinámico', "const m = require(options.modulo);", /require que no se puede seguir/],
      ['require como valor', "const r = require;\nconst { createClient: crear } = r('@supabase/supabase-js');\ncrear(url, key, { global: { fetch } });", /require que no se puede seguir/],
      ['module.require', "const sb = module.require('@supabase/supabase-js');\nsb.createClient(url, key, { global: { fetch } });", /require que no se puede seguir/],
      ['require.cache para pisar el paginador de otros archivos', "require.cache[require.resolve('../lib/todas-las-filas')].exports = { todasLasFilas: async (c) => c(0, 999, false) };", /require que no se puede seguir/],
      ['un createRequire ligado a otro nombre', "const sb = req('@supabase/supabase-js');\nsb.createClient(url, key, { global: { fetch } });", /require que no se puede seguir/, '', "import { createRequire } from 'module';\nconst req = createRequire(import.meta.url);"],
      ['el paquete requerido fuera de una declaración', "const c = require('@supabase/supabase-js').createClient(url, key, { global: { fetch } });", /cliente de Supabase/],
      ['el paquete requerido con un rest', "const { createClient, ...resto } = require('@supabase/supabase-js');\nresto.SupabaseClient;", /cliente de Supabase/],
      ['require de module', "const Module = require('module');\nModule._load('@supabase/supabase-js').createClient(url, key, { global: { fetch } });", /require que no se puede seguir/],
      ['require de vm', "require('vm').runInThisContext(options.codigo);", /reflexión/],
      ['Object.assign por alias', "const asignar = Object.assign;\nasignar(globalThis, { fetch: fetchDeduplicado });", /cambia el estado/],
      ['Object.assign desestructurado', "const { assign } = Object;\nassign(globalThis, { fetch: fetchDeduplicado });", /cambia el estado/],
      ['Object.assign sobre un let', "let o = {};\no = svc.rest;\nObject.assign(o, { fetch: fetchDeduplicado });", /cambia el estado/],
      ['Object.assign sobre un nombre que también es parámetro', "const o = {};\nfunction g(o) { Object.assign(o, { fetch: fetchDeduplicado }); }\ng(svc.rest);", /cambia el estado/],
      ['headers asignados a algo que no es un objeto propio', "globalThis.fetch = fetchDeduplicado;", /cambia el estado/],
      ['un var izado que tapa el objeto propio', "const o = {};\nasync function g() { if (x) { var o = svc.rest; } Object.assign(o, { fetch: fetchDeduplicado }); }\nawait g();", /cambia el estado/],
      ['una function de bloque que tapa el objeto propio', "const c = { a: () => 1 };\nfunction g() { if (x) { function c() {} } return c[options.k](u); }", /clave que no es texto/],
      ['una clave de ternario que puede ser un método de consulta', "await svc.from('categorias')[x ? 'select' : 'delete'](options.cols);", /clave que no es texto/],
      ['una clave dinámica sobre un let', "let c = { a: () => 1 };\nc = svc.from('categorias');\nawait c[options.k](options.cols);", /clave que no es texto/],
    ])('ve %s',(_n, cuerpo, motivo, arriba = '', cabecera = CABECERA) => {
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
      ['la página con las columnas en una constante', "const COLS = 'id, monto_pen, ' + 'fecha';\nawait todasLasFilas((d, h, p) => svc.from('transacciones').select(COLS, p ? { count: 'exact' } : undefined).order('id').range(d, h), (t) => t.id);"],
      ['un .in(id) dentro de una página bien armada', "await todasLasFilas((d, h, p) => svc.from('transacciones').select('*', p ? { count: 'exact' } : undefined).in('id', ids).order('id').range(d, h), (t) => t.id);"],
      ['un conteo', "await svc.from('transacciones').select('id', { count: 'exact', head: true }).eq('usuario_id', u);"],
      ['un conteo cerrado en un ternario de dos cadenas', "const { count } = await (x ? svc.from('transacciones').select('*', { count: 'exact', head: true }).eq('usuario_id', u).eq('tipo', 'g') : svc.from('transacciones').select('*', { count: 'exact', head: true }).eq('usuario_id', u));"],
      ['(FP) una por id devuelta por una función async exportada', "return 1;\n}\nexports.unaTx = async function unaTx(svc, id) { return svc.from('transacciones').select('*').eq('id', id).single();"],
      ['un limit(1) para la última', "await svc.from('transacciones').select('id').eq('usuario_id', u).order('created_at', { ascending: false }).limit(1);"],
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
      ['un texto que nombra transacciones sin paréntesis', "const msg = 'Tus transacciones del mes';\nawait svc.from('presupuestos').select('*, categorias(nombre)');"],
      ['un select con columnas en una constante armada con +', "const SCORE = 'score, ' + 'period';\nawait svc.from('neto_scores').select(SCORE).limit(1);"],
      ['Array.from', 'Array.from(new Set([1])).map((n) => n);'],
      ['Buffer.from con una variable', "Buffer.from(u).toString('base64');"],
      ['un bucket de Storage literal', "await supabase.storage.from('comprobantes').list(u, { limit: 1000 });"],
      ['un bucket de Storage en una constante', "const BUCKET = 'comprobantes';\nawait supabase.storage.from(BUCKET).remove(ids);"],
      ['el cliente de lib/db, con url y key', "const supabase = createClient(process.env.SUPABASE_URL || (x ? 'https://test.supabase.co' : undefined), process.env.SUPABASE_KEY);", '', CON_CLIENTE],
      ['un cliente con opciones de auth', "const c = createClient(url, key, { auth: { persistSession: false } });", '', CON_CLIENTE],
      ['un cliente requerido con alias y solo url y key', "const c = createServiceClient(url, key);", '', "const { createClient: createServiceClient } = require('@supabase/supabase-js');"],
      ['Object.assign sobre un objeto nuevo', "const o = Object.assign({}, options, { x: 1 });"],
      ['(FP) Object.assign sobre un const objeto propio (el updates de las ediciones)', "if (x) { const updates = {};\nObject.assign(updates, convertir(u)); }\nconst updates = { monto: 1 };\nObject.assign(updates, convertir(u));"],
      ['(FP) headers en el payload propio de Resend, con otro payload string en otra función', "function token(id) { const payload = Buffer.from(id).toString('base64url'); return payload; }\nconst payload = { from: 'a', to: [u] };\nif (x) payload.headers = { 'List-Unsubscribe': '<' + u + '>' };"],
      ['(FP) un log con el nivel por ternario de literales', "log[x ? 'error' : 'info']({ tag: 'X' }, 'mensaje');"],
      ['(FP) una tabla de copys propia llamada por clave', "const c = { reminder_d3: (n) => n, reminder_d7: (n) => n };\nreturn c[options.trigger] ? c[options.trigger](u) : '';"],
      ['require.main y require.resolve', "if (require.main === module) await main();\nconst ruta = require.resolve('./x');"],
      ['Object.keys y Object.freeze', "const ks = Object.keys(options);\nmodule.exports = Object.freeze({ ks });"],
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
        // Un `.test.js` fuera de `tests/` también es runtime: el auto-loader de intents lo carga.
        writeFileSync(join(dir, 'bin', 'sumas.test.js'), leer);
        expect(archivos(dir).map((f) => relative(dir, f).replace(/\\/g, '/')).sort()).toEqual(['bin/otra.v2', 'bin/por-arg.v2', 'bin/recalcular', 'bin/sin-shebang', 'bin/sumas.test.js']);
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
        'clave `(t) => t.id`. Si muestra las N últimas y no suma, decláralo en TOP_N con su motivo. ' +
        'Si está acotada por otra razón, va a EXENCIONES con una premisa verificable.',
    ).toEqual([]);
  });

  it('ningún archivo del barrido requiere algo de fuera del barrido (tests/, qa-e2e/)', () => {
    // Lo que vive ahí no lo mira este guard: un helper de runtime movido a `tests/` y requerido desde
    // `services/` saldría del barrido entero.
    const cruzan = fuentes.flatMap((f) => {
      const sf = ts.createSourceFile(f.rel, f.contenido, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
      const specs = [];
      const v = (m) => {
        if ((ts.isImportDeclaration(m) || ts.isExportDeclaration(m)) && m.moduleSpecifier && ts.isStringLiteral(m.moduleSpecifier)) specs.push(m.moduleSpecifier.text);
        if (ts.isCallExpression(m) && (m.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(m.expression) && m.expression.text === 'require')) &&
          m.arguments[0] && ts.isStringLiteralLike(m.arguments[0])) specs.push(m.arguments[0].text);
        ts.forEachChild(m, v);
      };
      v(sf);
      return specs.filter((s) => s.startsWith('.'))
        .map((s) => posix.normalize(posix.join(posix.dirname(f.rel), s)))
        .filter((destino) => /^(tests|qa-e2e)(\/|$)/.test(destino))
        .map((destino) => `${f.rel} → ${destino}`);
    });
    expect(cruzan).toEqual([]);
  });

  it('(R3) una lectura declarada que se reescribe por adelante o por atrás deja de calzar', () => {
    const e = TOP_N[0];
    const h = (consulta) => ({ rel: e.archivo, linea: 1, consulta, motivo: TOPN_SIN_DECLARAR });
    expect(declaradoTopN(h(e.consulta))).toBe(true);
    expect(declaradoTopN(h(e.consulta + '.range(0,99)'))).toBe(false);
    expect(declaradoTopN(h(e.consulta.replace(".select('*').eq('usuario_id',usuarioId)", ".select('monto_pen')")))).toBe(false);
    expect(declaradoTopN(h('x' + e.consulta))).toBe(false);
  });

  it.each(TOP_N)('el top-N declarado de $archivo sigue calzando con UNA lectura', (e) => {
    const calzan = todos.filter((h) => h.motivo === TOPN_SIN_DECLARAR && h.rel === e.archivo && h.consulta === e.consulta);
    expect(calzan, `top-N vencido: "${e.consulta}" ya no está en ${e.archivo}`).toHaveLength(1);
  });

  it.each(EXENCIONES)('la exención de $archivo ($consulta) sigue calzando con UNA lectura por motivo y su premisa se cumple', (e) => {
    const calzan = todos.filter((h) => eximidoPor(e, h)).map((h) => h.motivo).sort();
    expect(calzan, `exención vencida: "${e.consulta}" ya no está en ${e.archivo}`).toEqual([...e.hallazgos].sort());
    const contenido = fuentes.find((f) => f.rel === e.archivo).contenido;
    expect(e.premisa(contenido), `la premisa de la exención ya no se cumple: ${e.motivo}`).toBe(true);
  });

  it('las premisas no se dejan engañar por un cambio adentro de lo exento', () => {
    const premisa = (archivo) => EXENCIONES.find((e) => e.archivo === archivo).premisa;
    const de = (archivo) => fuentes.find((f) => f.rel === archivo).contenido;
    const tx = de('handlers/intents/transacciones.js');
    const checks = de('cron/checks.js');
    const tokens = de('scripts/backfill-encrypt-tokens.js');
    const registry = de('handlers/intent-registry.js');
    const inventario = de('scripts/inventario-escrituras-intents.mjs');
    const casos = [
      // Un select sin el filtro de usuario metido entre los filtros condicionales de `qElim`.
      ['handlers/intents/transacciones.js', tx, tx.replace("if (fechaElimReq) qElim = qElim.eq('fecha', fechaElimReq);", "if (fechaElimReq) qElim = qElim.eq('fecha', fechaElimReq);\n          if (montoElimReq) qElim = qElim.select('monto_pen');")],
      // `\u0071Elim` es `qElim` para JavaScript y no para una regex.
      ['handlers/intents/transacciones.js', tx, tx.replace('const { data: candidatosElim } = await qElim;', 'if (fechaElimReq) \\u0071Elim = \\u0071Elim.limit(5000);\n          const { data: candidatosElim } = await qElim;')],
      // Una tercera llamada a `existe` sobre transacciones con un filtrar que no es solo `.eq`.
      ['cron/checks.js', checks, checks.replace("Promise.all(ids.map((id) => existe('notification_deliveries',", "Promise.all(ids.map((id) => existe('transacciones', (q) => q.range(0, 4999)))),\n        Promise.all(ids.map((id) => existe('notification_deliveries',")],
      // `existe` con el limit adentro del comentario en vez de en el código.
      ['cron/checks.js', checks, checks.replace(".select('usuario_id')).limit(1);", ".select('usuario_id')); // .limit(1);")],
      // Un TARGET nuevo sobre transacciones.
      ['scripts/backfill-encrypt-tokens.js', tokens, tokens.replace("  { table: 'gmail_cuentas', pk: 'id', col: 'refresh_token',       tipo: 'refresh' },", "  { table: 'gmail_cuentas', pk: 'id', col: 'refresh_token',       tipo: 'refresh' },\n  { table: 'transacciones', pk: 'id', col: 'monto_pen', tipo: 'access' },")],
      // Una columna que embebe.
      ['scripts/backfill-encrypt-tokens.js', tokens, tokens.replace("col: 'access_token',", "col: 'access_token, transacciones(monto_pen)',")],
      // Un plan que se llena con otra cosa que TARGETS.
      ['scripts/backfill-encrypt-tokens.js', tokens, tokens.replace('  // Reporte agregado (sin valores de token)', "  plan.push({ table: 'transacciones', pk: 'id', col: 'monto_pen', action: 'encrypt' });\n  // Reporte agregado (sin valores de token)")],
      // El loader de intents apuntado a otra carpeta.
      ['handlers/intent-registry.js', registry, registry.replace("path.join(__dirname, 'intents')", "path.join(__dirname, process.env.INTENTS_DIR || 'intents')")],
      // El script de inventario compilando otra cosa.
      ['scripts/inventario-escrituras-intents.mjs', inventario, inventario.replace("cuerpo + '\\nreturn { lecturas, leeElError };'", "cuerpo + process.env.EXTRA + '\\nreturn { lecturas, leeElError };'")],
    ];
    for (const [archivo, real, modificado] of casos) {
      expect(modificado, archivo).not.toBe(real);
      expect(premisa(archivo)(real), archivo).toBe(true);
      expect(premisa(archivo)(modificado), archivo).toBe(false);
    }
  });
});
