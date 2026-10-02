import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, posix } from 'node:path';
import ts from 'typescript';

/**
 * NINGUNA LECTURA DE `transacciones` PUEDE CORTARSE EN 1000 SIN DECIRLO.
 *
 * PostgREST corta cada respuesta en `max_rows` (1000 en este proyecto) y no avisa. El 01-oct-2026
 * un usuario tenía 1105 transacciones y `/api/export` le entregaba un archivo con 1000 y
 * `totalTransacciones: 1000`; el backfill del score ya leía 814 filas de seis meses. Eran diez
 * lecturas sin cota; `lib/supabase/todas-las-filas.ts` es el arreglo y esto, que no vuelva.
 *
 * **Falla cerrado, y por qué.** La primera versión seguía el builder por variables, funciones y
 * reasignaciones para decidir si el `.limit` llegaba a aplicarse. Dos revisiones adversariales
 * seguidas la dejaron verde con 13 y 7 evasiones: siempre quedaba una forma sin seguir. Como
 * postgrest-js aplica el ÚLTIMO `.limit`/`.range`, cualquier uso que el guard no vea puede reabrir
 * la consulta. Así que ya no sigue nada. Mira la cadena que nace en `.from('transacciones')` y
 * acepta tres cosas, y las tres en una cadena CERRADA (se ejecuta ahí mismo: `await` directo,
 * también a través de un ternario, elemento de un `Promise.all([...])`, retorno de una función
 * `async`, o un `.then(...)`):
 *
 * 1. **Una cota que nada posterior puede deshacer**: `.single()`, `.maybeSingle()`,
 *    `.eq('id', …)`, `.in('id', …)` o `head: true` con `count: 'exact'` en el PRIMER `select`.
 *    Hasta el 01-oct se aceptaba también guardada en una variable, y dos rondas de ataque seguidas
 *    la deshicieron por fuera de la cadena (`q = q.setHeader(…)`, `q = q.csv()`,
 *    `Object.assign(q, { method: 'GET' })`, `q.url.searchParams.delete('id')`): prohibir esas
 *    formas una por una era tapar el caso. Lo que nunca sale de la cadena no se puede tocar.
 * 2. **La página de `todasLasFilas`, con UNA forma**: importado de `lib/supabase/todas-las-filas`
 *    RESUELTO POR RUTA (una copia con el mismo nombre en otra carpeta no es el paginador) y ligado
 *    una sola vez en todo el archivo; termina en `.range(desde, hasta)` con los parámetros de la
 *    página, que nadie pisa; sin `.limit`; sus `.order` llevan a lo sumo `{ ascending: true|false }`
 *    y el último es por `id`; UN solo `select`, texto estático, sin comillas, sin spread, sin
 *    alias `id:`, con `id` o `*` entre sus columnas PROPIAS; pide `count: 'exact'`; y la clave es
 *    exactamente `(t) => t.id`.
 * 3. **`.limit(1)` (resuelto exacto), o un TOP-N DECLARADO en `TOP_N`**, como ÚLTIMO limitador.
 *    El top-N tiene que resolverse a <= `TOPE_TOP_N` (100). Un `queryFn` NO async que devuelve el builder ya no se
 *    acepta por el nombre de la propiedad: ninguna lectura real lo usaba (medido el 01-oct) y era
 *    una puerta (una fábrica de opciones cuyo `queryFn()` se llama a mano en otro lado).
 *
 *    **Hasta el 01-oct aceptaba cualquier límite hasta 1000**, y eso dejaba pasar
 *    `.limit(TAMANO_PAGINA)` sobre una SUMA y un loop a mano de `range(desde, desde + 999)` (había
 *    un fixture "no marca" que lo pedía). El backend lo pagó primero: bajar el tope a 100 no
 *    alcanzó, la ronda siguiente pasó `.limit(100)` sobre una suma mensual. Ningún tope sintáctico
 *    separa "las 5 últimas" de "sumá el mes"; lo separa quien lo escribe, así que cada top-N va a
 *    `TOP_N` con su motivo y anclado al texto ENTERO de su cadena. Lo que suma va por la página.
 *
 * Todo lo demás es rojo: un builder que sale a una variable, un argumento o una propiedad, aunque
 * lleve un `.limit(10)` perfecto. Si de verdad está bien, se cierra en el lugar o va a EXENCIONES
 * con una premisa verificable.
 *
 * **Y `transacciones` como EMBEBIDO desde otra tabla también es rojo.** PostgREST le aplica
 * `max_rows` a cada nodo del árbol: `categorias.select('…, transacciones(monto_pen)')` suma 1000.
 * Se busca en todo texto estático del archivo, no solo en el argumento del `select`, y después de
 * hacer lo que hace postgrest-js con él (borrar los espacios fuera de comillas: `'transac ciones(x)'`
 * viaja como `transacciones(x)`). Por eso también un `.select()` cuyas columnas no son texto
 * estático es rojo, en cualquier tabla: no se puede saber qué embebe.
 *
 * **Lo que cambia el estado de una consulta es rojo en cualquier archivo**, además: `.setHeader`, el
 * header `Prefer`, `.csv()/.geojson()/.explain()`, asignar `method/url/headers/…`, y un cliente de
 * Supabase con `fetch`, `headers` u opciones que no se pueden leer (un fetch que memoiza por ruta
 * le devolvía a la página 2 la página 1). Tampoco pasa una llamada por clave que no se puede leer
 * (`q[metodo](…)`), ni `eval`/`new Function`. La tabla tiene que ser un identificador limpio
 * (`/^[a-z_][a-z0-9_]*$/`): `new URL` recorta, borra tabs, pasa `\` a `/` y decodifica `%74`, así
 * que `'transacciones '` también es `transacciones`. Y la página con cuerpo de bloque es UNA
 * sentencia: un `return` temprano la cortaba.
 *
 * Una cadena sin escritura (`insert/update/upsert/delete`) cuenta como lectura aunque no tenga
 * `select`: un helper puede ponérselo. El alias pelado (`const t = svc.from('x')`) se juzga en cada
 * uso; en el tope del archivo, además como lectura sin cota, porque puede salir por un `export`.
 * Una tabla no literal que lee falla. Un nombre (el paginador, una constante) ligado más de una vez
 * en el archivo no se resuelve: seguir ámbitos fue la trampa de las primeras versiones.
 *
 * Lo que NO ve, declarado: `.in('id', lista)` no mira el largo de la lista; `.rpc()`, un `fetch`
 * directo a `/rest/v1/transacciones` y las vistas quedan fuera; un wrapper propio de
 * `todasLasFilas` es rojo; `.from` por `.bind`/`.call` no se ve; un embebido por el nombre de una
 * FK que no contenga `transacciones` (hoy la única es `transacciones_usuario_id_fkey`, medido el
 * 01-oct en `pg_constraint`); columnas armadas en runtime (`[…].join(',')`) que llegan a un helper
 * que las pasa a `.select()` solo se ven si es uno de `PASAN_COLUMNAS`; un llamador de
 * `todasLasFilas` que ignora `error` no se mira acá (el helper devuelve `data: null` con error, así
 * que ya no recibe una lista corta con cara de completa); y un humano puede declarar en TOP_N una
 * lectura que en realidad suma.
 */

const TABLAS = new Set(['transacciones']);
// Literales a propósito, NO la constante del helper: si alguien sube `TAMANO_PAGINA` a 5000 "para
// hacer menos viajes", el helper sigue bien (avanza por lo recibido) pero un guard atado a ella
// pasaría a aceptar `.limit(5000)`, que PostgREST corta en 1000.
const MAX_ROWS = 1000;
const TOPE_TOP_N = 100;
const MODULO = 'lib/supabase/todas-las-filas';
const SALE = 'el builder sale de la cadena (variable, argumento, ternario, propiedad) y alguien puede pisarle el límite: ciérrala en el lugar o va a EXENCIONES';
const TOPN_SIN_DECLARAR = 'un .limit/.range de top-N sin declarar en TOP_N: si la respuesta SUMA o CUENTA estas filas, va por todasLasFilas';
const EMBEBIDO = 'embebe transacciones desde otra tabla: PostgREST corta el embebido en 1000 igual';
const SELECT_DINAMICO = 'un .select() con columnas que no son texto estático: no se puede saber si embebe transacciones';
const CLAVE_DINAMICA = 'una llamada por una clave que no es texto estático: puede ser un select, un limit o un from';
const TOCA_LA_CONSULTA = 'cambia el estado de una consulta por fuera de su cadena (header Prefer, setHeader, method/url/headers): puede pisar el conteo o el límite';
/** Propiedades del builder de postgrest-js que, asignadas, cambian lo que se pide. */
const ESTADO_DE_CONSULTA = new Set(['method', 'url', 'headers', 'isMaybeSingle', 'fetch', 'schema', 'signal', 'rest']);
const CLIENTE_RARO = 'un cliente de Supabase con fetch, headers u opciones que no se pueden leer, o usado fuera de una llamada directa: cambia todas sus consultas';
const PAQUETES_SUPABASE = new Set(['@supabase/supabase-js', '@supabase/ssr', '@supabase/postgrest-js']);
const OPCIONES_DE_CLIENTE = new Set(['global', 'fetch', 'headers', 'db', 'accessToken']);
const COLUMNAS_DINAMICAS = 'columnas que no son texto estático a un helper que las pasa a .select(): no se puede saber si embeben transacciones';
/** Helpers de `lib/supabase/auth.ts` cuyo primer argumento termina en un `.select()`. */
const PASAN_COLUMNAS = new Set(['requireNetoUser', 'findNetoUser', 'requireLectura']);

interface Fuente { rel: string; ruta: string; contenido: string }

/**
 * Lecturas que el guard no puede probar acotadas y están bien por otra razón. Cada una se ancla al
 * TEXTO ENTERO de la cadena (sin espacios) y a una premisa que se verifica contra el archivo: si
 * cambia la consulta la exención deja de calzar, y si cambia la premisa el test de abajo falla.
 */
const EXENCIONES: {
  archivo: string;
  consulta: string;
  motivo: string;
  premisa: (contenido: string) => boolean;
}[] = [
  {
    archivo: 'app/api/transactions/import/route.ts',
    consulta: "getServiceClient().from('transacciones').insert(chunk).select('id')",
    motivo:
      'devuelve las filas que acaba de insertar, en lotes de CHUNK: mientras el lote no pase de ' +
      '1000, la respuesta tampoco',
    // El bloque ENTERO, y `CHUNK` contado por AST: un `const CHUNK = Number(process.env…)` de
    // bloque (ataque I1) o un `guardar(chunk)` aparte con un lote de 5000 (tercera ronda) dejaban
    // en pie las líneas que la premisa anterior buscaba.
    premisa: (c) =>
      sinEspaciosTexto(c).includes("constCHUNK=200;for(leti=0;i<toInsert.length;i+=CHUNK){constchunk=toInsert.slice(i,i+CHUNK);const{data,error}=awaitgetServiceClient().from('transacciones').insert(chunk).select('id');if(error){returnNextResponse.json({error:'Errorguardando:'+error.message,insertados},{status:500},);}insertados+=data?.length??chunk.length;}") &&
      cuentaIdentificador(c, 'CHUNK') === 3 && cuentaIdentificador(c, 'chunk') === 3 &&
      (c.match(/\.insert\(/g) ?? []).length === 1,
  },
  {
    archivo: 'lib/hooks/use-transactions.ts',
    consulta: "supabase.from('transacciones').select('*',conteo?{count:'exact'}:undefined).eq('usuario_id',usuarioId).order('fecha',{ascending:false}).order('created_at',{ascending:false}).order('id',{ascending:false})",
    motivo:
      '`armar` construye el builder con filtros condicionales y se usa en UN solo lugar: la página ' +
      'de todasLasFilas, con `.range(desde, hasta)` y la clave `(t) => t.id`. Sus tres órdenes son ' +
      'los únicos del archivo y el último es por `id`: un orden agregado en una rama lo rompería',
    // `armar` ENTERA, y sus referencias contadas por AST. Contar `armar(` dejaba pasar un alias
    // (ataque E5); contar órdenes dejaba pasar un `select` sin `id` o un filtro que depende de
    // `conteo` metidos adentro (tercera ronda: 1 y 1085 de 1105). Cualquier cambio a `armar` vuelve
    // a pedir que alguien la mire.
    premisa: (c) =>
      cuentaIdentificador(c, 'armar') === 2 && cuentaIdentificador(c, 'query') === 12 &&
      sinEspaciosTexto(c).includes("constarmar=(conteo:boolean)=>{letquery=supabase.from('transacciones').select('*',conteo?{count:'exact'}:undefined).eq('usuario_id',usuarioId).order('fecha',{ascending:false}).order('created_at',{ascending:false}).order('id',{ascending:false});if(options.desde&&options.hasta){query=query.gte('fecha',options.desde).lt('fecha',options.hasta);}elseif(options.mes&&options.anio){conststartDate=`${options.anio}-${String(options.mes).padStart(2,'0')}-01`;constendDate=options.mes===12?`${options.anio+1}-01-01`:`${options.anio}-${String(options.mes+1).padStart(2,'0')}-01`;query=query.gte('fecha',startDate).lt('fecha',endDate);}elseif(options.anio&&!options.mes){conststartDate=`${options.anio}-01-01`;constendDate=`${options.anio+1}-01-01`;query=query.gte('fecha',startDate).lt('fecha',endDate);}if(options.tipo)query=query.eq('tipo',options.tipo);if(options.categoria)query=query.eq('categoria',options.categoria);returnquery;};") &&
      sinEspaciosTexto(c).includes('(desde,hasta,primera)=>armar(primera).range(desde,hasta),(t)=>t.id,'),
  },
  {
    archivo: 'app/api/categories/usage/route.ts',
    consulta: "getServiceClient().from('transacciones').select('*',{count:'exact',head:true}).eq('usuario_id',userId).filter('categoria','imatch',exactCI(nombre))",
    motivo:
      'un conteo `head: true` + `exact` guardado en `q` para agregarle el filtro de subcategoría si ' +
      'viene; las cuatro apariciones de `q` son la declaración, ese filtro y el `await`',
    // `q` contado por AST: por regex, un `\u0071` (que es `q`) no contaba (tercera ronda).
    premisa: (c) =>
      cuentaIdentificador(c, 'q') === 4 &&
      sinEspaciosTexto(c).includes("letq=getServiceClient().from('transacciones').select('*',{count:'exact',head:true}).eq('usuario_id',userId).filter('categoria','imatch',exactCI(nombre));if(sub)q=q.filter('subcategoria','imatch',exactCI(sub));const{count,error}=awaitq;"),
  },
  // Los dos `.select()` dinámicos de `auth.ts` leen la fila de `usuarios` con las columnas que
  // pide el llamador. Están bien mientras TODO llamador pase texto estático: eso lo vigila
  // `COLUMNAS_DINAMICAS` en cada archivo, y el texto estático pasa por el detector de embebidos.
  ...['getServiceClient().from(\'usuarios\').select(select)', 'getServiceClient().from(\'usuarios\').select(columns)'].map((consulta) => ({
    archivo: 'lib/supabase/auth.ts',
    consulta,
    motivo: 'lee `usuarios` con las columnas de un llamador; los llamadores pasan texto estático (lo exige el guard)',
    premisa: (c: string) =>
      // Y las dos validan en runtime que las columnas no embeban: un barrel o un `import()` dinámico
      // esquivan el reconocimiento por nombre de este guard (tercera ronda).
      cuentaIdentificador(c, 'columnasSinEmbebidos') === 3 &&
      /export async function requireNetoUser\(columns = 'id'\)/.test(c) &&
      /export async function findNetoUser\(columns = 'id'\)/.test(c) &&
      /const select = columns\.split\(','\)/.test(c),
  })),
  {
    archivo: 'lib/supabase/auth.ts',
    consulta: 'requireNetoUser(conPlan)',
    motivo: '`requireLectura` le reenvía a `requireNetoUser` sus propias columnas con `plan` agregado',
    premisa: (c) => /const conPlan = columns\.split\(','\)/.test(c) && /\? columns\s*: `\$\{columns\}, plan`;/.test(c),
  },
];

const sinEspaciosTexto = (c: string) => c.replace(/\s+/g, '');

/** Cuántas veces aparece el identificador `nombre`, por AST: `\u0071` también es `q`. */
function cuentaIdentificador(codigo: string, nombre: string): number {
  const sf = ts.createSourceFile('premisa.ts', codigo, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let n = 0;
  const v = (m: ts.Node) => { if (ts.isIdentifier(m) && m.text === nombre) n++; ts.forEachChild(m, v); };
  v(sf);
  return n;
}

/**
 * LOS TOP-N, DECLARADOS UNO POR UNO. Fuera de `todasLasFilas` solo `.limit(1)` pasa solo; todo otro
 * `.limit`/`.range` <= 100 tiene que estar acá, anclado al texto ENTERO de su cadena (sin espacios)
 * y con el motivo de por qué mostrar N filas es lo que la respuesta necesita. Una consulta que
 * cambia deja de calzar y vuelve a rojo, y una entrada que ya no calza con UNA lectura también.
 */
const TOP_N: { archivo: string; consulta: string; motivo: string }[] = [
  {
    archivo: 'app/activar/page.tsx',
    consulta: "svc.from('transacciones').select('comercio,categoria,monto,monto_pen').eq('usuario_id',fila.id).eq('tipo','gasto').order('fecha',{ascending:false}).limit(MAX_GASTOS)",
    motivo: 'muestra los 3 gastos más recientes como muestra; el total que se anuncia sale de un conteo exacto aparte',
  },
];

// ─── El analizador ───────────────────────────────────────────────────────────────────────────

interface Llamada { metodo: string; nodo: ts.CallExpression }
interface Hallazgo { rel: string; linea: number; consulta: string; motivo: string }
type FuncionPagina = ts.ArrowFunction | ts.FunctionExpression;
type Pagina = { todas: ts.CallExpression; fn: FuncionPagina };
type Opciones = Map<string, ts.Expression> | 'sucio' | null;

const ESCRITURAS = new Set(['insert', 'upsert', 'update', 'delete']);
const FORMATOS = new Set(['csv', 'geojson', 'explain']);
const NO_SUPABASE = /^(Array|Buffer|Object|Set|Map|String|Uint8Array|Int\w*Array|Float\w*Array|BigInt\w*Array)$/;

const envoltorio = (n: ts.Node) => ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isNonNullExpression(n) ||
  ts.isSatisfiesExpression(n) || ts.isTypeAssertionExpression(n);

/** Saca paréntesis y aserciones de tipo de encima de una expresión. */
function pelar(n: ts.Expression): ts.Expression {
  while (envoltorio(n)) n = (n as ts.ParenthesizedExpression).expression;
  return n;
}

/** El padre de `n` saltando paréntesis y aserciones de tipo. */
const subir = (n: ts.Node): ts.Node => {
  let p = n.parent;
  while (p && envoltorio(p)) p = p.parent;
  return p;
};

const literalTexto = (n: ts.Node | undefined): string | null => (n && ts.isStringLiteralLike(n) ? n.text : null);
type Clave = (e: ts.Expression) => string | null;

/**
 * El nombre del método si `n` es `x.m` o `x[k]`, con `k` resuelto por `clave` (un `const LEER =
 * 'select'` también es `select`: el ataque E11 llamaba así el select de un embebido).
 */
function nombreMetodo(n: ts.Node, clave: Clave = literalTexto): string | null {
  if (ts.isPropertyAccessExpression(n)) return n.name.text;
  if (ts.isElementAccessExpression(n)) return clave(n.argumentExpression);
  return null;
}

/** Sube por `.metodo(...)` encadenados desde `inicio`: la expresión más externa y las llamadas. */
function cadena(inicio: ts.Expression, clave: Clave = literalTexto): { externo: ts.Expression; llamadas: Llamada[] } {
  const llamadas: Llamada[] = [];
  let actual: ts.Expression = inicio;
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
function nombresLigados(b: ts.BindingName): string[] {
  if (ts.isIdentifier(b)) return [b.text];
  return b.elements.flatMap((e) => (ts.isOmittedExpression(e) ? [] : nombresLigados(e.name)));
}

/**
 * Las opciones de un `.limit`/`.range`/`.order`/`.select`, leídas sólo si son un objeto literal
 * LIMPIO: claves identificador, sin spread, sin `as`. `'sucio'` si vienen de otra forma (no se
 * puede saber qué traen, y eso falla cerrado); `null` si no hay.
 */
function opciones(n: ts.Expression | undefined): Opciones {
  if (!n) return null;
  if (!ts.isObjectLiteralExpression(n)) return 'sucio';
  const m = new Map<string, ts.Expression>();
  for (const p of n.properties) {
    if (!ts.isPropertyAssignment(p) || !ts.isIdentifier(p.name)) return 'sucio';
    m.set(p.name.text, p.initializer);
  }
  return m;
}

// Del embebido solo si el VALOR es un literal no vacío: con `{ referencedTable: variable }` y la
// variable en `undefined`, postgrest-js usa el `limit` de PRIMER nivel (`typeof === 'undefined'`).
const deEmbebido = (o: Opciones) => o instanceof Map && ['referencedTable', 'foreignTable'].some((k) => {
  const v = o.get(k);
  return !!v && ts.isStringLiteralLike(v) && v.text !== '';
});
const nombraEmbebido = (o: Opciones) => o instanceof Map && (o.has('referencedTable') || o.has('foreignTable'));

/** Lo que postgrest-js hace con las columnas de un `select`: borra los espacios fuera de comillas. */
function limpiarSelect(s: string): string {
  let comillas = false;
  return [...s].map((c) => {
    if (/\s/.test(c) && !comillas) return '';
    if (c === '"') comillas = !comillas;
    return c;
  }).join('');
}

const embebeTransacciones = (s: string) =>
  /(^|[^a-z0-9_$])transacciones[a-z0-9_]*(![a-z0-9_]+)*\(/.test(limpiarSelect(s).replace(/"/g, '').toLowerCase());

/** Las columnas propias de un select ya limpio, sin los embebidos (`categorias(nombre,id)`). */
function columnasPropias(sel: string): string[] {
  let s = sel;
  for (let prev = ''; prev !== s; ) { prev = s; s = s.replace(/[\w!:.]+\([^()]*\)/g, ''); }
  return s.split(',').map((c) => c.trim()).filter(Boolean);
}

/** ¿Es `{ count: 'exact' }` o `cond ? { count: 'exact' } : undefined`, leído del AST? */
function esConteoDePagina(e: ts.Expression | undefined): boolean {
  if (!e) return false;
  const n = pelar(e);
  const exacto = (o: ts.Expression) => {
    const m = opciones(pelar(o));
    return m instanceof Map && m.size === 1 && literalTexto(m.get('count')) === 'exact';
  };
  if (ts.isConditionalExpression(n)) {
    const no = pelar(n.whenFalse);
    return ts.isIdentifier(pelar(n.condition)) && exacto(n.whenTrue) && ts.isIdentifier(no) && no.text === 'undefined';
  }
  return exacto(n);
}

/**
 * Lo que está mal en las opciones de un `select`, o `null`. Un ternario se juzga por sus dos
 * ramas (`p ? { count: 'exact' } : undefined` es la forma de la página).
 */
function conteoMalo(e: ts.Expression | undefined): string | null {
  if (!e) return null;
  const n = pelar(e);
  if (ts.isConditionalExpression(n)) return conteoMalo(n.whenTrue) ?? conteoMalo(n.whenFalse);
  if (ts.isIdentifier(n) && n.text === 'undefined') return null;
  const o = opciones(n);
  if (o === 'sucio') return '.select() con opciones que no son un objeto literal: no se puede saber qué conteo pide';
  if (o instanceof Map && o.has('count') && literalTexto(o.get('count')) !== 'exact') return ".select() con un count que no es 'exact': estimado o planeado, miente pasando las 1000 filas";
  return null;
}

function esFija(l: Llamada, i: number): boolean {
  const [a0, a1] = l.nodo.arguments;
  if (l.metodo === 'single' || l.metodo === 'maybeSingle') return true;
  if ((l.metodo === 'eq' || l.metodo === 'in') && literalTexto(a0) === 'id') return true;
  // `head` solo vale en el PRIMER `select`, el de `.from()`: el que viene después es el del
  // TransformBuilder, que ignora las opciones, y la consulta ya quedó en GET (ataque E6).
  if (l.metodo === 'select' && i === 0) {
    // `head: true` sin `count` da `count: null`, y `'estimated'`/`'planned'` devuelven la
    // estimación del planner justo pasando `max_rows`: el único conteo de verdad es `'exact'`.
    const o = opciones(a1);
    return o instanceof Map && o.get('head')?.kind === ts.SyntaxKind.TrueKeyword && literalTexto(o.get('count')) === 'exact';
  }
  return false;
}

/**
 * El módulo que nombra el specifier de un import, relativo a `src/`, sin extensión. `@/x` es
 * `src/x` (tsconfig `paths`); uno relativo se resuelve desde el archivo. Un paquete da `null`.
 */
/** ¿`n` es el nombre que se declara o importa, o está en una posición de tipo? */
function esDeclaracionOTipo(n: ts.Identifier): boolean {
  const p = n.parent;
  if (ts.isImportSpecifier(p) || ts.isImportClause(p) || ts.isNamespaceImport(p)) return true;
  for (let m: ts.Node = n; m.parent; m = m.parent) {
    if (ts.isTypeNode(m.parent) || ts.isTypeQueryNode(m.parent) || ts.isExpressionWithTypeArguments(m.parent) && ts.isHeritageClause(m.parent.parent)) return true;
    if (ts.isExpression(m.parent) || ts.isStatement(m.parent)) return false;
  }
  return false;
}

function moduloDe(spec: string, rel: string): string | null {
  // Como lo resuelve TypeScript (`@/lib/supabase/./auth`, un `index`, un `package.json`), y si no
  // resuelve, por texto normalizado.
  const r = ts.resolveModuleName(spec, join(SRC, rel), OPCIONES_TS, ts.sys).resolvedModule;
  if (r && !r.isExternalLibraryImport) return relative(SRC, r.resolvedFileName).replace(/\\/g, '/').replace(/\.(d\.ts|ts|tsx|js|mjs)$/, '');
  let p: string;
  if (spec.startsWith('@/')) p = posix.normalize(spec.slice(2));
  else if (spec.startsWith('.')) p = posix.normalize(posix.join(posix.dirname(rel), spec));
  else return null;
  return p.replace(/\.(ts|tsx|js|mjs)$/, '');
}

function analizar(rel: string, codigo: string): { hallazgos: Hallazgo[]; lecturas: number } {
  const kind = /\.tsx$/.test(rel) ? ts.ScriptKind.TSX : /\.(jsx?|mjs|cjs)$/.test(rel) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(rel, codigo, ts.ScriptTarget.Latest, true, kind);
  const hallazgos: Hallazgo[] = [];
  let lecturas = 0;
  const lineaDe = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart()).line + 1;
  const sinEspacios = (n: ts.Node) => n.getText().replace(/\s+/g, '');

  // Cuántas veces se liga cada nombre en TODO el archivo, en cualquier ámbito. Un nombre ligado
  // más de una vez no se resuelve: `var` se iza, un parámetro tapa un import, un `const` de bloque
  // tapa otro, y seguir ámbitos es lo que las primeras versiones de este guard no lograron.
  const veces = new Map<string, number>();
  const ligar = (nombre: string) => veces.set(nombre, (veces.get(nombre) ?? 0) + 1);
  const contar = (m: ts.Node) => {
    if ((ts.isVariableDeclaration(m) || ts.isParameter(m) || ts.isBindingElement(m)) && ts.isIdentifier(m.name)) ligar(m.name.text);
    if ((ts.isFunctionDeclaration(m) || ts.isFunctionExpression(m) || ts.isClassDeclaration(m) || ts.isClassExpression(m) ||
      ts.isEnumDeclaration(m) || ts.isModuleDeclaration(m)) && m.name && ts.isIdentifier(m.name)) ligar(m.name.text);
    if (ts.isImportClause(m) && m.name) ligar(m.name.text);
    if (ts.isNamespaceImport(m) || ts.isImportSpecifier(m) || ts.isImportEqualsDeclaration(m)) ligar(m.name.text);
    ts.forEachChild(m, contar);
  };
  contar(sf);
  const unica = (nombre: string) => veces.get(nombre) === 1;

  // `with (obj) { … LIMITE … }` puede tapar cualquier nombre en runtime (no compila en un módulo,
  // pero el barrido no compila): con un `with` en el archivo no se resuelve ninguna constante.
  let hayWith = false;
  const buscarWith = (m: ts.Node) => { if (m.kind === ts.SyntaxKind.WithStatement) hayWith = true; ts.forEachChild(m, buscarWith); };
  buscarWith(sf);

  // Los nombres con que el archivo trae `todasLasFilas` de SU módulo, resuelto por ruta: directo
  // o por namespace (`import * as p` → `p.todasLasFilas`). Solo imports de valor.
  const directos = new Set<string>();
  const espacios = new Set<string>();
  for (const s of sf.statements) {
    if (!ts.isImportDeclaration(s) || !ts.isStringLiteral(s.moduleSpecifier) || s.importClause?.isTypeOnly) continue;
    if (moduloDe(s.moduleSpecifier.text, rel) !== MODULO) continue;
    const b = s.importClause?.namedBindings;
    if (b && ts.isNamespaceImport(b)) espacios.add(b.name.text);
    if (b && ts.isNamedImports(b)) {
      for (const e of b.elements) if (!e.isTypeOnly && (e.propertyName ?? e.name).text === 'todasLasFilas') directos.add(e.name.text);
    }
  }
  const esElPaginador = (n: ts.Expression): boolean => {
    if (ts.isIdentifier(n)) return directos.has(n.text) && unica(n.text);
    return ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression) && espacios.has(n.expression.text) &&
      unica(n.expression.text) && n.name.text === 'todasLasFilas';
  };

  // Los nombres locales de los helpers que pasan columnas a `.select()`: por su nombre (en
  // `auth.ts` mismo), importados con alias (ataque E10) o por namespace.
  const helpersDeColumnas = new Set<string>(rel === 'lib/supabase/auth.ts' ? PASAN_COLUMNAS : []);
  const espaciosAuth = new Set<string>();
  for (const s of sf.statements) {
    if (!ts.isImportDeclaration(s) || !ts.isStringLiteral(s.moduleSpecifier) || moduloDe(s.moduleSpecifier.text, rel) !== 'lib/supabase/auth') continue;
    const b = s.importClause?.namedBindings;
    if (b && ts.isNamespaceImport(b)) espaciosAuth.add(b.name.text);
    if (b && ts.isNamedImports(b)) for (const e of b.elements) if (PASAN_COLUMNAS.has((e.propertyName ?? e.name).text)) helpersDeColumnas.add(e.name.text);
  }
  const esHelperDeColumnas = (e: ts.Expression) => {
    const n = pelar(e);
    if (ts.isIdentifier(n)) return helpersDeColumnas.has(n.text);
    if (ts.isElementAccessExpression(n) && ts.isIdentifier(n.expression) && espaciosAuth.has(n.expression.text)) {
      const k = estatico(n.argumentExpression);
      return k === null || PASAN_COLUMNAS.has(k);
    }
    return ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression) && espaciosAuth.has(n.expression.text) && PASAN_COLUMNAS.has(n.name.text);
  };

  // Los nombres locales de lo que se importa como VALOR de los paquetes de Supabase.
  const clientes = new Set<string>();
  const espaciosClientes = new Set<string>();
  for (const s of sf.statements) {
    if (!ts.isImportDeclaration(s) || !ts.isStringLiteral(s.moduleSpecifier) || !PAQUETES_SUPABASE.has(s.moduleSpecifier.text) || s.importClause?.isTypeOnly) continue;
    if (s.importClause?.name) clientes.add(s.importClause.name.text);
    const b = s.importClause?.namedBindings;
    if (b && ts.isNamespaceImport(b)) espaciosClientes.add(b.name.text);
    if (b && ts.isNamedImports(b)) for (const e of b.elements) if (!e.isTypeOnly) clientes.add(e.name.text);
  }
  /** ¿Las opciones de este cliente cambian sus consultas, o no se pueden leer? */
  const clienteRaro = (c: ts.CallExpression | ts.NewExpression): boolean => {
    let raro = false;
    (c.arguments ?? []).forEach((a, i) => {
      if (ts.isSpreadElement(a)) { raro = true; return; }
      const o = pelar(a);
      // url y key van primero (en `PostgrestClient`, la url sola): desde ahí son opciones.
      const esOpcion = i >= 2 || ts.isObjectLiteralExpression(o);
      if (!esOpcion) return;
      if (!ts.isObjectLiteralExpression(o)) { raro = true; return; }
      const v = (m: ts.Node) => {
        if (ts.isSpreadAssignment(m) || ts.isComputedPropertyName(m)) raro = true;
        if ((ts.isPropertyAssignment(m) || ts.isShorthandPropertyAssignment(m) || ts.isMethodDeclaration(m)) &&
          OPCIONES_DE_CLIENTE.has(m.name.getText().replace(/['"`]/g, ''))) raro = true;
        ts.forEachChild(m, v);
      };
      v(o);
    });
    return raro;
  };

  /** Cómo liga `p` al `nombre`: `'opaca'` (import, parámetro, for, catch, let, var), su inicializador `const`, o nada. */
  const ligadura = (p: ts.Node, nombre: string): 'opaca' | ts.Expression | null => {
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
  const constanteDe = (n: ts.Identifier): ts.Expression | null => {
    if (hayWith || !unica(n.text)) return null;
    for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
      const l = ligadura(p, n.text);
      if (l === 'opaca') return null;
      if (l) return l;
    }
    return null;
  };

  // `Math.min` solo es el de la plataforma si nadie liga ni asigna `Math` en el archivo.
  let tocaMath = veces.has('Math');
  const buscarMath = (m: ts.Node) => {
    if (ts.isBinaryExpression(m) && m.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && m.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
      /^(globalThis\.)?Math\b/.test(m.left.getText())) tocaMath = true;
    ts.forEachChild(m, buscarMath);
  };
  buscarMath(sf);

  /**
   * El valor numérico de `e` si se sabe sin ejecutar nada; `null` si no. Con `cota`, también una
   * cota SUPERIOR (`Math.min(x, 80)`), pero solo arriba de todo: dentro de una resta la cota se
   * invierte (`100 - Math.min(x, 50)` puede valer 5000), así que la aritmética exige valores exactos.
   */
  const resolver = (e: ts.Expression | undefined, prof = 0, cota = false): number | null => {
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
      const cotas = n.arguments.map((a) => resolver(a, prof + 1)).filter((v): v is number => v !== null);
      return cotas.length ? Math.min(...cotas) : null;
    }
    if (!ts.isIdentifier(n)) return null;
    const c = constanteDe(n);
    return c ? resolver(c, prof + 1, cota) : null;
  };

  /** El texto de `e` si se sabe sin ejecutar nada (literales, `+`, templates, `const`); `null` si no. */
  const estatico = (e: ts.Expression | undefined, prof = 0): string | null => {
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

  /** Como `estatico`, pero lo que no se conoce vale vacío: para BUSCAR un embebido, no para leer columnas. */
  const aproximado = (e: ts.Expression, prof = 0): string => {
    if (prof > 8) return '';
    const n = pelar(e);
    const conocido = estatico(n);
    if (conocido !== null) return conocido;
    if (ts.isTemplateExpression(n)) return n.head.text + n.templateSpans.map((sp) => aproximado(sp.expression, prof + 1) + sp.literal.text).join('');
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken) return aproximado(n.left, prof + 1) + aproximado(n.right, prof + 1);
    return '';
  };

  /** Si `externo` es el cuerpo de la página de un `todasLasFilas` real, esa llamada y su función. */
  const paginaDe = (externo: ts.Node): Pagina | null => {
    const p = subir(externo);
    let fn: ts.Node | null = null;
    if (p && ts.isArrowFunction(p) && !ts.isBlock(p.body) && pelar(p.body) === externo) fn = p;
    if (p && ts.isReturnStatement(p)) for (let f: ts.Node | undefined = p.parent; f; f = f.parent) if (ts.isFunctionLike(f)) { fn = f; break; }
    if (!fn || !(ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) return null;
    const call = subir(fn);
    return call && ts.isCallExpression(call) && esElPaginador(call.expression) && call.arguments[0] === fn ? { todas: call, fn } : null;
  };

  /** ¿Se ejecuta ahí mismo, sin que se le pueda encadenar nada más? */
  const cerrada = (externo: ts.Node, llamadas: Llamada[]): boolean => {
    if (llamadas.some((l) => l.metodo === 'then')) return true;
    if (paginaDe(externo)) return true;
    let p = subir(externo);
    let hijo: ts.Node = externo;
    // `await (x ? a.limit(10) : b.limit(10))`: cada rama se juzga por donde termina el ternario.
    while (p && ts.isConditionalExpression(p) && hijo !== p.condition) { hijo = p; p = subir(p); }
    if (!p) return false;
    if (ts.isAwaitExpression(p)) return true;
    if (ts.isArrayLiteralExpression(p)) {
      const call = subir(p);
      return !!call && ts.isCallExpression(call) && /^Promise\.(all|allSettled)$/.test(call.expression.getText());
    }
    let fn: ts.Node | null = null;
    if (ts.isArrowFunction(p) && !ts.isBlock(p.body) && pelar(p.body) === hijo) fn = p;
    if (ts.isReturnStatement(p)) for (let f: ts.Node | undefined = p.parent; f; f = f.parent) if (ts.isFunctionLike(f)) { fn = f; break; }
    if (!fn) return false;
    // Lo que devuelve una función async se resuelve en el `return`: nadie recibe el builder.
    return (ts.getCombinedModifierFlags(fn as ts.Declaration) & ts.ModifierFlags.Async) !== 0;
  };

  /**
   * La página de `todasLasFilas` tiene UNA forma aceptada y cualquier otra es roja. Los chequeos
   * sueltos que hubo antes (¿hay un range? ¿algún orden por id?) se evadieron con un `.limit`
   * después del range, un `id` dentro de un embebido y una clave que no era el id.
   */
  const paginaInvalida = (llamadas: Llamada[], pag: Pagina): string | null => {
    // Con cuerpo de bloque, UNA sentencia: el `return` de la consulta. Un `if (desde >= TOPE)
    // return { data: [], … }` antes corta el paginador en la primera página (ataque E1, medido:
    // 1000 de 1105 con `error: null`), y ese `return` no es una cadena que el guard juzgue.
    if (ts.isBlock(pag.fn.body) && pag.fn.body.statements.length !== 1) return 'la página de todasLasFilas tiene que ser SOLO la consulta: un return temprano corta el paginador';
    const params = pag.fn.parameters.map((p) => p.name.getText());
    // `function (desde, desde, primera)` (no compila en un módulo, pero el barrido no compila) y
    // `range(desde, desde)` calzan por texto con los dos primeros parámetros.
    if (new Set(params).size !== params.length) return 'la página de todasLasFilas pisa sus propios parámetros';
    let pisa = false;
    const v = (m: ts.Node) => {
      const objetivo = ts.isBinaryExpression(m) && m.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && m.operatorToken.kind <= ts.SyntaxKind.LastAssignment ? m.left
        : ts.isPrefixUnaryExpression(m) || ts.isPostfixUnaryExpression(m) ? m.operand : null;
      if (objetivo && ts.isIdentifier(objetivo) && params.includes(objetivo.text)) pisa = true;
      // Un `const ini = 0` en un bloque TAPA el parámetro, y `range(ini, fin)` lo nombra igual.
      if ((ts.isVariableDeclaration(m) || ts.isParameter(m) || ts.isBindingElement(m)) && !pag.fn.parameters.includes(m as ts.ParameterDeclaration) &&
        nombresLigados(m.name).some((x) => params.includes(x))) pisa = true;
      ts.forEachChild(m, v);
    };
    v(pag.fn.body);
    // Los parámetros se recorren también: un default `_r = (desde = 0)` pisa sin tocar el cuerpo.
    for (const p of pag.fn.parameters) if (p.initializer || !ts.isIdentifier(p.name) || p.dotDotDotToken) pisa = true;
    const usaArguments = (m: ts.Node): boolean => (ts.isIdentifier(m) && m.text === 'arguments') || !!ts.forEachChild(m, usaArguments);
    if (usaArguments(pag.fn)) pisa = true;
    if (pisa) return 'la página de todasLasFilas pisa sus propios parámetros';
    const propias = llamadas.filter((l) => l.metodo !== 'returns');
    const ultima = propias.at(-1);
    if (!ultima || ultima.metodo !== 'range') return 'la página de todasLasFilas tiene que terminar en .range(desde, hasta)';
    const [a0, a1, a2] = ultima.nodo.arguments;
    if (!a0 || !a1 || a2 || a0.getText() !== params[0] || a1.getText() !== params[1]) return '.range() dentro de todasLasFilas sin los parámetros de la página';
    if (propias.some((l) => l.metodo === 'limit')) return 'un .limit dentro de la página de todasLasFilas';
    // Los parámetros se LEEN solo en el `.range()` y en la condición del conteo: un filtro u orden
    // que depende de `primera` (`.lt('fecha', primera ? manana : hoy)`, `.order(primera ? 'fecha' :
    // 'created_at')`) cambia la consulta entre páginas (tercera ronda: 1085 y 1089 de 1105).
    const conteoArg = propias.find((l) => l.metodo === 'select')?.nodo.arguments[1];
    const condicion = conteoArg && ts.isConditionalExpression(pelar(conteoArg)) ? pelar((pelar(conteoArg) as ts.ConditionalExpression).condition) : null;
    let fuera = false;
    const w = (m: ts.Node) => {
      if (ts.isIdentifier(m) && params.includes(m.text) && m !== pelar(a0) && m !== pelar(a1) && m !== condicion &&
        !(ts.isPropertyAccessExpression(m.parent) && m.parent.name === m) && !(ts.isPropertyAssignment(m.parent) && m.parent.name === m)) fuera = true;
      ts.forEachChild(m, w);
    };
    w(pag.fn.body);
    if (fuera) return 'la página de todasLasFilas usa sus parámetros fuera del .range() y de la condición del conteo';
    const ordenes = propias.filter((l) => l.metodo === 'order');
    if (ordenes.some((o) => !ts.isStringLiteralLike(o.nodo.arguments[0] ?? o.nodo))) return 'un .order de la página con una columna que no es un literal';
    const booleana = (e: ts.Expression) => e.kind === ts.SyntaxKind.TrueKeyword || e.kind === ts.SyntaxKind.FalseKeyword;
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
    const sel = crudo === null ? null : limpiarSelect(crudo);
    const cols = sel === null ? [] : columnasPropias(sel);
    // En cualquier nivel: `'*, id:usuarios(plan)'` es un embebido llamado `id`, y `columnasPropias`
    // lo borraba antes de mirar (ataque C3).
    if (sel !== null && /(^|[,(])id:/.test(sel)) return 'todasLasFilas con un alias `id:` en el select: pisa el id propio y la clave deja de ser la fila';
    if (sel !== null && sel.includes('...')) return 'todasLasFilas con un spread en el select: aplana columnas ajenas en la fila y su `id` pisa el propio';
    if (!cols.includes('*') && !cols.includes('id')) return 'todasLasFilas con un select sin `id` propio: la clave sale undefined y deduplica todo a una fila';
    if (!esConteoDePagina(selects[0].nodo.arguments[1])) return "todasLasFilas sin count: 'exact' en la primera página";
    // Y condicionado a `primera`, el tercer parámetro: con `desde ? … : …` la primera página va sin
    // conteo y el helper cae a la regla débil (ataque C4).
    const conteo = pelar(selects[0].nodo.arguments[1]!);
    if (ts.isConditionalExpression(conteo) && pelar(conteo.condition).getText() !== params[2]) return "todasLasFilas con el count condicionado a algo que no es el tercer parámetro (`primera`)";
    const clave = pag.todas.arguments[1];
    if (!clave || !ts.isArrowFunction(clave) || clave.parameters.length !== 1 || ts.isBlock(clave.body)) return 'todasLasFilas sin la clave (t) => t.id';
    const cuerpo = pelar(clave.body);
    const esId = ts.isPropertyAccessExpression(cuerpo) && cuerpo.expression.getText() === clave.parameters[0].name.getText() && cuerpo.name.text === 'id';
    return esId ? null : 'todasLasFilas sin la clave (t) => t.id';
  };

  /**
   * El ancho de un `.range(a, b)` con los DOS extremos resueltos. `range(desde, desde + 49)` ya no
   * se acepta: con `desde` string (un `any` de `request.json()`) `desde + 49` concatena, y con
   * `'10'` viajó `offset=10&limit=1040` (tercera ronda).
   */
  const anchoDeRange = (a0: ts.Expression | undefined, a1: ts.Expression | undefined): number | null => {
    const d = resolver(a0);
    const h = resolver(a1);
    return d !== null && h !== null ? h - d + 1 : null;
  };

  /** El veredicto de una cadena de lectura: `null` si está acotada. */
  const veredicto = (externo: ts.Expression, llamadas: Llamada[]): string | null => {
    // Esto va ANTES de la página: el ataque E2 puso `.setHeader('Prefer', 'count=planned')` dentro
    // de una página perfecta y el conteo del planner (subestimado) la cortaba en la primera.
    // Un conteo `estimated`/`planned` miente justo pasando `max_rows`, y entraba por `.limit(1)` o
    // `.maybeSingle()`. Cualquier `select` con `count` que no sea el literal `'exact'` es rojo.
    for (const l of llamadas.filter((x) => x.metodo === 'select')) {
      const malo = conteoMalo(l.nodo.arguments[1]);
      if (malo) return malo;
    }
    // `.setHeader('Prefer', 'count=planned')` pisa el conteo que pidió el select, y nada en la
    // webapp necesita cambiar headers de una lectura de transacciones.
    if (llamadas.some((l) => l.metodo === 'setHeader')) return '.setHeader() en una lectura de transacciones: puede pisar el Prefer del conteo';
    // `.csv()`/`.geojson()`/`.explain()` cambian el `Accept`, y `single`/`maybeSingle` dejan de
    // acotar: `.maybeSingle().csv()` trae un CSV de 1000 líneas con `error: null` (ataque E7).
    const formato = llamadas.find((l) => FORMATOS.has(l.metodo));
    if (formato) return `.${formato.metodo}() en una lectura de transacciones: cambia el formato y single/maybeSingle dejan de acotar`;
    const pag = paginaDe(externo);
    if (pag) return paginaInvalida(llamadas, pag);
    // Una cota fija también tiene que estar CERRADA. Guardada en una variable, se deshace por fuera
    // de la cadena: `.setHeader`, `.csv()`, `Object.assign(q, { method: 'GET' })`,
    // `q.url.searchParams.delete('id')`, `Reflect.set(q, 'isMaybeSingle', false)`… Dos rondas de
    // ataque seguidas encontraron formas nuevas de lo mismo (E4/E7 y S1-S5); prohibirlas una por
    // una era tapar el caso. Lo que nunca sale de la cadena no se puede tocar.
    if (llamadas.some((l, i) => esFija(l, i))) return cerrada(externo, llamadas) ? null : SALE;
    const hasta = llamadas.findIndex((l) => l.metodo === 'then');
    const propias = hasta === -1 ? llamadas : llamadas.slice(0, hasta);
    let ultimo: Llamada | null = null;
    for (const l of propias) {
      if (l.metodo !== 'limit' && l.metodo !== 'range') continue;
      const op = opciones(l.nodo.arguments[l.metodo === 'limit' ? 1 : 2]);
      if (op === 'sucio') return `.${l.metodo}() con opciones que no son un objeto literal: no se puede saber si son del embebido`;
      if (nombraEmbebido(op) && !deEmbebido(op)) return `.${l.metodo}() con un embebido que no es un literal no vacío: postgrest-js lo manda como otra cosa`;
      if (!deEmbebido(op)) ultimo = l;
    }
    if (!ultimo) return 'sin .range/.limit/head:true/filtro por id';
    const [a0, a1] = ultimo.nodo.arguments;
    let filas: number;
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
    // Exacto: `Math.min(1, pedido)` tiene cota 1 pero viaja `limit=NaN` o `limit=-5` (ataque G1).
    return ultimo.metodo === 'limit' && filas === 1 && resolver(a0) === 1 ? null : TOPN_SIN_DECLARAR;
  };

  const lee = (llamadas: Llamada[]) =>
    !llamadas.some((l) => ESCRITURAS.has(l.metodo)) || llamadas.some((l) => l.metodo === 'select' || l.metodo === 'csv');

  // Lo que puede llevar texto: un literal, un template o una suma de ellos. Se mira el MAYOR (la
  // suma entera, no cada pedazo), que es lo que viaja.
  const textual = (n: ts.Node) => ts.isStringLiteralLike(n) || ts.isTemplateExpression(n) ||
    (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken);
  const dentroDeOtroTexto = (n: ts.Node) => {
    const p = subir(n);
    return !!p && (ts.isTemplateSpan(p) || (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.PlusToken));
  };

  const visitar = (n: ts.Node) => {
    if (ts.isCallExpression(n) && nombreMetodo(n.expression, estatico) === 'from' && n.arguments.length >= 1) {
      // postgrest-js arma la URL con `new URL`, que normaliza `./transacciones`: se compara el
      // último segmento, sin query.
      // Solo un identificador limpio se compara. postgrest-js arma `new URL(`${url}/${tabla}`)`, y
      // el parser de URL recorta espacios del final, borra tabs y saltos de línea, pasa `\` a `/`,
      // normaliza `./` y decodifica `%74`: `'transacciones '`, `'.\\transacciones'` y
      // `'%74ransacciones'` llegan como `transacciones` (ataques E9 y T1-T4). Normalizar como lo
      // hace `new URL` sería perseguir al parser; cualquier otra cosa vale como tabla no literal.
      // Tampoco hay excepción de Storage: la webapp no lo usa, y se decidía por el TEXTO del
      // receptor (`const supabase = { storage: cliente }` pasaba, ataque C6).
      const crudo = estatico(n.arguments[0]);
      const tabla = crudo !== null && /^[a-z_][a-z0-9_]*$/.test(crudo) ? crudo : null;
      const receptor = (n.expression as ts.PropertyAccessExpression | ts.ElementAccessExpression).expression.getText();
      // `Array.from(x)` no es una consulta, salvo que `Array` sea un nombre del archivo (ataque R2:
      // `const Map = getServiceClient(); Map.from(T)`).
      const global = NO_SUPABASE.test(receptor) && !veces.has(receptor);
      if ((tabla === null && !global) || (tabla !== null && TABLAS.has(tabla))) {
        const linea = lineaDe(n);
        const { externo, llamadas } = cadena(n, estatico);
        const p = subir(externo);
        const usos: { externo: ts.Expression; llamadas: Llamada[] }[] = [];
        if (llamadas.length === 0 && p && ts.isVariableDeclaration(p) && ts.isIdentifier(p.name) && p.initializer) {
          // El alias pelado (`const base = svc.from(x)`) se juzga en cada uso.
          const nombre = p.name;
          const lista = p.parent;
          // `var` vive en toda la función, no en el bloque donde se escribió.
          const esVar = (lista.flags & (ts.NodeFlags.Const | ts.NodeFlags.Let)) === 0;
          let ambito: ts.Node = p;
          while (ambito.parent && !(esVar ? ts.isFunctionLike(ambito) || ts.isSourceFile(ambito) : ts.isBlock(ambito) || ts.isSourceFile(ambito))) ambito = ambito.parent;
          // En el tope del archivo el alias puede salir por un `export`, y ahí sus usos viven en
          // otro archivo: se juzga además como lo que es acá, una lectura sin cota.
          if (ts.isSourceFile(ambito)) usos.push({ externo, llamadas });
          const v = (m: ts.Node) => {
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
            hallazgos.push({ rel, linea, consulta, motivo: 'tabla no literal que lee: no se puede saber que no es transacciones' });
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
      hallazgos.push({ rel, linea: lineaDe(n), consulta: sinEspacios(n), motivo: SELECT_DINAMICO });
    }
    if (ts.isCallExpression(n) && esHelperDeColumnas(n.expression) && n.arguments.length >= 1 && estatico(n.arguments[0]) === null) {
      hallazgos.push({ rel, linea: lineaDe(n), consulta: sinEspacios(n), motivo: COLUMNAS_DINAMICAS });
    }
    // Y fuera de una llamada directa no se lo puede seguir (`const leer = requireNetoUser`).
    if (ts.isIdentifier(n) && helpersDeColumnas.has(n.text) && !ts.isImportSpecifier(n.parent) && !ts.isFunctionDeclaration(n.parent) &&
      !(ts.isCallExpression(n.parent) && n.parent.expression === n) && !(ts.isPropertyAccessExpression(n.parent) && n.parent.name === n)) {
      hallazgos.push({ rel, linea: lineaDe(n), consulta: sinEspacios(n.parent), motivo: COLUMNAS_DINAMICAS });
    }
    // PostgREST le aplica `max_rows` a CADA nodo del árbol (Plan.hs, treeRestrictRange): un
    // `categorias.select('…, transacciones(monto_pen)')` corta el embebido en 1000 sin avisar. Se
    // mira todo texto del archivo, no solo el argumento del select: las columnas pueden venir de
    // una constante o pasarle a un helper.
    // Con lo que no se conoce como vacío: `transacciones(${campos})` y `'id, transacciones(' + x`
    // también embeben (ataque E10/E11), y un pedazo vacío es una de las cosas que puede valer.
    if (textual(n) && !dentroDeOtroTexto(n) && embebeTransacciones(aproximado(n as ts.Expression))) {
      hallazgos.push({ rel, linea: lineaDe(n), consulta: sinEspacios(n), motivo: EMBEBIDO });
    }
    // Una llamada por clave que no se puede leer (`consulta[metodo](...)`) puede ser un `select`, un
    // `limit` o un `from`, y no hay forma de saber cuál.
    if (ts.isCallExpression(n) && ts.isElementAccessExpression(n.expression) && estatico(n.expression.argumentExpression) === null &&
      !ts.isNumericLiteral(pelar(n.expression.argumentExpression))) {
      hallazgos.push({ rel, linea: lineaDe(n), consulta: sinEspacios(n), motivo: CLAVE_DINAMICA });
    }
    // El estado de una consulta se puede cambiar por fuera de su cadena: `q = q.setHeader('Prefer',
    // 'count=planned')` sobre un conteo guardado en variable (ataque E4) no pasa por ninguna cadena
    // que el guard juzgue. Nada en la webapp lo necesita, así que es rojo en cualquier lugar.
    // Lo mismo con `.csv()` sobre un `.single()` guardado en variable: `q = q.csv()` le saca la
    // cota sin pasar por ninguna cadena juzgada. Ninguno de los cuatro se usa en la webapp.
    const metodoSuelto = ts.isCallExpression(n) ? nombreMetodo(n.expression, estatico) : null;
    if (metodoSuelto === 'setHeader' || (metodoSuelto !== null && FORMATOS.has(metodoSuelto))) {
      hallazgos.push({ rel, linea: lineaDe(n), consulta: sinEspacios(n), motivo: TOCA_LA_CONSULTA });
    }
    if (textual(n) && !dentroDeOtroTexto(n) && aproximado(n as ts.Expression).trim().toLowerCase() === 'prefer') {
      hallazgos.push({ rel, linea: lineaDe(n), consulta: sinEspacios(n), motivo: TOCA_LA_CONSULTA });
    }
    if ((ts.isPropertyAssignment(n) || ts.isShorthandPropertyAssignment(n)) && ts.isIdentifier(n.name) && n.name.text.toLowerCase() === 'prefer') {
      hallazgos.push({ rel, linea: lineaDe(n), consulta: sinEspacios(n), motivo: TOCA_LA_CONSULTA });
    }
    if (ts.isBinaryExpression(n) && n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && n.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
      const izq = pelar(n.left);
      const prop = ts.isPropertyAccessExpression(izq) || ts.isElementAccessExpression(izq) ? nombreMetodo(izq, estatico) : null;
      if (prop !== null && ESTADO_DE_CONSULTA.has(prop)) hallazgos.push({ rel, linea: lineaDe(n), consulta: sinEspacios(n), motivo: TOCA_LA_CONSULTA });
    }
    // Un cliente con `fetch` o headers propios cambia lo que pasa con TODAS sus consultas, y el guard
    // juzga consultas: un fetch que memoiza por ruta le devolvía a la página 2 la página 1 (y la
    // deduplicación la tiraba entera), un header `Range` global se suma a cada página (ataques C1,
    // C2). Se sigue la LIGADURA del import, no el nombre: el árbol real ya importa
    // `createClient as createServiceClient`, y un alias, un `new SupabaseClient` o un
    // `new PostgrestClient` esquivaban el chequeo por nombre (tercera ronda). Fuera de la posición
    // de callee (en una variable, un spread, un tipo no) no se puede seguir: rojo.
    if (ts.isIdentifier(n) && (clientes.has(n.text) || espaciosClientes.has(n.text)) && !esDeclaracionOTipo(n)) {
      let llamada: ts.Node = n;
      if (espaciosClientes.has(n.text) && ts.isPropertyAccessExpression(n.parent) && n.parent.expression === n) llamada = n.parent;
      const p = llamada.parent;
      const esCallee = !!p && (ts.isCallExpression(p) || ts.isNewExpression(p)) && p.expression === llamada;
      if (!esCallee || clienteRaro(p as ts.CallExpression | ts.NewExpression)) {
        hallazgos.push({ rel, linea: lineaDe(n), consulta: sinEspacios(esCallee ? p : n.parent).slice(0, 200), motivo: CLIENTE_RARO });
      }
    }
    if (ts.isCallExpression(n) && (n.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === 'require'))) {
      const spec = n.arguments[0] && estatico(n.arguments[0]);
      if (spec === null || spec === undefined || PAQUETES_SUPABASE.has(spec)) hallazgos.push({ rel, linea: lineaDe(n), consulta: sinEspacios(n), motivo: CLIENTE_RARO });
    }
    // Lo que muta un objeto que ya existe por la puerta de atrás: `Object.assign(q, { method:
    // 'GET' })`, `Object.assign(globalThis, { fetch })` (supabase-js resuelve el fetch global en
    // cada llamada), `Reflect.set(q, 'isMaybeSingle', false)`. Nada de esto se usa en la webapp;
    // `Object.assign({}, …)` sobre un objeto nuevo sí pasa.
    if (ts.isCallExpression(n)) {
      const callee = n.expression.getText().replace(/\s+/g, '');
      const destino = n.arguments[0] && pelar(n.arguments[0]);
      if ((callee === 'Object.assign' && !(destino && ts.isObjectLiteralExpression(destino))) ||
        /^Object\.(defineProperty|defineProperties|setPrototypeOf)$/.test(callee)) {
        hallazgos.push({ rel, linea: lineaDe(n), consulta: sinEspacios(n).slice(0, 200), motivo: TOCA_LA_CONSULTA });
      }
    }
    // Código en un string no se puede analizar (`new Function('svc', "return svc.from(…)")`), y el
    // nombre no hace falta llamarlo para usarlo: `const compilar = Function`, `globalThis.eval`,
    // `(0, eval)(x)` (tercera ronda). Ni `Reflect`, que llama `.from` sin que se vea una llamada.
    if (ts.isIdentifier(n) && ['Function', 'eval', 'Reflect'].includes(n.text) && !esDeclaracionOTipo(n)) {
      hallazgos.push({ rel, linea: lineaDe(n), consulta: sinEspacios(n.parent).slice(0, 200), motivo: 'código armado en un string o llamado por reflexión (eval, Function, Reflect): no se puede saber qué consulta hace' });
    }
    // `svc.from.bind(svc)`, `.call`, `.apply`: el `from` sin llamarlo ahí.
    if (ts.isPropertyAccessExpression(n) && n.name.text === 'from' && ts.isPropertyAccessExpression(n.parent) && n.parent.expression === n &&
      ['bind', 'call', 'apply'].includes(n.parent.name.text)) {
      hallazgos.push({ rel, linea: lineaDe(n), consulta: sinEspacios(n.parent), motivo: 'un .from por bind/call/apply: la consulta no se puede seguir' });
    }
    ts.forEachChild(n, visitar);
  };
  visitar(sf);
  return { hallazgos, lecturas };
}

// Con la cadena ENTERA, no con un fragmento: con `includes`, la tercera ronda del backend
// reescribió lecturas declaradas por los dos lados y siguieron calzando.
const declaradoTopN = (h: Hallazgo) => h.motivo === TOPN_SIN_DECLARAR && TOP_N.some((e) => e.archivo === h.rel && h.consulta === e.consulta);
const exenta = (h: Hallazgo) => declaradoTopN(h) || EXENCIONES.some((e) => e.archivo === h.rel && h.consulta === e.consulta);

// ─── El barrido ──────────────────────────────────────────────────────────────────────────────

const RAIZ = process.cwd();
const SRC = join(RAIZ, 'src');
const OPCIONES_TS = ts.parseJsonConfigFileContent(ts.readConfigFile(join(RAIZ, 'tsconfig.json'), ts.sys.readFile).config, ts.sys, RAIZ).options;

// Fuera queda EXACTAMENTE lo que vitest corre (`include: ['src/**/*.test.ts']`). Con
// `.test.[cm]?[tj]sx?` un helper de runtime llamado `resumen.test.tsx` e importado por una ruta
// salía del barrido (ataque E12): tsc lo compila y Next lo empaqueta igual.
const ES_TEST = /\.test\.ts$/;

function archivos(dir: string): string[] {
  return readdirSync(dir).flatMap((nombre) => {
    const full = join(dir, nombre);
    if (statSync(full).isDirectory()) return archivos(full);
    return /\.[cm]?[tj]sx?$/.test(full) && !ES_TEST.test(full) ? [full] : [];
  });
}

// Todo el código de la raíz entra también, no una lista: los archivos de convención de Next que
// viven fuera de `src/` crecen (`proxy.ts`, `instrumentation-client.ts`), y una lista blanca deja
// afuera al que nadie anotó. Los de configuración no leen nada y pasan solos.
const raiz = readdirSync(RAIZ).filter((f) => /\.[cm]?[tj]sx?$/.test(f) && !ES_TEST.test(f) && statSync(join(RAIZ, f)).isFile()).map((f) => join(RAIZ, f));
// Y todo lo que compila el tsconfig (`**/*.ts` desde la raíz): una carpeta como `webapp/types/`
// entra al build y quedaba fuera de `src/` (tercera ronda). Lo generado en `.next/` no es fuente.
const delTsconfig = ts.parseJsonConfigFileContent(ts.readConfigFile(join(RAIZ, 'tsconfig.json'), ts.sys.readFile).config, ts.sys, RAIZ).fileNames
  .filter((f) => !ES_TEST.test(f) && !/\.d\.ts$/.test(f) && !/[\\/]\.next[\\/]/.test(f));
const rutas = [...new Set([...archivos(SRC), ...raiz, ...delTsconfig].map((f) => join(f)))];
const fuentes: Fuente[] = rutas.map((full) => ({ rel: relative(SRC, full).replace(/\\/g, '/'), ruta: full, contenido: readFileSync(full, 'utf-8') }));
const resultados = fuentes.map((f) => ({ ...f, ...analizar(f.rel, f.contenido) }));
const todos = resultados.flatMap((r) => r.hallazgos);

/** Un fragmento como si fuera `src/lib/fixture.ts`, que importa el paginador real. */
const caso = (cuerpo: string, arriba = '', cabecera = "import { todasLasFilas, TAMANO_PAGINA } from '@/lib/supabase/todas-las-filas';") => analizar(
  'lib/fixture.ts',
  `${cabecera}\n${arriba}\nasync function f(svc: any, u: string, x: boolean, ids: string[], options: any) {\n${cuerpo}\n}`,
).hallazgos.map((h) => h.motivo);

const PAG = "(d, h, p) => svc.from('transacciones').select('*', p ? { count: 'exact' } : undefined)";
const SIN = 'sin .range/.limit/head:true/filtro por id';
const IRRESOLUBLE = /no se puede resolver a un número/;
const GRANDE = /pide más de 100 filas fuera de todasLasFilas/;
const FUERA_DE_TODAS = /\.range\(\) fuera de todasLasFilas/;
const ANCHO = /más ancho que un top-N/;

describe('las lecturas de transacciones no se cortan en 1000 en silencio', () => {
  // Antivacuidad. Cuenta archivos y lecturas analizadas, no defectos: un contador anclado a que
  // el problema siga existiendo se rompe justo cuando se arregla.
  it('el barrido mira algo', () => {
    expect(fuentes.length).toBeGreaterThan(100);
    expect(resultados.reduce((n, r) => n + r.lecturas, 0)).toBeGreaterThanOrEqual(15);
    const conLecturas = resultados.filter((r) => r.lecturas > 0).map((r) => r.rel);
    expect(conLecturas).toContain('app/api/export/route.ts');
    expect(conLecturas).toContain('lib/hooks/use-transactions.ts');
    expect(conLecturas).toContain('app/api/categories/usage/route.ts');
    expect(fuentes.map((f) => f.rel)).toContain('../middleware.ts');
  });

  describe('el detector', () => {
    // Formas realistas de reintroducir el corte. La mayoría las encontraron revisiones
    // adversariales el 01-oct-2026 con el guard en verde. Cada una afirma el MOTIVO, no sólo que
    // hubo un hallazgo: un rojo por otra condición no prueba que esta forma se vea.
    it.each<[string, string, string | RegExp, string?, string?]>([
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
      ['un .limit importado', "await svc.from('transacciones').select('*').limit(LIMITE_EXPORT);", IRRESOLUBLE, "import { LIMITE_EXPORT } from './limites';"],
      ['un .limit con ternario', "await svc.from('transacciones').select('*').limit(x ? 10000 : 50);", IRRESOLUBLE],
      ['un .limit de un parámetro', "await svc.from('transacciones').select('*').limit(options.limit);", IRRESOLUBLE],
      ['un parámetro desestructurado que tapa una const chica', "const limite = 50;\nasync function g({ usuarioId, limite }: any) { return svc.from('transacciones').select('*').eq('usuario_id', usuarioId).limit(limite); }\nawait g({});", IRRESOLUBLE],
      ['un .limit chico pisado por un .range', "await svc.from('transacciones').select('*').limit(100).range(0, options.total - 1);", FUERA_DE_TODAS],
      ['un .range suelto de varias páginas', "await svc.from('transacciones').select('*').range(0, 4999);", FUERA_DE_TODAS],
      ['un todasLasFilas que no es el importado', "await todasLasFilas2((d: number, h: number) => svc.from('transacciones').select('*', { count: 'exact' }).order('id').range(d, h), (t: any) => t.id);", FUERA_DE_TODAS],
      ['todasLasFilas con un range fijo', `await todasLasFilas(${PAG}.order('id').range(0, 99999), (t) => t.id);`, /sin los parámetros de la página/],
      ['todasLasFilas sin orden por id', `await todasLasFilas(${PAG}.order('fecha').range(d, h), (t) => t.id);`, /orden que termine en id/],
      ['todasLasFilas con el id antes de otro orden', `await todasLasFilas(${PAG}.order('id').order('fecha').range(d, h), (t) => t.id);`, /orden que termine en id/],
      ['todasLasFilas con un select sin id', "await todasLasFilas((d, h, p) => svc.from('transacciones').select('monto, monto_pen', p ? { count: 'exact' } : undefined).eq('usuario_id', u).order('id').range(d, h).returns<any[]>(), (t: any) => t.id);", /select sin `id`/],
      ['todasLasFilas sin clave', `await todasLasFilas(${PAG}.order('id').range(d, h));`, /clave \(t\) => t\.id/],
      ['todasLasFilas sin conteo', "await todasLasFilas((d, h) => svc.from('transacciones').select('*').order('id').range(d, h), (t) => t.id);", /count: 'exact'/],
      ['el límite chico en la base, pisado en una rama', "let q = svc.from('transacciones').select('*').limit(50);\nif (x) q = q.limit(10000);\nawait q;", SALE],
      ['el límite chico en las dos ramas de un if', "let q: any;\nif (x) { q = svc.from('transacciones').select('*').limit(50); } else { q = svc.from('transacciones').select('id').limit(50); }\nif (options.todo) q = q.limit(5000);\nawait q;", SALE],
      ['un ternario de builders acotados, paginado después', "const base = x ? svc.from('transacciones').select('*').limit(20) : svc.from('transacciones').select('id').limit(20);\nawait base.range(0, 9999);", SALE],
      ['un helper que recibe el builder acotado', "const tope = (q: any, n: number) => q.order('fecha').limit(n);\nawait tope(svc.from('transacciones').select('*').limit(100), 5000);", SALE],
      ['un builder en la propiedad de un objeto', "function consultas(id: string) { return { tx: svc.from('transacciones').select('*').eq('usuario_id', id).limit(10) }; }\nawait consultas(u).tx.range(0, 9999);", SALE],
      ['un builder devuelto por una función NO async', "const consulta = () => svc.from('transacciones').select('*').limit(10);\nawait consulta().limit(5000);", SALE],
      ['un builder acotado en una variable', "const q = svc.from('transacciones').select('*').limit(10);\nawait q;", SALE],
      ['el alias de la tabla', "const t = svc.from('transacciones');\nawait t.select('*');", SIN],
      ['un alias de la tabla exportado al final', "return 1;\n}\nconst tablaTx = svc.from('transacciones');\nexport { tablaTx };\nfunction g() {", SIN],
      ['un helper que recibe el builder pelado y le pone el select', "const delUsuario = (tabla: any, id: string) => tabla.select('*').eq('usuario_id', id);\nawait delUsuario(svc.from('transacciones'), u);", SIN],
      ['un .limit(TAMANO_PAGINA) después del range de la página', "await todasLasFilas((desde, hasta, primera) => svc.from('transacciones').select('monto_pen, fecha', primera ? { count: 'exact' } : undefined).order('fecha', { ascending: false }).range(desde, hasta).limit(TAMANO_PAGINA), (t: { id: string }) => t.id);", /terminar en \.range/],
      ['la página con .limit y sin .range', "await todasLasFilas((d, h, p) => svc.from('transacciones').select('*', p ? { count: 'exact' } : undefined).order('id').limit(TAMANO_PAGINA), (t: any) => t.id);", /terminar en \.range/],
      ['un id que es del embebido', "await todasLasFilas((d, h, p) => svc.from('transacciones').select('monto_pen, fecha, categorias(nombre, id, icono)', p ? { count: 'exact' } : undefined).order('id').range(d, h), (t: any) => t.id);", /select sin `id` propio/],
      ['un id alias de otra columna', "await todasLasFilas((d, h, p) => svc.from('transacciones').select('id:comercio, monto', p ? { count: 'exact' } : undefined).order('id').range(d, h), (t: any) => t.id);", /alias `id:`/],
      ['una clave que no es el id', "await todasLasFilas((d, h, p) => svc.from('transacciones').select('*', p ? { count: 'exact' } : undefined).order('id').range(d, h), (t: any) => `${t.fecha}|${t.monto}|${t.comercio}`);", /clave \(t\) => t\.id/],
      ['el orden por id de un embebido como último orden', "await todasLasFilas((d, h, p) => svc.from('transacciones').select('*, categorias(id)', p ? { count: 'exact' } : undefined).order('fecha').order('id', { referencedTable: 'categorias' } as const).range(d, h), (t: any) => t.id);", /order de la página/],
      ['el orden de un embebido después del id', "await todasLasFilas((d, h, p) => svc.from('transacciones').select('*, x(*)', p ? { count: 'exact' } : undefined).order('id').order('n', { referencedTable: 'x' }).range(d, h), (t) => t.id);", /order de la página/],
      ['opciones de embebido con as const', "await svc.from('transacciones').select('*, categorias(*)').limit(1, { referencedTable: 'categorias' } as const);", /opciones que no son un objeto literal/],
      ['opciones de embebido en una constante', "const UNA = { referencedTable: 'categorias' };\nawait svc.from('transacciones').select('*, categorias(*)').limit(1, UNA);", /opciones que no son un objeto literal/],
      ['head:true con spread', "await svc.from('transacciones').select('*', { head: true, count: 'exact', ...options });", /opciones que no son un objeto literal/],
      ['una const tapada por la variable de un for-of', "const limite = 100;\nfor (const limite of [100, 5000]) { await svc.from('transacciones').select('*').limit(limite); }", IRRESOLUBLE],
      ['un alias var dentro de un if, usado afuera', "if (x) { var t = svc.from('transacciones'); }\nawait t.select('*');", SIN],
      ['una tabla en constante y un helper que le pone el select', "const TABLA_TX = 'transacciones';\nconst delUsuario = (q: any, id: string) => q.select('*').eq('usuario_id', id);\nawait delUsuario(svc.from(TABLA_TX), u);", SIN],
      ['un .in(id) dentro de una página mal armada', "await todasLasFilas((d, h, p) => svc.from('transacciones').select('fecha, monto_pen, comercio', p ? { count: 'exact' } : undefined).in('id', ids).order('fecha').range(d, h), (t: any) => `${t.fecha}|${t.monto_pen}|${t.comercio}`);", /orden que termine en id/],
      ['la página que pisa su parámetro', "await todasLasFilas((desde, hasta, p) => svc.from('transacciones').select('*', p ? { count: 'exact' } : undefined).eq('n', desde++).order('id').range(desde, hasta), (t: any) => t.id);", /pisa sus propios parámetros/],
      ['la página que pisa su parámetro en un bloque', "await todasLasFilas((desde, hasta, p) => { if (x) desde = 0; return svc.from('transacciones').select('*', p ? { count: 'exact' } : undefined).order('id').range(desde, hasta); }, (t: any) => t.id);", /SOLO la consulta/],
      ['un TAMANO_PAGINA local que tapa el importado', "const TAMANO_PAGINA = 5000;\nawait svc.from('transacciones').select('*').limit(TAMANO_PAGINA);", IRRESOLUBLE],
      ['un todasLasFilas inyectado como parámetro', "async function g(todasLasFilas: any) { return todasLasFilas((d: number, h: number, p: boolean) => svc.from('transacciones').select('*', p ? { count: 'exact' } : undefined).order('id').range(d, h), (t: any) => t.id); }\nawait g(null);", FUERA_DE_TODAS],
      ['un var izado que tapa una const chica', "const LIMITE = 50;\nasync function g(c: boolean) { if (c) { var LIMITE = 5000; } return svc.from('transacciones').select('*').limit(LIMITE); }\nawait g(x);", IRRESOLUBLE],
      ['una tabla en una constante con select', "const T = 'transacciones';\nawait svc.from(T).select('*');", SIN],
      ['una tabla por variable con select', "await svc.from(options.tabla).select('*');", /tabla no literal/],
      // Quinta ronda (01-oct): las evasiones que el backend encontró en su port, reproducidas acá
      // con este guard en VERDE antes de cerrarlas (23 de 25: dos ya salían rojas por otra causa).
      ['(E1) un .limit(TAMANO_PAGINA) sobre una suma', "const { data } = await svc.from('transacciones').select('monto_pen').eq('usuario_id', u).limit(TAMANO_PAGINA);", IRRESOLUBLE],
      ['(E1) un .limit(1000) literal', "await svc.from('transacciones').select('monto_pen').eq('usuario_id', u).limit(1000);", GRANDE],
      ['(E1) un .range de una página entera', "await svc.from('transacciones').select('*').range(0, 999);", ANCHO],
      ['(E5) un loop a mano de a 1000', "for (let desde = 0; ; desde += 1000) { const { data } = await svc.from('transacciones').select('id, monto_pen').eq('usuario_id', u).order('fecha', { ascending: false }).range(desde, desde + 999); if (!data || data.length < 1000) break; }", ANCHO],
      ['(A4) una suma mensual con un "top-N" de 100', "const { data } = await svc.from('transacciones').select('monto_pen').eq('usuario_id', u).order('fecha', { ascending: false }).limit(100);", TOPN_SIN_DECLARAR],
      ['(A3) un loop a mano de a 100', "const POR_PAGINA = 100;\nfor (let desde = 0; ; desde += POR_PAGINA) { const { data } = await svc.from('transacciones').select('monto_pen').eq('usuario_id', u).order('fecha').range(desde, desde + POR_PAGINA - 1); if (!data || data.length < POR_PAGINA) break; }", ANCHO],
      ['(E4) una copia local del paginador con el mismo nombre', `await todasLasFilas(${PAG}.order('id').range(d, h), (t) => t.id);`, FUERA_DE_TODAS, '', "import { todasLasFilas } from './todas-las-filas';"],
      ['(E4) el paginador de otra carpeta por alias', `await todasLasFilas(${PAG}.order('id').range(d, h), (t) => t.id);`, FUERA_DE_TODAS, '', "import { todasLasFilas } from '@/app/todas-las-filas';"],
      ['(E4) un re-export propio del paginador', `await todasLasFilas(${PAG}.order('id').range(d, h), (t) => t.id);`, FUERA_DE_TODAS, '', "import { todasLasFilas } from '@/lib/supabase';"],
      ['(E6) un spread de PostgREST en la página', "await todasLasFilas((d, h, p) => svc.from('transacciones').select('id, fecha, monto_pen, ...categorias(id, nombre)', p ? { count: 'exact' } : undefined).order('fecha').order('id').range(d, h), (t) => t.id);", /spread en el select/],
      ['(R3) un segundo select en la página', "await todasLasFilas((desde, hasta, primera) => svc.from('transacciones').select('*', primera ? { count: 'exact' } : undefined).select('id:categoria_id, monto_pen').order('id').range(desde, hasta), (t) => t.id);", /más de un \.select/],
      ['(R3) un alias id citado', "await todasLasFilas((desde, hasta, primera) => svc.from('transacciones').select('*, \"id\":categoria_id', primera ? { count: 'exact' } : undefined).order('id').range(desde, hasta), (t) => t.id);", /comillas en el select/],
      ['(A8) un alias id: con asterisco', "await todasLasFilas((d, h, p) => svc.from('transacciones').select('*, id:categoria_id', p ? { count: 'exact' } : undefined).order('id').range(d, h), (t) => t.id);", /alias `id:`/],
      ['(R4) embeber transacciones desde otra tabla', "await svc.from('categorias').select('id, nombre, transacciones(monto_pen, tipo)').eq('usuario_id', u);", EMBEBIDO],
      ['(R4) embeber con alias y hint', "await svc.from('usuarios').select('id, txs:transacciones!fk_usuario(monto_pen)').eq('id', u).single();", EMBEBIDO],
      ['(R4) setHeader que pisa el conteo', "await svc.from('transacciones').select('id', { count: 'exact', head: true }).eq('usuario_id', u).setHeader('Prefer', 'count=planned');", /setHeader/],
      ['(R4) count con un espacio adentro', "await todasLasFilas((d, h, p) => svc.from('transacciones').select('*', p ? { count: ' exact' } : undefined).order('id').range(d, h), (t) => t.id);", /count que no es 'exact'/],
      ['(A2) un embebido por variable que en runtime es el limit de primer nivel', "return svc.from('transacciones').select('monto_pen, fecha, categorias(nombre)').eq('usuario_id', u).order('fecha', { ascending: false }).limit(20).limit(options.cuantas ?? 5000, { referencedTable: options.embebido });", /embebido que no es un literal/],
      ['(R3) un embebido vacío', "await svc.from('transacciones').select('*').limit(50).limit(5000, { referencedTable: '' });", /embebido que no es un literal/],
      ['(A5) head:true sin count', "const { count } = await svc.from('transacciones').select('id', { head: true }).eq('usuario_id', u);", SIN],
      ['(A5) head:true con count estimado', "const { count } = await svc.from('transacciones').select('id', { count: 'estimated', head: true }).eq('usuario_id', u);", /count que no es 'exact'/],
      ['(R3) un count estimado con .limit(1)', "await svc.from('transacciones').select('id', { count: 'estimated' }).eq('usuario_id', u).limit(1);", /count que no es 'exact'/],
      ['(R3) un count planeado con maybeSingle', "await svc.from('transacciones').select('id, fecha', { count: 'planned' }).eq('usuario_id', u).limit(1).maybeSingle();", /count que no es 'exact'/],
      ['(A7) un const de bloque que tapa el parámetro de la página', "await todasLasFilas((ini, fin, primera) => { if (x) { const ini = 0; return svc.from('transacciones').select('*', primera ? { count: 'exact' } : undefined).order('id').range(ini, fin); } return svc.from('transacciones').select('*', primera ? { count: 'exact' } : undefined).order('id').range(ini, fin); }, (t) => t.id);", /SOLO la consulta/],
      ['(R3) un default que pisa el parámetro', "await todasLasFilas((desde, hasta, primera, _r = (desde = 0)) => svc.from('transacciones').select('*', primera ? { count: 'exact' } : undefined).order('id').range(desde, hasta), (t) => t.id);", /pisa sus propios parámetros/],
      ['(R4) ascending que cambia entre páginas', "await todasLasFilas((d, h, p) => svc.from('transacciones').select('*', p ? { count: 'exact' } : undefined).order('id', { ascending: p }).range(d, h), (t) => t.id);", /order de la página|usa sus parámetros/],
      ['(R4) la tabla con ./ delante', "await svc.from('./transacciones').select('monto_pen').eq('usuario_id', u);", /tabla no literal/],
      ['(A1) from con un segundo argumento', "await svc.from('transacciones', { schema: 'public' }).select('monto_pen').eq('usuario_id', u);", SIN],
      ['un var izado que tapa el todasLasFilas importado', "if (x) { var todasLasFilas: any = async (c: any) => c(0, 99999, true); }\nawait todasLasFilas((d: number, h: number, p: boolean) => svc.from('transacciones').select('*', p ? { count: 'exact' } : undefined).order('id').range(d, h), (t: any) => t.id);", FUERA_DE_TODAS],
      // Propias de esta ronda: postgrest-js borra los espacios fuera de comillas antes de mandar
      // el select, así que lo que el guard lee tiene que ser lo que viaja.
      ['un alias id: con un espacio en el medio', "await todasLasFilas((d, h, p) => svc.from('transacciones').select('*, i d:categoria_id', p ? { count: 'exact' } : undefined).order('id').range(d, h), (t) => t.id);", /alias `id:`/],
      ['un embebido con un espacio en el nombre', "await svc.from('categorias').select('id, transac ciones(monto_pen)').eq('usuario_id', u);", EMBEBIDO],
      ['un embebido en una constante', "const COLS = 'id, nombre, transacciones(monto_pen)';\nawait svc.from('categorias').select(COLS).eq('usuario_id', u);", EMBEBIDO],
      ['un embebido armado con +', "await svc.from('categorias').select('id, transac' + 'ciones(monto_pen)').eq('usuario_id', u);", EMBEBIDO],
      ['un embebido como spread de PostgREST', "await svc.from('categorias').select('id, ...transacciones(monto_pen)').eq('usuario_id', u);", EMBEBIDO],
      ['un embebido pasado a requireNetoUser', "await requireNetoUser('id, plan, transacciones(monto_pen)');", EMBEBIDO, "import { requireNetoUser } from '@/lib/supabase/auth';"],
      ['un select con columnas armadas en runtime', "await svc.from('categorias').select(['id', options.extra].join(',')).eq('usuario_id', u);", SELECT_DINAMICO],
      ['columnas armadas en runtime a requireNetoUser', "await requireNetoUser(options.cols);", COLUMNAS_DINAMICAS, "import { requireNetoUser } from '@/lib/supabase/auth';"],
      ['un Math propio que miente', "const Math = { min: () => 5000 };\nawait svc.from('transacciones').select('*').limit(Math.min(options.pedido, 50));", IRRESOLUBLE],
      ['un queryFn NO async que devuelve el builder', "const q = { queryFn: () => svc.from('transacciones').select('*').eq('usuario_id', u).limit(5) };\nawait q.queryFn().limit(5000);", SALE],
      // Sexta ronda (01-oct): el ataque sobre ESTE guard, ya portado, ejecutado con el guard verde.
      ['(E1) un return temprano en la página', "await todasLasFilas(async (desde, hasta, primera) => { if (desde >= 1000) return { data: [], error: null, count: null }; return svc.from('transacciones').select('id, monto_pen', primera ? { count: 'exact' } : undefined).eq('usuario_id', u).order('fecha', { ascending: false }).order('id', { ascending: false }).range(desde, hasta); }, (t: { id: string }) => t.id);", /SOLO la consulta/],
      ['(E2) setHeader dentro de una página perfecta', "await todasLasFilas((desde, hasta, primera) => svc.from('transacciones').select('id, monto_pen, fecha', primera ? { count: 'exact' } : undefined).setHeader('Prefer', 'count=planned').eq('usuario_id', u).order('fecha', { ascending: false }).order('id', { ascending: false }).range(desde, hasta), (t) => t.id);", /setHeader|Prefer/],
      ['(E4) un conteo en variable con setHeader después', "let q = svc.from('transacciones').select('id', { count: 'exact', head: true }).eq('usuario_id', u);\nif (x) q = q.setHeader('Prefer', 'count=planned');\nconst { count } = await q;", /sale de la cadena|Prefer/],
      ['(E4) el header Prefer por objeto', "let q = svc.from('transacciones').select('id', { count: 'exact', head: true }).eq('usuario_id', u);\nq.headers = new Headers({ Prefer: 'count=planned' });\nawait q;", /sale de la cadena|Prefer/],
      ['(E4) el method pisado', "const q = svc.from('transacciones').select('monto_pen', { count: 'exact', head: true }).eq('usuario_id', u);\nq['method'] = 'GET';\nawait q;", /sale de la cadena|Prefer/],
      ['(E6) head:true en un segundo select', "await svc.from('transacciones').select('monto_pen').eq('usuario_id', u).select('monto_pen', { count: 'exact', head: true });", SIN],
      ['(E7) maybeSingle y después csv', "await svc.from('transacciones').select('fecha, comercio, monto_pen').eq('usuario_id', u).order('fecha', { ascending: false }).maybeSingle().csv();", /\.csv\(\)|Prefer/],
      ['(E7) un single en variable, csv después', "let q = svc.from('transacciones').select('*').eq('usuario_id', u).single();\nif (x) q = q.csv();\nawait q;", /sale de la cadena|Prefer/],
      ['(E8) un embebido con hint y join type', "await svc.from('categorias').select('id, nombre, transacciones!transacciones_categoria_id_fkey!inner(monto_pen)').eq('usuario_id', u);", EMBEBIDO],
      ['(E9) la tabla codificada', "await svc.from('%74ransacciones').select('monto_pen').eq('usuario_id', u);", /tabla no literal/],
      ['(E10) requireNetoUser con alias y un template', "await usuarioConColumnas(`id, plan, transacciones(${options.campos.join(',')})`);", /embebe transacciones|helper que las pasa/, "import { requireNetoUser as usuarioConColumnas } from '@/lib/supabase/auth';"],
      ['(E10) requireNetoUser por alias de variable', "const leer = requireNetoUser;\nawait leer(options.cols);", COLUMNAS_DINAMICAS, "import { requireNetoUser } from '@/lib/supabase/auth';"],
      ['(E11) el select por clave en una constante', "const LEER = 'select' as const;\nawait svc.from('categorias')[LEER](`id, nombre, transacciones(${options.campos})`).eq('usuario_id', u);", /embebe transacciones|columnas que no son texto/],
      ['(E11) un método por clave dinámica', "await svc.from('transacciones')[options.metodo]('monto_pen').eq('usuario_id', u);", /clave que no es texto|sin \.range/],
      ['(R2) un receptor con nombre de global', "const Map = svc;\nawait Map.from(['transac', 'ciones'].join('')).select('monto_pen');", /tabla no literal/],
      ['(R3) la consulta dentro de un string', "const q = new Function('svc', 'u', \"return svc.from('transacciones').select('monto_pen').eq('usuario_id', u)\");\nawait q(svc, u);", /código armado en un string/],
      ['(R1) un limit negativo', "await svc.from('transacciones').select('monto_pen').eq('usuario_id', u).limit(0 - 1);", /no es un número positivo/],
      // Séptima ronda (01-oct): el segundo ataque, sobre el guard ya cerrado una vez.
      ['(T1) la tabla con un espacio al final', "await svc.from('transacciones ').select('monto_pen').eq('usuario_id', u).gte('fecha', '2026-01-01');", /tabla no literal/],
      ['(T2) la tabla en un template con salto de línea', "await svc.from(`transacciones\n`).select('monto_pen').eq('usuario_id', u);", /tabla no literal/],
      ['(T3) la tabla en una constante con tab', "const TABLA_TX = 'transacciones\t';\nawait svc.from(TABLA_TX).select('monto_pen').eq('usuario_id', u);", /tabla no literal/],
      ['(T4) la tabla con barra invertida', "await svc.from('.\\\\transacciones').select('monto_pen').eq('usuario_id', u);", /tabla no literal/],
      ['(S1) un single en variable con el Accept borrado', "const q = svc.from('transacciones').select('*').eq('usuario_id', u).single();\n(q as unknown as { headers: Headers }).headers.delete('Accept');\nawait q;", SALE],
      ['(S2) un eq(id) en variable con el filtro borrado de la URL', "const q = svc.from('transacciones').select('*').eq('id', u);\n(q as unknown as { url: URL }).url.searchParams.delete('id');\nawait q;", SALE],
      ['(S3) un conteo en variable con Object.assign', "const q = svc.from('transacciones').select('monto_pen', { count: 'exact', head: true }).eq('usuario_id', u);\nObject.assign(q, { method: 'GET' });\nawait q;", /sale de la cadena|cambia el estado|reflexión/],
      ['(S4) un maybeSingle en variable con Reflect.set', "const q = svc.from('transacciones').select('*').eq('usuario_id', u).maybeSingle();\nReflect.set(q, 'isMaybeSingle', false);\nawait q;", /sale de la cadena|cambia el estado|reflexión/],
      ['(S) un conteo dentro de Object.assign', "await Object.assign(svc.from('transacciones').select('monto_pen', { count: 'exact', head: true }).eq('usuario_id', u), { method: 'GET' });", /sale de la cadena|cambia el estado|reflexión/],
      ['(C1) un cliente con un fetch propio', "const c = createClient(url, key, { global: { fetch: fetchConCache } });", /cliente de Supabase/, "import { createClient } from '@supabase/supabase-js';"],
      ['(C2) un cliente con headers globales', "const c = createServerClient(url, key, { cookies: {}, global: { headers: { Range: '0-999' } } });", /cliente de Supabase/, "import { createServerClient } from '@supabase/ssr';"],
      ['un cliente con opciones que no se pueden leer', "const c = createClient(url, key, options);", /cliente de Supabase/, "import { createClient } from '@supabase/supabase-js';"],
      ['(C3) un embebido llamado id en la página', "await todasLasFilas((d, h, p) => svc.from('transacciones').select('*, id:usuarios(plan)', p ? { count: 'exact' } : undefined).order('id').range(d, h), (t) => t.id);", /alias `id:`/],
      ['(C4) el conteo de la página condicionado a desde', "await todasLasFilas((desde, hasta, primera) => svc.from('transacciones').select('*', desde ? { count: 'exact' } : undefined).order('id').range(desde, hasta), (t) => t.id);", /tercer parámetro/],
      ['(C6) un objeto con forma de supabase.storage', "const supabase = { storage: svc };\nawait supabase.storage.from(options.tabla).select('monto_pen').eq('usuario_id', u);", /tabla no literal/],
      ['(B1) embeber por el nombre de la FK', "await svc.from('usuarios').select('id, transacciones_usuario_id_fkey(monto_pen)').eq('id', u).single();", EMBEBIDO],
      ['(B2) el nombre de la FK a requireNetoUser', "await requireNetoUser('id, plan, transacciones_usuario_id_fkey(monto_pen, fecha)');", EMBEBIDO, "import { requireNetoUser } from '@/lib/supabase/auth';"],
      ['(G1) un Math.min con un 1 que no es el valor', "await svc.from('transacciones').select('monto_pen').eq('usuario_id', u).limit(Math.min(1, options.pedido));", TOPN_SIN_DECLARAR],
      ['una cota de Math.min invertida por una resta', "await svc.from('transacciones').select('monto_pen').eq('usuario_id', u).limit(100 - Math.min(options.pedido, 50));", IRRESOLUBLE],
      ['un conteo en variable con filtros condicionales', "let q = svc.from('transacciones').select('*', { count: 'exact', head: true });\nif (x) q = q.eq('tipo', 'g');\nawait q;", SALE],
      ['un conteo devuelto por una función NO async', "return 1;\n}\nexport function contarTx(svc: any, u: string) { return svc.from('transacciones').select('id', { count: 'exact', head: true }).eq('usuario_id', u);", SALE],
      ['un bucket de Storage por variable', "await supabase.storage.from(options.bucket).list(u, { limit: 1000 });", /tabla no literal/],
      // Octava ronda (01-oct): el tercer ataque. Lo que es del CLIENTE o de la PÁGINA en runtime lo
      // cierra además `todasLasFilas` (filas distintas < conteo = error) y `auth.ts` (columnas con
      // un embebido = error); estos fijan la parte sintáctica.
      ['(A01) createClient importado con alias y un fetch propio', "const c = crearClienteSupabase(url, key, { global: { fetch: fetchDeduplicado } });", /cliente de Supabase/, "import { createClient as crearClienteSupabase } from '@supabase/supabase-js';"],
      ['(A01) el alias que ya usa el árbol, con opciones limpias', "const c = createServiceClient(url, key, { auth: { persistSession: false }, global: { headers: { Range: '0-999' } } });", /cliente de Supabase/, "import { createClient as createServiceClient } from '@supabase/supabase-js';"],
      ['(A02) new SupabaseClient con un fetch', "const c = new SupabaseClient(url, key, { global: { fetch } });", /cliente de Supabase/, "import { SupabaseClient } from '@supabase/supabase-js';"],
      ['(A03) new PostgrestClient con un fetch', "const c = new PostgrestClient(`${url}/rest/v1`, { headers: { apikey: key }, fetch });", /cliente de Supabase/, "import { PostgrestClient } from '@supabase/postgrest-js';"],
      ['(A04) Object.assign sobre globalThis', "Object.assign(globalThis, { fetch: fetchDeduplicado });", /cambia el estado/],
      ['(A04b) Object.assign sobre el rest del cliente', "Object.assign((svc as unknown as { rest: object }).rest, { fetch: fetchDeduplicado });", /cambia el estado/],
      ['(A19) createClient en una variable', "const crear = createClient;\nconst c = crear(url, key);", /cliente de Supabase/, "import { createClient } from '@supabase/supabase-js';"],
      ['(A19) createClient por namespace con corchetes', "const c = supabaseJs['createClient'](url, key, { global: { fetch } });", /cliente de Supabase|clave/, "import * as supabaseJs from '@supabase/supabase-js';"],
      ['(A19) createClient con argumentos en spread', "const c = createClient(...argumentos);", /cliente de Supabase/, "import { createClient } from '@supabase/supabase-js';"],
      ['(A19) createServerClient con alias', "const c = crearServidor(url, key, { cookies: {}, global: { fetch } });", /cliente de Supabase/, "import { createServerClient as crearServidor } from '@supabase/ssr';"],
      ['un import dinámico de supabase-js', "const { createClient } = await import('@supabase/supabase-js');", /cliente de Supabase/],
      ['(B05) un filtro de la página que depende de primera', "await todasLasFilas((desde, hasta, primera) => svc.from('transacciones').select('id, fecha, monto_pen', primera ? { count: 'exact' } : undefined).eq('usuario_id', u).lt('fecha', primera ? options.manana : options.hoy).order('fecha', { ascending: false }).order('id', { ascending: false }).range(desde, hasta), (t) => t.id);", /usa sus parámetros/],
      ['(B06) la columna de un orden que depende de primera', "await todasLasFilas((desde, hasta, primera) => svc.from('transacciones').select('id, fecha', primera ? { count: 'exact' } : undefined).order(primera ? 'fecha' : 'created_at', { ascending: false }).order('id', { ascending: false }).range(desde, hasta), (t) => t.id);", /usa sus parámetros|columna que no es un literal/],
      ['una columna de orden en una variable', "await todasLasFilas((desde, hasta, primera) => svc.from('transacciones').select('id, fecha', primera ? { count: 'exact' } : undefined).order(options.col).order('id').range(desde, hasta), (t) => t.id);", /columna que no es un literal/],
      ['(C09) un helper de auth por namespace con corchetes', "await auth['requireLectura'](`id, ${options.cols}`);", COLUMNAS_DINAMICAS, "import * as auth from '@/lib/supabase/auth';"],
      ['(C10) un helper de auth con ./ en el specifier', "await requireLectura(`id, plan, ${options.rel}(monto_pen)`);", COLUMNAS_DINAMICAS, "import { requireLectura } from '@/lib/supabase/./auth';"],
      ['(11) Function en una variable', "const compilar = Function;\nawait compilar('svc', 'u', options.codigo)(svc, u);", /reflexión/],
      ['(11) globalThis.eval', "await globalThis.eval(options.codigo);", /reflexión/],
      ['(11) eval indirecto', "await (0, eval)(options.codigo);", /reflexión/],
      ['(12) Reflect.apply sobre from', "await Reflect.apply(svc.from, svc, ['transacciones']).select('monto_pen');", /reflexión/],
      ['un from por bind', "const desde = svc.from.bind(svc);\nawait desde('transacciones').select('monto_pen');", /bind\/call\/apply/],
      ['(13) un range relativo a un desde que puede ser string', "const desde = options.desde;\nawait svc.from('transacciones').select('*').order('fecha').range(desde, desde + 49);", ANCHO],
      ['(era FP) paginación de UI con desde + N - 1', "const POR_PAGINA = 20;\nconst desde = options.pagina * POR_PAGINA;\nawait svc.from('transacciones').select('*').order('fecha').range(desde, desde + POR_PAGINA - 1);", ANCHO],
      ['un Math.min reasignado', "Math.min = () => 5000;\nawait svc.from('transacciones').select('*').limit(Math.min(options.pedido, 50));", IRRESOLUBLE],
    ])('ve %s', (_n, cuerpo, motivo, arriba, cabecera) => {
      const motivos = cabecera ? caso(cuerpo, arriba, cabecera) : caso(cuerpo, arriba);
      expect(motivos.length, JSON.stringify(motivos)).toBeGreaterThanOrEqual(1);
      expect(motivos.every((m) => (typeof motivo === 'string' ? m === motivo : motivo.test(m))), JSON.stringify(motivos)).toBe(true);
    });

    // Y no grita sobre lo que está bien: un detector que marca todo lleva a llenar EXENCIONES
    // y deja de mirar. Los marcados con (FP) fueron falsos positivos de revisiones anteriores.
    it.each<[string, string, string?, string?]>([
      ['todasLasFilas con .range', `await todasLasFilas(${PAG}.order('id').range(d, h), (t) => t.id);`],
      ['todasLasFilas importado con otro nombre por ruta relativa', "await paginar((d, h, p) => svc.from('transacciones').select('id, monto', p ? { count: 'exact' } : undefined).order('id').range(d, h), (t: any) => t.id);", "import { todasLasFilas as paginar } from './supabase/todas-las-filas';"],
      ['todasLasFilas con la extensión en el specifier', `await todasLasFilas(${PAG}.order('id').range(d, h), (t) => t.id);`, '', "import { todasLasFilas } from '@/lib/supabase/todas-las-filas.ts';"],
      ['la página con return en vez de cuerpo de expresión', `await todasLasFilas((d, h, p) => { return svc.from('transacciones').select('*', p ? { count: 'exact' } : undefined).order('id').range(d, h); }, (t) => t.id);`],
      ['la página con orden fecha, created_at e id', "await todasLasFilas((d, h, p) => svc.from('transacciones').select('id, monto_pen, fecha', p ? { count: 'exact' } : undefined).eq('usuario_id', u).order('fecha', { ascending: false }).order('created_at', { ascending: false }).order('id', { ascending: false }).range(d, h), (t) => t.id);"],
      ['la página con las columnas en una constante', "const COLS = 'id, monto_pen, ' + 'fecha';\nawait todasLasFilas((d, h, p) => svc.from('transacciones').select(COLS, p ? { count: 'exact' } : undefined).order('id').range(d, h), (t) => t.id);"],
      ['un conteo', "await svc.from('transacciones').select('id', { count: 'exact', head: true }).eq('usuario_id', u);"],
      ['un conteo cerrado en un ternario de dos cadenas', "const { count } = await (x ? svc.from('transacciones').select('*', { count: 'exact', head: true }).eq('usuario_id', u).eq('tipo', 'g') : svc.from('transacciones').select('*', { count: 'exact', head: true }).eq('usuario_id', u));"],
      ['un cliente con opciones de auth', "const c = createClient(url, key, { auth: { persistSession: false } });", "import { createClient } from '@supabase/supabase-js';"],
      ['un cliente con alias y solo url y key', "const c = createServiceClient(url, key);", "import { createClient as createServiceClient } from '@supabase/supabase-js';"],
      ['el tipo del cliente importado como valor', "let c: SupabaseClient | null = null;", "import { createClient, SupabaseClient } from '@supabase/supabase-js';"],
      ['Object.assign sobre un objeto nuevo', "const o = Object.assign({}, options, { x: 1 });"],
      ['(FP) una por id devuelta por una función exportada', "return 1;\n}\nexport async function unaTx(svc: any, id: string) { return svc.from('transacciones').select('*').eq('id', id).single();"],
      ['un limit(1) para la última', "await svc.from('transacciones').select('id').eq('usuario_id', u).order('created_at', { ascending: false }).limit(1);"],
      ['por id', "await svc.from('transacciones').select('*').eq('id', u).single();"],
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
      ['requireNetoUser con columnas estáticas', "await requireNetoUser('id, plan');", "import { requireNetoUser } from '@/lib/supabase/auth';"],
      ['Array.from', "Array.from(new Set([1])).map((n) => n);"],
      ['Buffer.from con una variable', "Buffer.from(u).toString('base64');"],
      ['(FP) todasLasFilas por namespace', "await paginacion.todasLasFilas((d, h, p) => svc.from('transacciones').select('*', p ? { count: 'exact' } : undefined).order('id').range(d, h), (t: any) => t.id);", "import * as paginacion from '@/lib/supabase/todas-las-filas';"],
      ['(FP) la página con el cuerpo entre paréntesis', "await todasLasFilas((d, h, p) => (\n  svc.from('transacciones').select('*', p ? { count: 'exact' } : undefined).order('id').range(d, h)\n), (t) => t.id);"],
      ['un .in(id) dentro de una página bien armada', "await todasLasFilas((d, h, p) => svc.from('transacciones').select('*', p ? { count: 'exact' } : undefined).in('id', ids).order('id').range(d, h), (t) => t.id);"],
    ])('no marca %s', (_n, cuerpo, arriba, cabecera) => {
      expect(cabecera ? caso(cuerpo, arriba, cabecera) : caso(cuerpo, arriba)).toEqual([]);
    });

    // Un top-N bien armado no es rojo por su forma: es rojo hasta que alguien lo DECLARA en TOP_N,
    // porque solo quien lo escribe sabe si la respuesta muestra N filas o las suma.
    it.each<[string, string]>([
      ['un limit chico', "await svc.from('transacciones').select('*').limit(5);"],
      ['un limit por constante chica de un ámbito de arriba', "const MAX = 2 * 3;\nconst g = async () => svc.from('transacciones').select('*').limit(MAX);\nawait g();"],
      ['un limit chico dentro de Promise.all', "await Promise.all([svc.from('transacciones').select('*').limit(5), svc.from('x').select('*')]);"],
      ['un limit chico con .then', "svc.from('transacciones').select('*').limit(5).then((r: any) => r);"],
      ['un range chico', "await svc.from('transacciones').select('*').order('fecha').range(0, 49);"],
      ['(era FP) un queryFn async con limit chico', "const q = { queryFn: async () => svc.from('transacciones').select('*').eq('usuario_id', u).limit(5) };\nawait q.queryFn();"],
      ['(era FP) un Math.min con un tope chico', "await svc.from('transacciones').select('*').limit(Math.min(options.pedido || 50, 80));"],
      ['(era FP) una const as const', "const LIMITE = 50 as const;\nawait svc.from('transacciones').select('*').limit(LIMITE);"],
      ['(era FP) un ternario de cadenas acotadas dentro del await', "await (x ? svc.from('transacciones').select('*').order('fecha').limit(10) : svc.from('transacciones').select('*').order('monto').limit(10));"],
    ])('pide declarar como top-N %s', (_n, cuerpo) => {
      const motivos = caso(cuerpo);
      expect(motivos).toEqual(expect.arrayContaining([TOPN_SIN_DECLARAR]));
      expect(motivos.every((m) => m === TOPN_SIN_DECLARAR), JSON.stringify(motivos)).toBe(true);
    });
  });

  it('ninguna lectura de transacciones del código queda sin cota', () => {
    const culpables = todos.filter((h) => !exenta(h)).map((h) => `${h.rel}:${h.linea}  ${h.motivo}\n    ${h.consulta}`);
    expect(
      culpables,
      'Una lectura de transacciones sin cota devuelve como mucho 1000 filas sin avisar. Si necesita ' +
        'todas, pásala a `todasLasFilas` (lib/supabase/todas-las-filas.ts) con un orden que termine ' +
        'en `id` y clave `(t) => t.id`. Si muestra las N últimas y no suma, decláralo en TOP_N con su ' +
        'motivo. Si está acotada por otra razón, va a EXENCIONES con una premisa verificable.',
    ).toEqual([]);
  });

  it('una lectura declarada que se reescribe por adelante o por atrás deja de calzar', () => {
    const e = TOP_N[0];
    if (!e) return;
    const h = (consulta: string): Hallazgo => ({ rel: e.archivo, linea: 1, consulta, motivo: TOPN_SIN_DECLARAR });
    expect(declaradoTopN(h(e.consulta))).toBe(true);
    expect(declaradoTopN(h(e.consulta + '.range(0,99)'))).toBe(false);
    expect(declaradoTopN(h('x' + e.consulta))).toBe(false);
  });

  it.each(TOP_N.length ? TOP_N : [null])('el top-N declarado %# sigue calzando con UNA lectura', (e) => {
    if (!e) return;
    const calzan = todos.filter((h) => h.motivo === TOPN_SIN_DECLARAR && h.rel === e.archivo && h.consulta === e.consulta);
    expect(calzan, `top-N vencido: "${e.consulta}" ya no está en ${e.archivo}`).toHaveLength(1);
  });

  it('(I1) la premisa de la exención de import no se deja tapar CHUNK por un const de bloque', () => {
    const e = EXENCIONES.find((x) => x.archivo === 'app/api/transactions/import/route.ts')!;
    const real = fuentes.find((f) => f.rel === e.archivo)!.contenido;
    expect(e.premisa(real)).toBe(true);
    const sombra = real.replace('  for (let i = 0; i < toInsert.length; i += CHUNK) {', '  { const CHUNK = Number(process.env.IMPORT_CHUNK) || 200;\n  for (let i = 0; i < toInsert.length; i += CHUNK) {');
    expect(sombra).not.toBe(real);
    expect(e.premisa(sombra)).toBe(false);
  });

  it('(tercera ronda) las premisas no se dejan engañar por un cambio adentro de lo exento', () => {
    const premisa = (archivo: string) => EXENCIONES.find((e) => e.archivo === archivo)!.premisa;
    const de = (archivo: string) => fuentes.find((f) => f.rel === archivo)!.contenido;
    const tx = de('lib/hooks/use-transactions.ts');
    const uso = de('app/api/categories/usage/route.ts');
    const imp = de('app/api/transactions/import/route.ts');
    const casos: [string, string, string][] = [
      // UT1: un select sin id adentro de `armar` (la clave sale undefined: 1 fila de 1105).
      ['lib/hooks/use-transactions.ts', tx, tx.replace("if (options.tipo) query = query.eq('tipo', options.tipo);", "if (options.tipo) query = query.eq('tipo', options.tipo);\n        if (options.soloMontos) query = query.select('fecha, monto_pen, tipo');")],
      // UT2: un filtro que depende de `conteo` (1085 de 1105).
      ['lib/hooks/use-transactions.ts', tx, tx.replace("if (options.tipo) query = query.eq('tipo', options.tipo);", "if (!conteo) query = query.lt('fecha', new Date().toISOString().slice(0, 10));\n        if (options.tipo) query = query.eq('tipo', options.tipo);")],
      // `\u0071` es `q` para JavaScript y no para una regex.
      ['app/api/categories/usage/route.ts', uso, uso.replace('  if (sub) q = q.filter(', "  if (searchParams.has('rapido')) (\\u0071 as unknown as { headers: Headers }).headers.set('Prefer', 'count=estimated');\n  if (sub) q = q.filter(")],
      // El insert en otra función, con un lote de 5000.
      ['app/api/transactions/import/route.ts', imp, imp.replace('    const chunk = toInsert.slice(i, i + CHUNK);', '    const chunk = toInsert.length <= 5000 ? toInsert : toInsert.slice(i, i + CHUNK);')],
    ];
    for (const [archivo, real, modificado] of casos) {
      expect(modificado, archivo).not.toBe(real);
      expect(premisa(archivo)(real), archivo).toBe(true);
      expect(premisa(archivo)(modificado), archivo).toBe(false);
    }
  });

  it('ningún archivo de runtime importa un test (lo que está fuera del barrido)', () => {
    const importaTests = fuentes.flatMap((f) => {
      const sf = ts.createSourceFile(f.rel, f.contenido, ts.ScriptTarget.Latest, true, /\.tsx$/.test(f.rel) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
      const specs: string[] = [];
      const v = (m: ts.Node) => {
        if ((ts.isImportDeclaration(m) || ts.isExportDeclaration(m)) && m.moduleSpecifier && ts.isStringLiteral(m.moduleSpecifier)) specs.push(m.moduleSpecifier.text);
        if (ts.isCallExpression(m) && (m.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(m.expression) && m.expression.text === 'require'))) {
          const a = m.arguments[0];
          specs.push(a && ts.isStringLiteralLike(a) ? a.text : '<dinámico>');
        }
        ts.forEachChild(m, v);
      };
      v(sf);
      // Se RESUELVE cada specifier como lo hace TypeScript con el tsconfig del proyecto: un
      // `package.json` con `main` apuntando a un `.test.ts` se importaba como `'./carpeta'` (ataque
      // P1). Un import dinámico con un specifier que no es literal tampoco se puede seguir.
      return specs.filter((sp) => {
        if (sp === '<dinámico>') return true;
        const r = ts.resolveModuleName(sp, f.ruta, OPCIONES_TS, ts.sys).resolvedModule;
        return /\.test(\.[cm]?[tj]sx?)?$/.test(sp) || (!!r && ES_TEST.test(r.resolvedFileName));
      }).map((sp) => `${f.rel}: ${sp}`);
    });
    expect(importaTests).toEqual([]);
  });

  it('no hay package.json dentro de src (cambia a qué archivo resuelve un import)', () => {
    const buscar = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
      const full = join(dir, n);
      return statSync(full).isDirectory() ? buscar(full) : n === 'package.json' ? [relative(RAIZ, full)] : [];
    });
    expect(buscar(SRC)).toEqual([]);
  });

  it.each(EXENCIONES)('la exención de $archivo sigue calzando con UNA lectura y su premisa se cumple', (e) => {
    const calzan = todos.filter((h) => h.rel === e.archivo && h.consulta === e.consulta);
    expect(calzan, `exención vencida: "${e.consulta}" ya no está en ${e.archivo}`).toHaveLength(1);
    const contenido = fuentes.find((f) => f.rel === e.archivo)!.contenido;
    expect(e.premisa(contenido), `la premisa de la exención ya no se cumple: ${e.motivo}`).toBe(true);
  });
});
