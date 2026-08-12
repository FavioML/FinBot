// ¿Existe en la DB REAL una columna que guarde un nombre de categoría y que el
// cascade de `/api/categories` no conozca?
//
// POR QUÉ EXISTE. La taxonomía se referencia por NOMBRE, no por FK, así que no hay
// `on update cascade`: cada tabla que copia el nombre es un consumidor que hay que
// reetiquetar a mano. Hasta el 2026-08-12 el endpoint tenía una lista de TRES tablas y
// el esquema tenía seis columnas con nombre de categoría, más dos jsonb que guardan
// nombres adentro. Renombrar una categoría raíz dejaba a los consumidores olvidados
// apuntando al nombre viejo: sin error, sin log, simplemente dejaban de agrupar con el
// resto (clase `consumidor-no-actualizado`).
//
// LA MITAD QUE ESTE HARNESS APORTA. `webapp/src/lib/category-cascade.test.ts` es
// hermético y contesta "¿el código hace lo que la declaración dice?". No puede
// contestar "¿la declaración describe la DB?", porque para eso hace falta la DB. Este
// archivo es esa mitad, y es el que cierra la CLASE: una tabla nueva con columna de
// categoría aparece en el esquema y esto se pone rojo, aunque nadie se acuerde de la
// regla. Mismo par que `merge-and-link-columnas.test.js` + `qa-web-signup-merge.mjs`.
//
// POR QUÉ NO BASTA UN `column_name ilike '%categor%'`. Ese barrido encuentra seis
// columnas y se pierde `shared_spaces.split_rules[].category`, que es jsonb — y es
// justo la que mueve plata (`resolveSplitPlan` matchea por `===` exacto). Por eso acá
// las SOSPECHOSAS son dos conjuntos: las que se llaman así, y TODA columna jsonb o
// array, que se exige clasificar aunque hoy no guarde ningún nombre.
//
// LO QUE ESTE BARRIDO NO PUEDE VER, y conviene no creerle de más: una columna `text`
// que guarde un nombre de categoría y se llame de otra forma (`rubro`, `etiqueta`,
// `tag`, `label`) no cae en ninguno de los dos conjuntos y sale verde. Cubrir eso
// pediría mirar los VALORES de cada columna de texto del esquema, que es otro orden de
// costo y de falsos positivos. O sea que esto cierra la clase para las dos formas que
// el defecto tomó de verdad, no para toda forma imaginable.
//
// READ-ONLY: solo un GET al OpenAPI de PostgREST. No usa `createClient` ni escribe nada.
//
// Uso: node qa-categorias-cascade-schema.mjs
// Exit 0 = todo clasificado · 1 = hay algo sin clasificar (o una declaración fantasma)
//        · 2 = no se pudo leer el esquema o la declaración (nunca PASS por vacuidad).

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const TAG = 'QA-CAT-SCHEMA';

// Pisos anti-vacuidad, en los valores MEDIDOS contra prod el 12-ago-2026. Van pegados
// al número real y no holgados a propósito: con `>= 6` y `>= 5`, PostgREST podía dejar
// de publicar cuatro tablas y el guard seguía verde comprobando menos. Si crecen
// legítimamente (una tabla nueva), este número sube en el mismo commit que la declara.
const ESPERADAS_NOMBRE = 10;
const ESPERADAS_TIPO = 12;

function loadEnv(path) {
  const env = {};
  try {
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* opcional */ }
  return env;
}

const qaEnv = loadEnv(join(homedir(), '.config', 'neto', 'qa.env'));
const webEnv = loadEnv(new URL('../webapp/.env.local', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));

const SUPA = qaEnv.NETO_QA_URL || webEnv.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE =
  qaEnv.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_KEY ||
  webEnv.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPA || !SERVICE) {
  console.error(`[${TAG}] Falta SUPABASE_URL o SERVICE_ROLE_KEY (qa.env / env / webapp/.env.local).`);
  process.exit(2);
}

const DECL = new URL('../webapp/src/lib/category-refs.ts', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

/**
 * La declaración es TypeScript y esto es un .mjs, así que se parsea el fuente. Se hace
 * con controles duros en vez de "lo que salga": un parser que devuelve el conjunto
 * vacío cuando el archivo cambia de forma daría PASS sobre CERO comprobaciones, que es
 * la peor salida posible acá. Cualquier sorpresa es exit 2, no exit 0.
 */
function leerDeclaracion() {
  const src = readFileSync(DECL, 'utf8');
  const bloque = (nombre) => {
    const i = src.indexOf(`export const ${nombre}`);
    if (i < 0) throw new Error(`no se encontró ${nombre} en category-refs.ts`);
    const abre = src.indexOf('[', i);
    const cierra = src.indexOf('\n];', abre);
    if (abre < 0 || cierra < 0) throw new Error(`no se pudo delimitar ${nombre}`);
    return src.slice(abre, cierra);
  };

  const cascade = [];
  for (const entrada of bloque('CASCADE_REFS').split(/\n\s{2}\{/).slice(1)) {
    const table = entrada.match(/\btable:\s*'([^']+)'/)?.[1];
    const cat = entrada.match(/\bcat:\s*'([^']+)'/)?.[1];
    // `owner` también, y no es cosmético: es la columna que ESCOPA las cuatro
    // operaciones al usuario, y es justo la que difiere entre tablas (`usuario_id`,
    // `creador_id`, `user_id`). Declarada mal, PostgREST devuelve 42703, el cascade no
    // toca esa tabla NUNCA, y el guard hermético sigue verde porque afirma que se usó
    // el owner declarado, no que exista.
    const owner = entrada.match(/\bowner:\s*'([^']+)'/)?.[1];
    const subM = entrada.match(/\bsub:\s*(?:'([^']+)'|null)/);
    if (!table || !cat || !owner || !subM) throw new Error(`entrada de CASCADE_REFS ilegible: ${entrada.slice(0, 80)}`);
    cascade.push({ table, cat, owner, sub: subM[1] ?? null });
  }

  const exempt = [];
  for (const m of bloque('EXEMPT_REFS').matchAll(/\bref:\s*'([^']+)'/g)) exempt.push(m[1]);

  if (!cascade.length || !exempt.length) throw new Error('la declaración salió vacía: cambió de forma');
  return { cascade, exempt };
}

/**
 * El esquema que PostgREST publica en `GET /rest/v1/`: la DB REAL, no lo que el repo
 * cree. Es lo único acá que puede delatar una tabla creada a mano en la consola.
 */
async function esquemaVivo() {
  const res = await fetch(`${SUPA}/rest/v1/`, {
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` },
  });
  if (!res.ok) throw new Error(`OpenAPI de PostgREST: HTTP ${res.status}`);
  const spec = await res.json();
  const defs = spec?.definitions;
  if (!defs || Object.keys(defs).length < 10) throw new Error('el OpenAPI vino sin tablas');
  return defs;
}

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}`); }
};

let decl, defs;
try {
  decl = leerDeclaracion();
} catch (e) {
  console.error(`[${TAG}] no se pudo leer la declaración: ${e.message}`);
  process.exit(2);
}
try {
  defs = await esquemaVivo();
} catch (e) {
  console.error(`[${TAG}] no se pudo leer el esquema vivo: ${e.message}`);
  process.exit(2);
}

console.log(`[${TAG}] ${Object.keys(defs).length} tablas publicadas · declaración: ` +
  `${decl.cascade.length} en cascade, ${decl.exempt.length} exentas`);

// Lo declarado, aplanado a `tabla.columna`.
const declaradas = new Set(decl.exempt);
for (const r of decl.cascade) {
  declaradas.add(`${r.table}.${r.cat}`);
  if (r.sub) declaradas.add(`${r.table}.${r.sub}`);
}

// Las SOSPECHOSAS del esquema vivo, por los dos criterios.
const porNombre = [], porTipo = [];
for (const [tabla, def] of Object.entries(defs)) {
  for (const [col, meta] of Object.entries(def.properties || {})) {
    const f = String(meta?.format || '');
    if (/categor/i.test(col)) porNombre.push(`${tabla}.${col}`);
    else if (/json|\[\]/.test(f)) porTipo.push(`${tabla}.${col}`);
  }
}

console.log(`\n[${TAG}] 1) Toda columna con nombre de categoría está clasificada`);
ok(porNombre.length >= ESPERADAS_NOMBRE, `el barrido por nombre encontró ${porNombre.length} columnas (piso: ${ESPERADAS_NOMBRE}, lo medido el 12-ago)`);
const faltanNombre = porNombre.filter((r) => !declaradas.has(r));
ok(faltanNombre.length === 0, faltanNombre.length
  ? `SIN CLASIFICAR: ${faltanNombre.join(', ')} — entra en CASCADE_REFS o en EXEMPT_REFS de webapp/src/lib/category-refs.ts`
  : 'ninguna columna de categoría quedó fuera de la declaración');

console.log(`\n[${TAG}] 2) Toda columna jsonb/array está clasificada (el punto ciego del barrido por nombre)`);
ok(porTipo.length >= ESPERADAS_TIPO, `el barrido por tipo encontró ${porTipo.length} columnas (piso: ${ESPERADAS_TIPO}, lo medido el 12-ago)`);
const faltanTipo = porTipo.filter((r) => !declaradas.has(r));
ok(faltanTipo.length === 0, faltanTipo.length
  ? `SIN CLASIFICAR: ${faltanTipo.join(', ')} — decidí si guarda un nombre de categoría adentro y declarala`
  : 'ninguna jsonb/array quedó sin decidir');

console.log(`\n[${TAG}] 3) Ninguna declaración apunta al vacío`);
// El sentido inverso: una entrada que nombra una columna borrada es una decisión
// caducada que nadie va a revisar, y peor, hace creer que algo está cubierto.
const vivas = new Set();
for (const [tabla, def] of Object.entries(defs)) {
  for (const col of Object.keys(def.properties || {})) vivas.add(`${tabla}.${col}`);
}
// Las columnas `owner` entran acá: no son sospechosas (nadie guarda un nombre de
// categoría en un uuid), pero SÍ tienen que existir, o el cascade es un no-op mudo.
const aVerificar = new Set([...declaradas, ...decl.cascade.map((r) => `${r.table}.${r.owner}`)]);
const fantasmas = [...aVerificar].filter((r) => !vivas.has(r));
ok(fantasmas.length === 0, fantasmas.length
  ? `declaradas pero inexistentes en la DB: ${fantasmas.join(', ')}`
  : `las ${aVerificar.size} columnas declaradas (incluidas las de dueño) existen en el esquema vivo`);

console.log(`\n[${TAG}] ${pass} PASS · ${fail} FAIL`);
// `process.exitCode` y NO `process.exit()`: en Windows, salir de golpe con el socket
// keep-alive del fetch todavía abierto dispara una assertion de libuv
// (`!(handle->flags & UV_HANDLE_CLOSING)`) que devuelve **exit 127** con toda la
// salida ya impresa en verde. El canary leería un veredicto sano como caída de infra.
process.exitCode = fail ? 1 : 0;
