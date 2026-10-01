import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { TAMANO_PAGINA } from './supabase/todas-las-filas';

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
 * seguidas la dejaron verde con 13 y 7 evasiones: siempre quedaba una forma sin seguir (un
 * ternario, un bloque, una propiedad, un helper que recibe el builder). Como postgrest-js aplica el
 * ÚLTIMO `.limit`/`.range`, cualquier uso que el guard no vea puede reabrir la consulta. Así que
 * ya no sigue nada. Mira la cadena que nace en `.from('transacciones')` y acepta tres cosas:
 *
 * 1. **Una cota que nada posterior puede deshacer**: `.single()`, `.maybeSingle()`,
 *    `.eq('id', …)`, `.in('id', …)` o `head: true` en un `select` con opciones literales limpias.
 * 2. **La página de un `todasLasFilas` importado de su módulo (directo o por namespace), con UNA
 *    forma**: termina en `.range(desde, hasta)` con los parámetros de la página, sin `.limit`; sus
 *    `.order` llevan a lo sumo `{ ascending }` y el último es por `id`; el `select` trae `id` o `*`
 *    entre sus columnas PROPIAS (un `id` dentro de un embebido no cuenta: la clave saldría
 *    `undefined` y la deduplicación dejaría UNA fila); pide `count: 'exact'`; y la clave es
 *    exactamente `(t) => t.id`. La tercera revisión evadió los chequeos sueltos que había antes
 *    con un `.limit` después del range, un `id` de embebido y una clave compuesta.
 * 3. **Un `.limit`/`.range` válido como ÚLTIMO limitador de una cadena CERRADA**, o sea una que
 *    se ejecuta ahí mismo: `await` directo (también a través de un ternario), elemento de un
 *    `Promise.all([...])`, retorno de una función `async`, el `queryFn` de React Query, o un
 *    `.then(...)`. Válido es `.limit(n)` con `n` <= 1000 resuelto (literal, `const` del ámbito con
 *    aritmética, `TAMANO_PAGINA`, o un `Math.min` con algún argumento chico; un import cualquiera,
 *    un `let`, un parámetro o la variable de un `for` no se resuelven y fallan), o un `.range` de
 *    ancho resuelto <= 1000 (`range(desde, desde + N - 1)` incluido). Un `.limit`/`.range` con
 *    `{ referencedTable }` literal es del embebido y no cuenta; con opciones que no son un objeto
 *    literal limpio (spread, `as`, una variable) falla, porque no se sabe de quién son.
 *
 * Todo lo demás es rojo: un builder que sale a una variable, un argumento o una propiedad, aunque
 * lleve un `.limit(10)` perfecto, porque alguien puede pisarlo después. Si de verdad está bien, se
 * cierra en el lugar o va a EXENCIONES con una premisa verificable.
 *
 * Una cadena sin escritura (`insert/update/upsert/delete`) cuenta como lectura aunque no tenga
 * `select`: un helper puede ponérselo. El alias pelado (`const t = svc.from('x')`) se juzga en cada
 * uso (`var` en toda la función), que es la forma de `category-cascade.ts`; exportado, se juzga
 * como lectura sin cota, porque sus usos viven en otro archivo. Una tabla no literal que lee falla.
 *
 * Lo que NO ve, declarado: `.in('id', lista)` no mira el largo de la lista (con miles de ids la URL
 * revienta antes); `.rpc()`, un `fetch` directo a `/rest/v1/transacciones` y las vistas (hoy no
 * hay ninguna sobre `transacciones`) quedan fuera; un wrapper propio de `todasLasFilas` es rojo
 * (no se puede saber que pagina igual); un `queryFn` se acepta por el NOMBRE de la propiedad, así
 * que una fábrica de opciones cuyo `queryFn()` se llame a mano en otro lado no se ve; y `.from`
 * por `.bind`/`.call` tampoco.
 */

const TABLAS = new Set(['transacciones']);
const TOPE = TAMANO_PAGINA; // el `max_rows` de PostgREST en este proyecto

interface Fuente { rel: string; contenido: string }

/**
 * Lecturas que el guard no puede probar acotadas y están bien por otra razón. Cada una se ancla al
 * TEXTO de la cadena (sin espacios) y a una premisa que se verifica contra el archivo: si cambia la
 * consulta la exención deja de calzar, y si cambia la premisa el test de abajo falla.
 */
const EXENCIONES: {
  archivo: string;
  consulta: string;
  motivo: string;
  premisa: (contenido: string) => boolean;
}[] = [
  {
    archivo: 'app/api/transactions/import/route.ts',
    consulta: ".from('transacciones').insert(chunk).select('id')",
    motivo:
      'devuelve las filas que acaba de insertar, en lotes de CHUNK: mientras el lote no pase de ' +
      '1000, la respuesta tampoco',
    premisa: (c) => {
      const m = c.match(/const CHUNK = (\d+);/);
      return !!m && Number(m[1]) <= TOPE && c.includes('const chunk = toInsert.slice(i, i + CHUNK);') &&
        (c.match(/\.insert\(/g) ?? []).length === 1;
    },
  },
  {
    archivo: 'lib/hooks/use-transactions.ts',
    consulta: "supabase.from('transacciones').select('*',conteo?{count:'exact'}:undefined)",
    motivo:
      '`armar` construye el builder con filtros condicionales y se usa en UN solo lugar: la página ' +
      'de todasLasFilas, con `.range(desde, hasta)` y la clave `(t) => t.id`. Sus tres órdenes son ' +
      'los únicos del archivo y el último es por `id`: un orden agregado en una rama lo rompería',
    premisa: (c) =>
      (c.match(/\barmar\(/g) ?? []).length === 1 &&
      /\(desde, hasta, primera\) => armar\(primera\)\.range\(desde, hasta\),\s*\(t\) => t\.id,/.test(c) &&
      (c.match(/\.order\(/g) ?? []).length === 3 &&
      /\.order\('fecha', \{ ascending: false \}\)\s*\.order\('created_at', \{ ascending: false \}\)\s*\.order\('id', \{ ascending: false \}\);/.test(c),
  },
];

// ─── El analizador ───────────────────────────────────────────────────────────────────────────

interface Llamada { metodo: string; nodo: ts.CallExpression }
interface Hallazgo { rel: string; linea: number; consulta: string; motivo: string }
type Pagina = { todas: ts.CallExpression; fn: ts.ArrowFunction | ts.FunctionExpression };

const ESCRITURAS = new Set(['insert', 'upsert', 'update', 'delete']);
const NO_SUPABASE = /^(Array|Buffer|Object|Set|Map|String|Uint8Array|Int\w*Array|Float\w*Array|BigInt\w*Array)$/;

/** Saca paréntesis y aserciones de tipo de encima de una expresión. */
function pelar(n: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isNonNullExpression(n) || ts.isSatisfiesExpression(n) || ts.isTypeAssertionExpression(n)) n = n.expression;
  return n;
}

/** El padre de `n` saltando paréntesis y aserciones de tipo. */
const subir = (n: ts.Node): ts.Node => {
  let p = n.parent;
  while (p && (ts.isParenthesizedExpression(p) || ts.isAsExpression(p) || ts.isNonNullExpression(p) || ts.isSatisfiesExpression(p) || ts.isTypeAssertionExpression(p))) p = p.parent;
  return p;
};

/** El nombre del método si `n` es `x.m` o `x['m']`. */
function nombreMetodo(n: ts.Node): string | null {
  if (ts.isPropertyAccessExpression(n)) return n.name.text;
  if (ts.isElementAccessExpression(n) && ts.isStringLiteralLike(n.argumentExpression)) return n.argumentExpression.text;
  return null;
}

/** Sube por `.metodo(...)` encadenados desde `inicio`: la expresión más externa y las llamadas. */
function cadena(inicio: ts.Expression): { externo: ts.Expression; llamadas: Llamada[] } {
  const llamadas: Llamada[] = [];
  let actual: ts.Expression = inicio;
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

const literalTexto = (n: ts.Node | undefined): string | null => (n && ts.isStringLiteralLike(n) ? n.text : null);

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
function opciones(n: ts.Expression | undefined): Map<string, ts.Expression> | 'sucio' | null {
  if (!n) return null;
  if (!ts.isObjectLiteralExpression(n)) return 'sucio';
  const m = new Map<string, ts.Expression>();
  for (const p of n.properties) {
    if (!ts.isPropertyAssignment(p) || !ts.isIdentifier(p.name)) return 'sucio';
    m.set(p.name.text, p.initializer);
  }
  return m;
}

const deEmbebido = (o: ReturnType<typeof opciones>) => o instanceof Map && (o.has('referencedTable') || o.has('foreignTable'));

/** Las columnas propias de un select, sin los embebidos (`categorias(nombre, id)`). */
function columnasPropias(sel: string): string[] {
  let s = sel;
  for (let prev = ''; prev !== s; ) { prev = s; s = s.replace(/[\w!:.]+\([^()]*\)/g, ''); }
  return s.split(',').map((c) => c.trim()).filter(Boolean);
}

function esFija(l: Llamada): boolean {
  const [a0, a1] = l.nodo.arguments;
  if (l.metodo === 'single' || l.metodo === 'maybeSingle') return true;
  if ((l.metodo === 'eq' || l.metodo === 'in') && literalTexto(a0) === 'id') return true;
  if (l.metodo === 'select') {
    const o = opciones(a1);
    return o instanceof Map && o.get('head')?.kind === ts.SyntaxKind.TrueKeyword;
  }
  return false;
}

function analizar(rel: string, codigo: string): { hallazgos: Hallazgo[]; lecturas: number } {
  const kind = /\.tsx$/.test(rel) ? ts.ScriptKind.TSX : /\.(jsx?|mjs|cjs)$/.test(rel) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(rel, codigo, ts.ScriptTarget.Latest, true, kind);
  const hallazgos: Hallazgo[] = [];
  let lecturas = 0;

  // Los nombres con que el archivo trae `todasLasFilas` y `TAMANO_PAGINA` de su módulo, directo o
  // por namespace (`import * as p` → `p.todasLasFilas`).
  const directos = { todasLasFilas: new Set<string>(), TAMANO_PAGINA: new Set<string>() };
  const espacios = new Set<string>();
  for (const s of sf.statements) {
    if (!ts.isImportDeclaration(s) || !ts.isStringLiteral(s.moduleSpecifier) || !/(^|\/)todas-las-filas$/.test(s.moduleSpecifier.text)) continue;
    const b = s.importClause?.namedBindings;
    if (b && ts.isNamespaceImport(b)) espacios.add(b.name.text);
    if (b && ts.isNamedImports(b)) {
      for (const e of b.elements) {
        const orig = (e.propertyName ?? e.name).text;
        if (orig === 'todasLasFilas' || orig === 'TAMANO_PAGINA') directos[orig].add(e.name.text);
      }
    }
  }
  const nombra = (n: ts.Expression, quien: 'todasLasFilas' | 'TAMANO_PAGINA'): boolean => {
    const id = ts.isIdentifier(n) && directos[quien].has(n.text) ? n
      : ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression) && espacios.has(n.expression.text) && n.name.text === quien ? n.expression
        : null;
    if (!id) return false;
    // Un parámetro `todasLasFilas = otra` o un `const TAMANO_PAGINA = 5000` local lo tapan.
    for (let p: ts.Node | undefined = id.parent; p; p = p.parent) {
      const l = ligadura(p, id.text);
      if (l) return l === 'import';
    }
    return false;
  };

  /** Cómo liga `p` al `nombre`: un `import`, `'opaca'` (parámetro, for, catch, let, var), su inicializador `const`, o nada. */
  const ligadura = (p: ts.Node, nombre: string): 'import' | 'opaca' | ts.Expression | null => {
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
        if (liga) return 'import';
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
  const resolver = (e: ts.Expression | undefined, prof = 0): number | null => {
    if (!e || prof > 8) return null;
    const n = pelar(e);
    if (ts.isNumericLiteral(n)) return Number(n.text);
    if (nombra(n, 'TAMANO_PAGINA')) return TOPE;
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
      const cotas = n.arguments.map((a) => resolver(a, prof + 1)).filter((v): v is number => v !== null);
      return cotas.length ? Math.min(...cotas) : null;
    }
    if (!ts.isIdentifier(n)) return null;
    let funcion: ts.Node = n;
    while (funcion.parent && !ts.isFunctionLike(funcion) && !ts.isSourceFile(funcion)) funcion = funcion.parent;
    let hayVar = false;
    const buscarVar = (m: ts.Node) => {
      if (ts.isVariableDeclarationList(m) && (m.flags & (ts.NodeFlags.Const | ts.NodeFlags.Let)) === 0 &&
        m.declarations.some((d) => nombresLigados(d.name).includes(n.text))) hayVar = true;
      ts.forEachChild(m, buscarVar);
    };
    buscarVar(funcion);
    if (hayVar) return null;
    for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
      const l = ligadura(p, n.text);
      if (l === 'opaca' || l === 'import') return null;
      if (l) return resolver(l, prof + 1);
    }
    return null;
  };

  /** Si `externo` es el cuerpo de la página de un `todasLasFilas` real, esa llamada y su función. */
  const paginaDe = (externo: ts.Node): Pagina | null => {
    const p = subir(externo);
    let fn: ts.Node | null = null;
    if (p && ts.isArrowFunction(p) && ts.isExpression(p.body) && pelar(p.body) === externo) fn = p;
    if (p && ts.isReturnStatement(p)) for (let f: ts.Node | undefined = p.parent; f; f = f.parent) if (ts.isFunctionLike(f)) { fn = f; break; }
    if (!fn || !(ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) return null;
    const call = subir(fn);
    return call && ts.isCallExpression(call) && nombra(call.expression, 'todasLasFilas') && call.arguments[0] === fn ? { todas: call, fn } : null;
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
    if (ts.isArrowFunction(p) && ts.isExpression(p.body) && pelar(p.body) === hijo) fn = p;
    if (ts.isReturnStatement(p)) for (let f: ts.Node | undefined = p.parent; f; f = f.parent) if (ts.isFunctionLike(f)) { fn = f; break; }
    if (!fn) return false;
    // Lo que devuelve una función async se resuelve en el `return`; el `queryFn` de React Query
    // lo resuelve React Query. En los dos casos nadie recibe el builder.
    if ((ts.getCombinedModifierFlags(fn as ts.Declaration) & ts.ModifierFlags.Async) !== 0) return true;
    const dueno = subir(fn);
    return !!dueno && ts.isPropertyAssignment(dueno) && dueno.initializer === fn && dueno.name.getText() === 'queryFn';
  };

  /**
   * La página de `todasLasFilas` tiene UNA forma aceptada y cualquier otra es roja. Los chequeos
   * sueltos que hubo antes (¿hay un range? ¿algún orden por id?) se evadieron con un `.limit`
   * después del range, un `id` dentro de un embebido y una clave que no era el id.
   */
  const paginaInvalida = (llamadas: Llamada[], pag: Pagina): string | null => {
    const params = pag.fn.parameters.map((p) => p.name.getText());
    let pisa = false;
    const v = (m: ts.Node) => {
      const objetivo = ts.isBinaryExpression(m) && m.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && m.operatorToken.kind <= ts.SyntaxKind.LastAssignment ? m.left
        : ts.isPrefixUnaryExpression(m) || ts.isPostfixUnaryExpression(m) ? m.operand : null;
      if (objetivo && ts.isIdentifier(objetivo) && params.includes(objetivo.text)) pisa = true;
      ts.forEachChild(m, v);
    };
    v(pag.fn.body);
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
      if (op === 'sucio' || (op && [...op.keys()].some((k) => k !== 'ascending' && k !== 'nullsFirst'))) return 'un .order de la página con opciones que no son { ascending } literal';
    }
    if (literalTexto(ordenes.at(-1)?.nodo.arguments[0]) !== 'id') return 'todasLasFilas sin un orden que termine en id';
    const select = propias.find((l) => l.metodo === 'select');
    const sel = literalTexto(select?.nodo.arguments[0]);
    const cols = sel === null ? [] : columnasPropias(sel);
    if (!cols.includes('*') && !cols.includes('id')) return 'todasLasFilas con un select sin `id` propio: la clave sale undefined y deduplica todo a una fila';
    const conteo = select?.nodo.arguments[1]?.getText().replace(/\s+/g, '') ?? '';
    if (!/^(\w+\?)?\{count:['"`]exact['"`]\}(:undefined)?$/.test(conteo)) return "todasLasFilas sin count: 'exact' en la primera página";
    const clave = pag.todas.arguments[1];
    if (!clave || !ts.isArrowFunction(clave) || clave.parameters.length !== 1 || !ts.isExpression(clave.body)) return 'todasLasFilas sin la clave (t) => t.id';
    const cuerpo = pelar(clave.body);
    const esId = ts.isPropertyAccessExpression(cuerpo) && cuerpo.expression.getText() === clave.parameters[0].name.getText() && cuerpo.name.text === 'id';
    return esId ? null : 'todasLasFilas sin la clave (t) => t.id';
  };

  /** El ancho de un `.range(a, b)`, también con `a` desconocido (`range(desde, desde + N - 1)`). */
  const anchoDeRange = (a0: ts.Expression | undefined, a1: ts.Expression | undefined): number | null => {
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
  const veredicto = (externo: ts.Expression, llamadas: Llamada[]): string | null => {
    const pag = paginaDe(externo);
    if (pag) return paginaInvalida(llamadas, pag);
    if (llamadas.some(esFija)) return null;
    const hasta = llamadas.findIndex((l) => l.metodo === 'then');
    const propias = hasta === -1 ? llamadas : llamadas.slice(0, hasta);
    let ultimo: Llamada | null = null;
    for (const l of propias) {
      if (l.metodo !== 'limit' && l.metodo !== 'range') continue;
      const op = opciones(l.nodo.arguments[l.metodo === 'limit' ? 1 : 2]);
      if (op === 'sucio') return `.${l.metodo}() con opciones que no son un objeto literal: no se puede saber si son del embebido`;
      if (!deEmbebido(op)) ultimo = l;
    }
    if (!ultimo) return 'sin .range/.limit/head:true/filtro por id';
    const [a0, a1] = ultimo.nodo.arguments;
    if (ultimo.metodo === 'limit') {
      const n = resolver(a0);
      if (n === null) return `.limit(${a0?.getText()}) no se puede resolver a un número`;
      if (n > TOPE) return `.limit(${n}) pide más de ${TOPE} y PostgREST corta igual`;
    } else {
      const ancho = anchoDeRange(a0, a1);
      if (ancho === null || ancho > TOPE) return '.range() fuera de todasLasFilas que pide más de una página (o no se resuelve)';
    }
    return cerrada(externo, llamadas)
      ? null
      : 'el builder sale de la cadena (variable, argumento, ternario, propiedad) y alguien puede pisarle el límite: ciérrala en el lugar o va a EXENCIONES';
  };

  const lee = (llamadas: Llamada[]) =>
    !llamadas.some((l) => ESCRITURAS.has(l.metodo)) || llamadas.some((l) => l.metodo === 'select' || l.metodo === 'csv');

  const visitar = (n: ts.Node) => {
    if (ts.isCallExpression(n) && nombreMetodo(n.expression) === 'from' && n.arguments.length === 1) {
      const tabla = literalTexto(n.arguments[0]);
      const receptor = (n.expression as ts.PropertyAccessExpression | ts.ElementAccessExpression).expression.getText();
      if ((tabla === null && !NO_SUPABASE.test(receptor)) || (tabla !== null && TABLAS.has(tabla))) {
        const linea = sf.getLineAndCharacterOfPosition(n.getStart()).line + 1;
        const { externo, llamadas } = cadena(n);
        const p = subir(externo);
        const usos: { externo: ts.Expression; llamadas: Llamada[] }[] = [];
        if (llamadas.length === 0 && p && ts.isVariableDeclaration(p) && ts.isIdentifier(p.name) && p.initializer) {
          // El alias pelado (`const base = svc.from(x)`) se juzga en cada uso. Exportado, sus usos
          // viven en otro archivo: se juzga como lo que es acá, una lectura sin cota.
          const nombre = p.name;
          const lista = p.parent;
          const stmt = lista.parent;
          if (ts.isVariableStatement(stmt) && (ts.getModifiers(stmt) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) usos.push({ externo, llamadas });
          // `var` vive en toda la función, no en el bloque donde se escribió.
          const esVar = (lista.flags & (ts.NodeFlags.Const | ts.NodeFlags.Let)) === 0;
          let ambito: ts.Node = p;
          while (ambito.parent && !(esVar ? ts.isFunctionLike(ambito) || ts.isSourceFile(ambito) : ts.isBlock(ambito) || ts.isSourceFile(ambito))) ambito = ambito.parent;
          const v = (m: ts.Node) => {
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
    ts.forEachChild(n, visitar);
  };
  visitar(sf);
  return { hallazgos, lecturas };
}

const exenta = (h: Hallazgo) => EXENCIONES.some((e) => e.archivo === h.rel && h.consulta.includes(e.consulta));

// ─── El barrido ──────────────────────────────────────────────────────────────────────────────

const RAIZ = process.cwd();
const SRC = join(RAIZ, 'src');

function archivos(dir: string): string[] {
  return readdirSync(dir).flatMap((nombre) => {
    const full = join(dir, nombre);
    if (statSync(full).isDirectory()) return archivos(full);
    return /\.[cm]?[tj]sx?$/.test(full) && !/\.test\.[cm]?[tj]sx?$/.test(full) ? [full] : [];
  });
}

// Los archivos de convención de Next que viven fuera de `src/` entran igual (`proxy.ts` es el
// sucesor de `middleware.ts` en Next 16).
const rutas = [...archivos(SRC), ...['middleware.ts', 'proxy.ts', 'instrumentation.ts'].map((f) => join(RAIZ, f)).filter(existsSync)];
const fuentes: Fuente[] = rutas.map((full) => ({ rel: relative(SRC, full).replace(/\\/g, '/'), contenido: readFileSync(full, 'utf-8') }));
const resultados = fuentes.map((f) => ({ ...f, ...analizar(f.rel, f.contenido) }));
const todos = resultados.flatMap((r) => r.hallazgos);

/** Un fragmento como si fuera un archivo de la webapp que importa el paginador real. */
const caso = (cuerpo: string, arriba = '') => analizar(
  'fixture.ts',
  `import { todasLasFilas, TAMANO_PAGINA } from '@/lib/supabase/todas-las-filas';\n${arriba}\nasync function f(svc: any, u: string, x: boolean, ids: string[], options: any) {\n${cuerpo}\n}`,
).hallazgos.map((h) => h.motivo);

const PAG = "(d, h, p) => svc.from('transacciones').select('*', p ? { count: 'exact' } : undefined)";
const SALE = 'el builder sale de la cadena (variable, argumento, ternario, propiedad) y alguien puede pisarle el límite: ciérrala en el lugar o va a EXENCIONES';
const SIN = 'sin .range/.limit/head:true/filtro por id';
const IRRESOLUBLE = /no se puede resolver a un número/;
const GRANDE = /pide más de 1000/;

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
    // Formas realistas de reintroducir el corte. La mayoría las encontraron dos revisiones
    // adversariales el 01-oct-2026 con el guard en verde. Cada una afirma el MOTIVO, no sólo que
    // hubo un hallazgo: un rojo por otra condición no prueba que esta forma se vea.
    it.each<[string, string, string | RegExp, string?]>([
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
      ['una const chica de OTRO ámbito con el mismo nombre', "async function g() { const LIMITE = 20; return LIMITE; }\nasync function h() { const LIMITE = 5000; return svc.from('transacciones').select('*').limit(LIMITE); }\nawait h();", GRANDE],
      ['un .limit por let', "let LIM = 5000;\nawait svc.from('transacciones').select('*').limit(LIM);", IRRESOLUBLE],
      ['un .limit importado', "await svc.from('transacciones').select('*').limit(LIMITE_EXPORT);", IRRESOLUBLE, "import { LIMITE_EXPORT } from './limites';"],
      ['un .limit con ternario', "await svc.from('transacciones').select('*').limit(x ? 10000 : 50);", IRRESOLUBLE],
      ['un .limit de un parámetro', "await svc.from('transacciones').select('*').limit(options.limit);", IRRESOLUBLE],
      ['un parámetro desestructurado que tapa una const chica', "const limite = 50;\nasync function g({ usuarioId, limite }: any) { return svc.from('transacciones').select('*').eq('usuario_id', usuarioId).limit(limite); }\nawait g({});", IRRESOLUBLE],
      ['un .limit chico pisado por un .range', "await svc.from('transacciones').select('*').limit(100).range(0, options.total - 1);", /\.range\(\) fuera de todasLasFilas/],
      ['un .range suelto de varias páginas', "await svc.from('transacciones').select('*').range(0, 4999);", /\.range\(\) fuera de todasLasFilas/],
      ['un todasLasFilas que no es el importado', "await todasLasFilas2((d: number, h: number) => svc.from('transacciones').select('*', { count: 'exact' }).order('id').range(d, h), (t: any) => t.id);", /\.range\(\) fuera de todasLasFilas/],
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
      ['un helper que recibe el builder pelado y le pone el select', "const delUsuario = (tabla: any, id: string) => tabla.select('*').eq('usuario_id', id);\nawait delUsuario(svc.from('transacciones'), u);", SIN],
      // Tercera ronda: la página de todasLasFilas tiene UNA forma, y las opciones sucias fallan.
      ['un .limit(TAMANO_PAGINA) después del range de la página', "await todasLasFilas((desde, hasta, primera) => svc.from('transacciones').select('monto_pen, fecha', primera ? { count: 'exact' } : undefined).order('fecha', { ascending: false }).range(desde, hasta).limit(TAMANO_PAGINA), (t: { id: string }) => t.id);", /terminar en \.range/],
      ['la página con .limit y sin .range', "await todasLasFilas((d, h, p) => svc.from('transacciones').select('*', p ? { count: 'exact' } : undefined).order('id').limit(TAMANO_PAGINA), (t: any) => t.id);", /terminar en \.range/],
      ['un id que es del embebido', "await todasLasFilas((d, h, p) => svc.from('transacciones').select('monto_pen, fecha, categorias(nombre, id, icono)', p ? { count: 'exact' } : undefined).order('id').range(d, h), (t: any) => t.id);", /select sin `id` propio/],
      ['un id alias de otra columna', "await todasLasFilas((d, h, p) => svc.from('transacciones').select('id:comercio, monto', p ? { count: 'exact' } : undefined).order('id').range(d, h), (t: any) => t.id);", /select sin `id` propio/],
      ['una clave que no es el id', "await todasLasFilas((d, h, p) => svc.from('transacciones').select('*', p ? { count: 'exact' } : undefined).order('id').range(d, h), (t: any) => `${t.fecha}|${t.monto}|${t.comercio}`);", /clave \(t\) => t\.id/],
      ['el orden por id de un embebido como último orden', "await todasLasFilas((d, h, p) => svc.from('transacciones').select('*, categorias(id)', p ? { count: 'exact' } : undefined).order('fecha').order('id', { referencedTable: 'categorias' } as const).range(d, h), (t: any) => t.id);", /order de la página/],
      ['el orden de un embebido después del id', "await todasLasFilas((d, h, p) => svc.from('transacciones').select('*, x(*)', p ? { count: 'exact' } : undefined).order('id').order('n', { referencedTable: 'x' }).range(d, h), (t) => t.id);", /order de la página/],
      ['opciones de embebido con as const', "await svc.from('transacciones').select('*, categorias(*)').limit(1, { referencedTable: 'categorias' } as const);", /opciones que no son un objeto literal/],
      ['opciones de embebido en una constante', "const UNA = { referencedTable: 'categorias' };\nawait svc.from('transacciones').select('*, categorias(*)').limit(1, UNA);", /opciones que no son un objeto literal/],
      ['head:true con spread', "await svc.from('transacciones').select('*', { head: true, count: 'exact', ...options });", SIN],
      ['una const tapada por la variable de un for-of', "const limite = 100;\nfor (const limite of [100, 5000]) { await svc.from('transacciones').select('*').limit(limite); }", IRRESOLUBLE],
      ['un alias var dentro de un if, usado afuera', "if (x) { var t = svc.from('transacciones'); }\nawait t.select('*');", SIN],
      ['una tabla en constante y un helper que le pone el select', "const TABLA_TX = 'transacciones';\nconst delUsuario = (q: any, id: string) => q.select('*').eq('usuario_id', id);\nawait delUsuario(svc.from(TABLA_TX), u);", /tabla no literal/],
      // Cuarta ronda.
      ['un .in(id) dentro de una página mal armada', "await todasLasFilas((d, h, p) => svc.from('transacciones').select('fecha, monto_pen, comercio', p ? { count: 'exact' } : undefined).in('id', ids).order('fecha').range(d, h), (t: any) => `${t.fecha}|${t.monto_pen}|${t.comercio}`);", /orden que termine en id/],
      ['la página que pisa su parámetro', "await todasLasFilas((desde, hasta, p) => { if (x) desde = 0; return svc.from('transacciones').select('*', p ? { count: 'exact' } : undefined).order('id').range(desde, hasta); }, (t: any) => t.id);", /pisa sus propios parámetros/],
      ['un TAMANO_PAGINA local que tapa el importado', "const TAMANO_PAGINA = 5000;\nawait svc.from('transacciones').select('*').limit(TAMANO_PAGINA);", GRANDE],
      ['un todasLasFilas inyectado como parámetro', "async function g(todasLasFilas: any) { return todasLasFilas((d: number, h: number, p: boolean) => svc.from('transacciones').select('*', p ? { count: 'exact' } : undefined).order('id').range(d, h), (t: any) => t.id); }\nawait g(null);", /\.range\(\) fuera de todasLasFilas/],
      ['un var izado que tapa una const chica', "const LIMITE = 50;\nasync function g(c: boolean) { if (c) { var LIMITE = 5000; } return svc.from('transacciones').select('*').limit(LIMITE); }\nawait g(x);", IRRESOLUBLE],
      ['una tabla por variable con select', "const T = 'transacciones';\nawait svc.from(T).select('*');", /tabla no literal/],
    ])('ve %s', (_n, cuerpo, motivo, arriba) => {
      const motivos = caso(cuerpo, arriba);
      expect(motivos.length, JSON.stringify(motivos)).toBeGreaterThanOrEqual(1);
      expect(motivos.every((m) => (typeof motivo === 'string' ? m === motivo : motivo.test(m))), JSON.stringify(motivos)).toBe(true);
    });

    it('un alias exportado se juzga como lectura sin cota (sus usos viven en otro archivo)', () => {
      const h = analizar('fixture.ts', "const supabase: any = null;\nexport const tablaTransacciones = supabase.from('transacciones');").hallazgos;
      expect(h.map((x) => x.motivo)).toEqual([SIN]);
    });

    // Y no grita sobre lo que está bien: un detector que marca todo lleva a llenar EXENCIONES
    // y deja de mirar. Los marcados con (FP) fueron falsos positivos de la segunda revisión.
    it.each<[string, string, string?]>([
      ['todasLasFilas con .range', `await todasLasFilas(${PAG}.order('id').range(d, h), (t) => t.id);`],
      ['todasLasFilas importado con otro nombre', "await paginar((d, h, p) => svc.from('transacciones').select('id, monto', p ? { count: 'exact' } : undefined).order('id').range(d, h), (t: any) => t.id);", "import { todasLasFilas as paginar } from './supabase/todas-las-filas';"],
      ['la página con return en vez de cuerpo de expresión', `await todasLasFilas((d, h, p) => { return svc.from('transacciones').select('*', p ? { count: 'exact' } : undefined).order('id').range(d, h); }, (t) => t.id);`],
      ['un conteo', "await svc.from('transacciones').select('id', { count: 'exact', head: true }).eq('usuario_id', u);"],
      ['un conteo en variable con filtros condicionales', "let q = svc.from('transacciones').select('*', { count: 'exact', head: true });\nif (x) q = q.eq('tipo', 'g');\nawait q;"],
      ['(FP) un conteo devuelto por una función exportada', "return 1;\n}\nexport function contarTx(svc: any, u: string) { return svc.from('transacciones').select('id', { count: 'exact', head: true }).eq('usuario_id', u);"],
      ['(FP) una por id devuelta por una función exportada', "return 1;\n}\nexport async function unaTx(svc: any, id: string) { return svc.from('transacciones').select('*').eq('id', id).single();"],
      ['(FP) un queryFn async con limit chico', "const q = { queryFn: async () => svc.from('transacciones').select('*').eq('usuario_id', u).limit(5) };\nawait q.queryFn();"],
      ['(FP) un limit de TAMANO_PAGINA importado', "await svc.from('transacciones').select('*').limit(TAMANO_PAGINA);"],
      ['un limit chico', "await svc.from('transacciones').select('*').limit(5);"],
      ['un limit por constante chica de un ámbito de arriba', "const MAX = 2 * 3;\nconst g = async () => svc.from('transacciones').select('*').limit(MAX);\nawait g();"],
      ['un limit chico dentro de Promise.all', "await Promise.all([svc.from('transacciones').select('*').limit(5), svc.from('x').select('*')]);"],
      ['un limit chico con .then', "svc.from('transacciones').select('*').limit(5).then((r: any) => r);"],
      ['un range de una página', "await svc.from('transacciones').select('*').range(0, 999);"],
      ['por id', "await svc.from('transacciones').select('*').eq('id', u).single();"],
      ['por lista de ids', "await svc.from('transacciones').select('comercio').in('id', ids).eq('usuario_id', u);"],
      ['una escritura sin select', "await svc.from('transacciones').update({ a: 1 }).eq('usuario_id', u);"],
      ['un insert que devuelve UNA fila', "await svc.from('transacciones').insert({ a: 1 }).select('id').single();"],
      ['un borrado', "await svc.from('transacciones').delete().eq('id', u);"],
      ['un borrado por alias', "const base = svc.from('transacciones');\nconst op = x ? base.delete() : base.update({ a: 1 });\nawait op.eq('usuario_id', u);"],
      ['una tabla por variable que sólo escribe, por alias', "const base = svc.from(options.tabla);\nconst op = x ? base.delete() : base.update({ a: 1 });\nawait op.eq('usuario_id', u);"],
      ['otra tabla', "await svc.from('presupuestos').select('*');"],
      ['Array.from', "Array.from(new Set([1])).map((n) => n);"],
      ['Buffer.from con una variable', "Buffer.from(u).toString('base64');"],
      // Falsos positivos de la tercera ronda.
      ['(FP) un queryFn no async que devuelve el builder', "const q = { queryFn: () => svc.from('transacciones').select('*').eq('usuario_id', u).limit(5) };\nawait q.queryFn();"],
      ['(FP) un Math.min con un tope chico', "await svc.from('transacciones').select('*').limit(Math.min(options.pedido || 50, 200));"],
      ['(FP) una const as const', "const LIMITE = 50 as const;\nawait svc.from('transacciones').select('*').limit(LIMITE);"],
      ['(FP) un ternario de cadenas acotadas dentro del await', "await (x ? svc.from('transacciones').select('*').order('fecha').limit(10) : svc.from('transacciones').select('*').order('monto').limit(10));"],
      ['(FP) todasLasFilas por namespace', "await paginacion.todasLasFilas((d, h, p) => svc.from('transacciones').select('*', p ? { count: 'exact' } : undefined).order('id').range(d, h), (t: any) => t.id);", "import * as paginacion from '@/lib/supabase/todas-las-filas';"],
      ['(FP) un queryFn con el cuerpo entre paréntesis', "const q = { queryFn: () => (\n  svc.from('transacciones').select('*').eq('usuario_id', u).limit(10)\n) };\nawait q.queryFn();"],
      ['(FP) la página con el cuerpo entre paréntesis', "await todasLasFilas((d, h, p) => (\n  svc.from('transacciones').select('*', p ? { count: 'exact' } : undefined).order('id').range(d, h)\n), (t) => t.id);"],
      ['un .in(id) dentro de una página bien armada', "await todasLasFilas((d, h, p) => svc.from('transacciones').select('*', p ? { count: 'exact' } : undefined).in('id', ids).order('id').range(d, h), (t) => t.id);"],
      ['(FP) paginación de UI con desde + N - 1', "const POR_PAGINA = 20;\nconst desde = options.pagina * POR_PAGINA;\nawait svc.from('transacciones').select('*').order('fecha').range(desde, desde + POR_PAGINA - 1);"],
    ])('no marca %s', (_n, cuerpo, arriba) => {
      expect(caso(cuerpo, arriba)).toEqual([]);
    });
  });

  it('ninguna lectura de transacciones del código queda sin cota', () => {
    const culpables = todos.filter((h) => !exenta(h)).map((h) => `${h.rel}:${h.linea}  ${h.motivo}\n    ${h.consulta}`);
    expect(
      culpables,
      'Una lectura de transacciones sin cota devuelve como mucho 1000 filas sin avisar. Si necesita ' +
        'todas, pásala a `todasLasFilas` (lib/supabase/todas-las-filas.ts) con un orden que termine ' +
        'en `id` y clave `(t) => t.id`. Si de verdad está acotada por otra razón, agrégala a ' +
        'EXENCIONES con su motivo y una premisa que se pueda verificar.',
    ).toEqual([]);
  });

  it.each(EXENCIONES)('la exención de $archivo sigue calzando con UNA lectura y su premisa se cumple', (e) => {
    const calzan = todos.filter((h) => h.rel === e.archivo && h.consulta.includes(e.consulta));
    expect(calzan, `exención vencida: "${e.consulta}" ya no está en ${e.archivo}`).toHaveLength(1);
    const contenido = fuentes.find((f) => f.rel === e.archivo)!.contenido;
    expect(e.premisa(contenido), `la premisa de la exención ya no se cumple: ${e.motivo}`).toBe(true);
  });
});
