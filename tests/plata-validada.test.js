import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// `fileURLToPath` y no `new URL(...).pathname` + regex: ese pathname viene
// percent-encoded, así que un checkout en una ruta con espacios rompe el guard por
// I/O y no por el invariante. Mismo criterio que `codigos-seguros.test.js`.
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * GUARD DE CLASE: ninguna escritura de dinero sin validador.
 *
 * Nace al cerrar B16 y S′6 (auditoría CTO del 2026-08-10), que eran las dos últimas
 * escrituras de plata fuera del validador. La instancia se arregla con un commit; lo
 * que hace que no vuelva es esto.
 *
 * ── QUÉ AFIRMA, EXACTAMENTE ─────────────────────────────────────────────────────
 *
 * Para cada `.insert()/.update()/.upsert()` cuyo payload nombre una columna que lleva
 * plata, el ARCHIVO tiene que mencionar un validador (o delegar en un chokepoint que
 * valida por dentro), o estar declarado exento con su motivo.
 *
 * Es a nivel de ARCHIVO a propósito, y no es pereza: un guard de texto **no puede**
 * decidir si la expresión concreta que alimenta la columna pasó por el validador —
 * eso pide seguir asignaciones, alias y campos de objetos a través de funciones. Lo
 * que sí puede decidir sin ambigüedad es la PRESENCIA de la llamada. La misma
 * limitación que ya está escrita en el prompt del hallazgo: un guard de texto no ve
 * `if (x)` contra `if (!x)`.
 *
 * ── LO QUE ESTE GUARD NO ATRAPA, MEDIDO Y NO SUPUESTO ───────────────────────────
 *
 * Se probó contra los dos hallazgos que lo motivaron, y el resultado es asimétrico:
 *
 *   S′6 (`spaces/[id]/budgets`): lo ATRAPA. La versión pre-fix hacía
 *   `.update({ budgets })` sin mencionar ningún validador en todo el archivo. Está
 *   fijado abajo como contraprueba, con el código real de antes del fix.
 *
 *   B16 (`salvarGastoSinIA`): NO lo atrapa, y no puede. `message-processor.js`
 *   importa `validarMonto` desde siempre, y además la escritura pasaba por
 *   `guardarTransaccion`, que valida por dentro. O sea que B16 nunca fue de esta
 *   clase: el hallazgo lo agrupaba con S′6 bajo "plata sin validar" y la medición dice
 *   que su monto SÍ estaba validado. Lo que B16 tenía roto era otra cosa —qué número
 *   del mensaje se toma y en qué moneda— y eso lo cubre `tests/lib/salvage-429.test.js`,
 *   no un barrido de texto.
 *
 * Conviene que esto quede escrito: un guard que se presenta como "cubre la clase" y en
 * realidad cubre uno de los dos casos es peor que uno honesto, porque la próxima
 * auditoría lo lee como cobertura.
 *
 * ── LAS DOS TRAMPAS QUE ESTE REPO YA PAGÓ ───────────────────────────────────────
 *
 *  1. Barre los DOS árboles (`app/` y `webapp/src`). El guard de `Math.random` se
 *     escribió mirando uno solo y el mismo bug vivió diez meses más en el otro.
 *  2. Incluye la RAÍZ del repo, no solo los subdirectorios. `gmail.js` vive ahí y se
 *     quedó fuera del primer barrido de aquel guard.
 */

// ── Columnas y campos que llevan plata ──────────────────────────────────────────
//
// Incluye los JSONB, y esa es la diferencia entre atrapar S′6 y no atraparlo: el
// payload de la ruta rota decía `.update({ budgets })` — la palabra `limit` no aparece
// por ningún lado del archivo. Un barrido que solo mirara nombres escalares de columna
// pasaba verde sobre el hallazgo que lo motivó.
const COLUMNAS_DE_PLATA = [
  'monto', 'monto_pen', 'monto_limite', 'monto_total', 'monto_objetivo',
  'monto_actual', 'monto_original', 'monto_pendiente', 'monto_acordado',
  'limite', 'amount', 'budgets', 'split_snapshot', 'split_rules', 'precio', 'saldo',
];

// ── Lo que cuenta como "pasó por un validador" ──────────────────────────────────
//
// Las fuentes únicas de validación de monto del repo, más los chokepoints que validan
// por dentro (y por eso un archivo que delega en ellos no necesita validar otra vez:
// duplicar el techo crea dos topes que pueden divergir).
// Las fuentes únicas. Valen SIEMPRE que aparezcan.
const FUENTES = [
  'validarMonto',        // lib/validators.js (backend)
  'parseMontoDinero',    // webapp/src/lib/money.ts
  'parseSpaceAmount',    // webapp/src/lib/spaces-server.ts
  'parseSpaceBudgets',   // idem, para el JSONB de presupuestos de espacio
  'sanitizeSplitRules',  // webapp/src/lib/spaces-split.ts, para el JSONB de reglas
];

/**
 * Chokepoints que validan por dentro. Un archivo que DELEGA en ellos no necesita
 * validar otra vez — duplicar el techo crea dos topes que pueden divergir.
 *
 * Pero valen solo si el archivo los LLAMA, no si los DEFINE. La primera versión no
 * hacía esa distinción y con eso `services/debts.js` y `services/metas.js` se
 * auto-bendecían: contienen la palabra `registrarDeuda` porque es el nombre de su
 * propia función exportada. Lo delató la batería de mutación —quitarles `validarMonto`
 * dejaba el guard en VERDE—, que es exactamente la clase que este guard ya se había
 * comido una vez con las copias locales de `validarMonto`.
 */
const CHOKEPOINTS = [
  'guardarTransaccion',  // llama a validarMonto y LANZA si no pasa
  'buildSplitSnapshot',  // centavos enteros + CHECK en la DB
  'registrarDeuda',      // valida en services/debts.js
  'abonarDeuda',         // idem
  'abonarMeta',          // valida en services/metas.js
];

/**
 * Los módulos donde el validador puede DEFINIRSE. En cualquier otro archivo, un
 * `function validarMonto` o `const parseMontoDinero =` es una COPIA local.
 *
 * Existe porque el guard, en su primera versión, se conformaba con que la palabra
 * apareciera en el archivo — y una revisión adversarial mostró que eso lo apaga con
 * `const validarMonto = (x) => x;`. No es hipotético: `webapp/src/app/api/transactions/
 * route.ts` y `.../transactions/import/route.ts` tenían cada una su propia copia de
 * `validarMonto`, correcta hoy, y el guard las bendecía. Esa copia a mano es
 * exactamente la deriva que `money.ts` existe para terminar.
 */
const DUENOS_DEL_VALIDADOR = new Set([
  'lib/validators.js',
  'webapp/src/lib/money.ts',
  'webapp/src/lib/spaces-server.ts',
  'webapp/src/lib/spaces-split.ts',
  'services/transactions.js',
  'services/debts.js',
  'services/metas.js',
]);

const RE_DEFINE_VALIDADOR = new RegExp(
  '(?:function|const|let|var|export\\s+function|export\\s+const)\\s+(?:'
  + ['validarMonto', 'parseMontoDinero', 'parseSpaceAmount'].join('|') + ')\\b');

/**
 * Excepciones, con su razón. Una excepción sin razón es un guard apagado, y una que
 * sobrevive a su motivo es un hueco (la lección que dejó `lib/formatters.js` en el
 * guard de `Math.random`).
 */
const EXENTOS = new Map();

// ── Barrido ─────────────────────────────────────────────────────────────────────

const DIRS_BACKEND = ['handlers', 'lib', 'services', 'routes', 'cron', 'helpers', 'scripts'];
const DIR_WEBAPP = 'webapp/src';

function archivosDe(dir, extensiones) {
  const out = [];
  const abs = path.join(projectRoot, dir);
  if (!fs.existsSync(abs)) return out;
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...archivosDe(rel, extensiones));
    else if (extensiones.test(e.name)) out.push(rel);
  }
  return out;
}

/** La raíz, NO recursiva: es donde vive `gmail.js`, el hueco del guard hermano. */
function archivosRaiz() {
  return fs.readdirSync(projectRoot, { withFileTypes: true })
    .filter((e) => e.isFile() && /\.(js|mjs|cjs)$/.test(e.name))
    .map((e) => e.name);
}

/**
 * Quita comentarios: el comentario que EXPLICA por qué acá no hace falta validar
 * menciona el validador, y con eso un archivo sin validación real pasaría verde.
 *
 * El `//` exige principio de línea o espacio delante, porque toda URL literal lleva
 * `//` y cortar ahí se come el resto de la línea. Y el split es `/\r?\n/`: con `'\n'`
 * este stripper es un NO-OP en todo archivo CRLF, o sea en casi todo el árbol de un
 * checkout de Windows. Las dos son lecciones textuales de `codigos-seguros.test.js`,
 * que las pagó una por una.
 */
function soloCodigo(src) {
  return src
    // Los comentarios de bloque se COLAPSAN, no se rellenan con espacios. La versión
    // anterior preservaba el largo (para no mover los números de línea, que acá no se
    // usan), y con eso un JSDoc normal de este repo empujaba el `monto:` fuera de
    // `VENTANA_PAYLOAD`: el archivo dejaba de contar como escritura de plata sin que
    // nadie escribiera una exención. Un falso negativo silencioso, en un repo cuyo
    // estilo es exactamente ese.
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split(/\r?\n/)
    .map((l) => l.replace(/(^|\s)\/\/.*$/, '$1'))
    .join('\n');
}

// SIN flag `g`: `.test()` sobre una regex global avanza `lastIndex` y devuelve
// true/false alternado entre llamadas. Con `g` puesto, este guard daba veredictos
// distintos para el mismo fuente según cuántas veces se lo hubiera llamado antes — o
// sea, exactamente la clase de bug que el guard existe para no tener.
const RE_PERSISTENCIA = /\.(?:insert|update|upsert)\s*\(/;
// La columna como LLAVE de un objeto. Cubre las dos formas: `{ monto: x }` y el
// shorthand `{ budgets }`, que es exactamente como estaba escrita la ruta de S′6.
const RE_COLUMNA = new RegExp(
  '[{,(\\s](?:' + COLUMNAS_DE_PLATA.join('|') + ')\\s*[:,}]'
);
const RE_FUENTE = new RegExp('\\b(?:' + FUENTES.join('|') + ')\\b');
const RE_DEFINE = (nombre) =>
  new RegExp('(?:function|const|let|var|export\\s+function|export\\s+const)\\s+' + nombre + '\\b');

/** ¿El archivo pasa por un validador canónico, sea fuente o chokepoint ajeno? */
function pasaPorValidador(limpio) {
  if (RE_FUENTE.test(limpio)) return true;
  return CHOKEPOINTS.some((c) =>
    new RegExp('\\b' + c + '\\s*\\(').test(limpio) && !RE_DEFINE(c).test(limpio));
}

/** Ventana del payload después de `.insert(` / `.update(` / `.upsert(`. */
const VENTANA_PAYLOAD = 400;
const RE_PERSISTENCIA_G = /\.(?:insert|update|upsert)\s*\(/g;
/** El argumento cuando es un identificador pelado: `.insert(fila)` / `.update(updates)`. */
const RE_ARG_IDENTIFICADOR = /^\s*\.\w+\s*\(\s*(?:\.\.\.)?([A-Za-z_$][\w$]*)\s*[),]/;

/**
 * ¿El fuente escribe plata?
 *
 * Mira una VENTANA pegada a cada llamada de persistencia, y no el archivo entero: sin
 * ventana caen `neto-score.js`, `spending-alerts.js` y ocho rutas más que solo LEEN
 * montos para calcular otra cosa. Diez exenciones para dos hallazgos es un guard
 * apagado con pasos extra.
 *
 * Pero la ventana sola se evade armando el objeto arriba y pasándolo por variable
 * (`supabase.from('deudas').insert(fila)`), que es un estilo perfectamente normal — la
 * revisión adversarial escribió el módulo completo que pasaba verde. Así que cuando el
 * argumento es un identificador pelado, se RESUELVE: se busca dónde se declara y se
 * mira esa ventana también.
 *
 * Lo que sigue sin ver: un payload construido por partes (`fila.monto = x`) o devuelto
 * por otra función. Está anotado en la cabecera; un guard de texto tiene un techo y
 * mentir sobre dónde está es peor que tenerlo.
 */
function escribePlata(limpio) {
  for (const m of limpio.matchAll(RE_PERSISTENCIA_G)) {
    if (RE_COLUMNA.test(limpio.slice(m.index, m.index + VENTANA_PAYLOAD))) return true;
    const arg = limpio.slice(m.index).match(RE_ARG_IDENTIFICADOR);
    if (!arg) continue;
    // `$` es un identificador válido en JS **y** un ancla en regex: sin escaparlo,
    // `const $fila = {...}` producía el patrón `\s+$fila\s*=` —que no matchea nunca— y
    // el archivo quedaba invisible. Lo midió la segunda revisión adversarial.
    const ident = arg[1].replace(/\$/g, '\\$');

    // (a) el objeto declarado de una: `const fila = { monto: ... }`, o un literal de
    // array: `const filas = [{ monto: ... }]`.
    //
    // Se recorren TODAS las declaraciones de ese nombre, no la primera. `String.match`
    // sin `g` devuelve la primera del archivo, así que con dos funciones que usan el
    // mismo nombre local —`const fila` inocuo arriba, `const fila` con plata abajo— el
    // guard leía la ventana equivocada y daba verde. Es un nombre de variable local
    // reutilizado: el caso normal, no el rebuscado.
    const RE_DECL = new RegExp('(?:const|let|var)\\s+' + ident + '\\s*=\\s*[{[]', 'g');
    for (const d of limpio.matchAll(RE_DECL)) {
      if (RE_COLUMNA.test(limpio.slice(d.index, d.index + VENTANA_PAYLOAD))) return true;
    }

    // (b) el array llenado a empujones: `toInsert.push({ monto: ... })` … `.insert(chunk)`.
    // Es el patrón de `transactions/import`, y con (a) sola era invisible: su
    // declaración es `= []` y el objeto de plata vive en el `.push` de un `for`.
    // También se acepta que el argumento sea una TAJADA o un MAPEO del array, buscando
    // de qué array salió.
    const origen = limpio.match(
      new RegExp('(?:const|let|var)\\s+' + ident + '\\s*=\\s*(\\w+)\\s*\\.\\s*(?:slice|map|filter)\\s*\\('));
    for (const nombre of [arg[1], origen && origen[1]].filter(Boolean)) {
      const RE_PUSH = new RegExp('\\b' + nombre.replace(/\$/g, '\\$') + '\\s*\\.\\s*push\\s*\\(\\s*\\{', 'g');
      for (const p of limpio.matchAll(RE_PUSH)) {
        if (RE_COLUMNA.test(limpio.slice(p.index, p.index + VENTANA_PAYLOAD))) return true;
      }
    }
  }
  return false;
}

/**
 * ¿Este fuente escribe plata sin pasar por un validador CANÓNICO?
 * Se prueba la MISMA función que corre contra el repo: un detector probado por
 * separado del barrido es otro sitio donde los dos pueden divergir.
 */
function escribePlataSinValidar(src, rel = '<fixture>') {
  const limpio = soloCodigo(src);
  if (!escribePlata(limpio)) return false;
  // Definir el validador en un archivo que no es su dueño es una COPIA: cuenta como no
  // validado aunque el nombre aparezca.
  if (!DUENOS_DEL_VALIDADOR.has(rel) && RE_DEFINE_VALIDADOR.test(limpio)) return true;
  return !pasaPorValidador(limpio);
}

const archivos = [
  ...DIRS_BACKEND.flatMap((d) => archivosDe(d, /\.(js|mjs|cjs)$/)),
  ...archivosRaiz(),
  ...archivosDe(DIR_WEBAPP, /\.(ts|tsx)$/),
]
  .map((p) => p.replace(/\\/g, '/'))
  // Los tests del propio árbol de la webapp escriben payloads de fixture a mano.
  .filter((p) => !/\.test\.(ts|tsx)$/.test(p));

let bytesLeidos = 0;
const conEscrituraDePlata = [];
const sospechosos = [];
for (const rel of archivos) {
  const src = fs.readFileSync(path.join(projectRoot, rel), 'utf8');
  bytesLeidos += src.length;
  if (!escribePlata(soloCodigo(src))) continue;
  conEscrituraDePlata.push(rel);
  if (escribePlataSinValidar(src, rel) && !EXENTOS.has(rel)) sospechosos.push(rel);
}

describe('ninguna escritura de dinero se salta el validador', () => {
  it('el barrido alcanza los DOS árboles y la raíz (antivacuidad)', () => {
    expect(archivos.length).toBeGreaterThan(80);
    // Backend.
    expect(archivos).toContain('services/transactions.js');
    expect(archivos).toContain('services/budget.js');
    // La raíz, que es el hueco que tuvo el guard hermano.
    expect(archivos).toContain('gmail.js');
    // Webapp: el árbol que el guard de Math.random no miraba.
    expect(archivos).toContain('webapp/src/lib/spaces-server.ts');
    expect(archivos).toContain('webapp/src/app/api/spaces/[id]/budgets/route.ts');
    // Y que además los LEA, no solo que los liste.
    expect(bytesLeidos).toBeGreaterThan(400000);
  });

  it('encuentra escrituras de plata de verdad en los dos árboles (antivacuidad)', () => {
    // Sin esto, cualquier error que hiciera el barrido devolver cero archivos daría
    // "ningún sospechoso" — verde por vacuidad, que es la dirección peligrosa.
    expect(conEscrituraDePlata.length).toBeGreaterThan(5);
    expect(conEscrituraDePlata.some((f) => !f.startsWith('webapp/'))).toBe(true);
    expect(conEscrituraDePlata.some((f) => f.startsWith('webapp/'))).toBe(true);
  });

  it('ninguna escribe una columna de plata sin mencionar un validador', () => {
    expect(sospechosos, 'escritura de dinero sin validador').toEqual([]);
  });

  /**
   * Hoy `EXENTOS` está VACÍO, así que este test es verde por vacuidad y no puede
   * probar nada — igual que el `it('toda excepción trae su motivo')` del guard de
   * `Math.random` cuando su única exención se fue. Se deja porque el día que alguien
   * agregue la primera exención tiene que traer su motivo, y se prueba la REGLA contra
   * un fixture para que no sea vacuo mientras tanto.
   */
  it('toda excepción trae su motivo (regla probada con fixture)', () => {
    const motivoValido = (m) => typeof m === 'string' && m.length > 30;
    expect(motivoValido('porque sí')).toBe(false);
    expect(motivoValido(undefined)).toBe(false);
    expect(motivoValido('el monto lo valida el chokepoint X, ver la nota de arriba')).toBe(true);
    for (const [archivo, motivo] of EXENTOS) {
      expect(motivoValido(motivo), `${archivo} sin motivo`).toBe(true);
    }
  });
});

describe('el detector reconoce la forma real del bug (contraprueba)', () => {
  it('la versión PRE-FIX de spaces/[id]/budgets, literal', () => {
    // Copiada del archivo tal como estaba antes del fix. Es el hallazgo S′6 entero.
    const preFix = [
      "import { getServiceClient } from '@/lib/supabase/service';",
      "import { getSpaceOwnerIsPro, requireSpaceMember } from '@/lib/spaces-server';",
      'const body = await request.json();',
      'const { budgets } = body;',
      "if (!Array.isArray(budgets)) return NextResponse.json({ error: 'x' }, { status: 400 });",
      "const { error } = await getServiceClient().from('shared_spaces').update({ budgets }).eq('id', id);",
    ].join('\n');
    expect(escribePlataSinValidar(preFix)).toBe(true);
  });

  it('y la versión de HOY ya no', () => {
    const postFix = [
      "import { parseSpaceBudgets, requireSpaceMember } from '@/lib/spaces-server';",
      'const parsed = parseSpaceBudgets(body?.budgets);',
      'if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });',
      "await getServiceClient().from('shared_spaces').update({ budgets: parsed.budgets }).eq('id', id);",
    ].join('\n');
    expect(escribePlataSinValidar(postFix)).toBe(false);
  });

  it.each([
    ["insert de un monto crudo", "await supabase.from('transacciones').insert({ monto: datos.monto, usuario_id: id });"],
    ["update de monto_limite", "await supabase.from('presupuestos').update({ monto_limite: parseFloat(body.limite) }).eq('id', id);"],
    ["upsert de monto_objetivo", "await svc.from('metas_ahorro').upsert({ monto_objetivo: Number(raw), usuario_id: u });"],
    ["JSONB de reglas de reparto", "await svc.from('shared_spaces').update({ split_rules: rules }).eq('id', id);"],
    ["snapshot de división", "await svc.from('space_expenses').insert({ amount, split_snapshot: snap });"],
  ])('%s', (_label, src) => {
    expect(escribePlataSinValidar(src)).toBe(true);
  });

  it('el comentario que EXPLICA la decisión no puede hacer pasar el archivo', () => {
    // `soloCodigo` borra los comentarios ANTES de buscar el validador: si no lo
    // hiciera, bastaba con escribir "acá no hace falta validarMonto" arriba del insert
    // para apagar el guard sobre ese archivo.
    const conComentario = [
      '// el monto ya viene de validarMonto río arriba, acá no hace falta',
      "await supabase.from('transacciones').insert({ monto: datos.monto });",
    ].join('\n');
    expect(escribePlataSinValidar(conComentario)).toBe(true);

    const conBloque = [
      '/** Este archivo delega en guardarTransaccion, que valida por dentro. */',
      "await supabase.from('transacciones').insert({ monto: datos.monto });",
    ].join('\n');
    expect(escribePlataSinValidar(conBloque)).toBe(true);
  });

  it('el stripper de comentarios funciona también con CRLF', () => {
    // Con split('\n') este stripper es un NO-OP en CRLF, o sea en casi todo el árbol
    // en Windows: el guard no queda apagado, queda MUDO sobre los comentarios y por
    // lo tanto se lo puede callar con uno. Es la misma regresión que el guard hermano
    // tuvo durante meses.
    const CR = String.fromCharCode(13);
    expect(escribePlataSinValidar(
      '// validarMonto' + CR + "\nawait supabase.from('t').insert({ monto: x });" + CR + '\n'
    )).toBe(true);
    // Y el código de verdad sobrevive al stripper: si se lo comiera, el guard sería vacuo.
    expect(escribePlataSinValidar(
      "const m = validarMonto(x);" + CR + "\nawait supabase.from('t').insert({ monto: m });" + CR + '\n'
    )).toBe(false);
    // La URL no se come su línea (el `(^|\\s)` delante del `//`).
    expect(escribePlataSinValidar(
      "const u = 'https://api.neto.pe'; await supabase.from('t').insert({ monto: x });" + CR + '\n'
    )).toBe(true);
  });

  it('no marca escrituras que no son de plata', () => {
    expect(escribePlataSinValidar("await supabase.from('usuarios').update({ nombre, plan: 'premium' }).eq('id', u);")).toBe(false);
    expect(escribePlataSinValidar("await supabase.from('conversaciones').insert({ rol: 'neto', mensaje });")).toBe(false);
    // `.limit(...)` de PostgREST no es una columna de plata. Por eso la lista dice
    // `limite` y no `limit`: `limit` suelto en este repo es abrumadoramente el
    // modificador de la query, y un falso positivo cuesta la cobertura del archivo
    // ENTERO — la exención es por archivo.
    expect(escribePlataSinValidar("const { data } = await supabase.from('t').select('id').limit(5);")).toBe(false);
  });

  /**
   * Los tres modos de evasión que encontró la revisión adversarial sobre la primera
   * versión de este guard. Los tres pasaban VERDE.
   */
  it('evasión 1: el payload armado arriba y pasado por variable', () => {
    // La primera versión miraba 400 chars después de `.insert(`, así que este módulo
    // entero —estilo perfectamente normal— era invisible.
    const hoisteado = [
      "const { supabase } = require('../lib/db');",
      'async function crear(usuarioId, body) {',
      '  const fila = {',
      "    usuario_id: usuarioId, tipo: 'debo', contraparte: body.quien,",
      '    monto_original: body.monto, monto_pendiente: body.monto,',
      '  };',
      "  return supabase.from('deudas').insert(fila);",
      '}',
    ].join('\n');
    expect(escribePlataSinValidar(hoisteado)).toBe(true);
  });

  it('evasión 1b: el array llenado con .push() y insertado por tajadas', () => {
    // El patrón real de `transactions/import`: `const toInsert = []` … `toInsert.push({
    // monto })` … `.insert(chunk)` con `chunk = toInsert.slice(...)`. Con la resolución
    // del identificador sola era invisible, porque la declaración es `= []`.
    const porEmpujones = [
      'const toInsert = [];',
      'for (const r of rows) {',
      '  toInsert.push({ usuario_id: userId, monto: r.monto, fecha: r.fecha });',
      '}',
      'const chunk = toInsert.slice(0, 200);',
      "await getServiceClient().from('transacciones').insert(chunk);",
    ].join('\n');
    expect(escribePlataSinValidar(porEmpujones)).toBe(true);
  });

  /**
   * Un chokepoint no puede bendecirse a sí mismo. `services/debts.js` contiene la
   * palabra `registrarDeuda` porque es el nombre de su propia función exportada, así
   * que con la primera lista quitarle `validarMonto` dejaba el guard en VERDE. Lo
   * delató la batería de mutación, no la lectura.
   */
  it('evasión 1c: `$` en el nombre de la variable (es ancla de regex)', () => {
    const conDolar = [
      'const $fila = { monto_original: body.monto, monto_pendiente: body.monto };',
      "await supabase.from('deudas').insert($fila);",
    ].join('\n');
    expect(escribePlataSinValidar(conDolar)).toBe(true);
  });

  it('evasión 1d: el mismo nombre local declarado dos veces, el inocuo primero', () => {
    // `String.match` sin `g` devuelve la PRIMERA declaración del archivo, no la más
    // cercana. Las dos funciones tienen que estar separadas por más de la ventana o el
    // solape hace pasar el test por la razón equivocada.
    const dosDeclaraciones = [
      'async function renombrar(id, nombre) {',
      '  const fila = { nombre, actualizado: new Date().toISOString() };',
      "  return supabase.from('usuarios').update(fila).eq('id', id);",
      '}',
      '// ' + 'x'.repeat(900),
      'async function crearDeuda(usuarioId, body) {',
      '  const fila = { usuario_id: usuarioId, monto_original: body.monto };',
      "  return supabase.from('deudas').insert(fila);",
      '}',
    ].join('\n');
    expect(escribePlataSinValidar(dosDeclaraciones)).toBe(true);
  });

  it('evasión 1e: el literal de array', () => {
    const literalArray = [
      'const filas = [{ usuario_id: id, monto: body.monto }];',
      "await supabase.from('transacciones').insert(filas);",
    ].join('\n');
    expect(escribePlataSinValidar(literalArray)).toBe(true);
  });

  it('evasión 2b: el chokepoint que se bendice a sí mismo por definirse', () => {
    const chokepointSinValidar = [
      'async function registrarDeuda(usuarioId, monto) {',
      "  return supabase.from('deudas').insert({ usuario_id: usuarioId, monto_original: monto });",
      '}',
    ].join('\n');
    expect(escribePlataSinValidar(chokepointSinValidar, 'services/debts.js')).toBe(true);
    // Pero un archivo que lo LLAMA sí delega de verdad.
    const delegando = [
      "const { registrarDeuda } = require('../../services/debts');",
      'await registrarDeuda(usuario.id, tipo, contraparte, monto);',
      "await supabase.from('deudas').insert({ monto_original: monto });",
    ].join('\n');
    expect(escribePlataSinValidar(delegando, 'handlers/intents/deudas.js')).toBe(false);
  });

  it('evasión 2: definir una COPIA local del validador', () => {
    // `RE_VALIDADOR` es un match de palabra sobre el archivo, así que alcanzaba con
    // llamarle igual a cualquier cosa. Y no era hipotético: dos rutas de
    // `transactions/` tenían su propia copia de `validarMonto`.
    const copiaLocal = [
      'function validarMonto(x) { return x; }',
      "await supabase.from('transacciones').insert({ monto: validarMonto(body.monto) });",
    ].join('\n');
    expect(escribePlataSinValidar(copiaLocal, 'webapp/src/app/api/algo/route.ts')).toBe(true);
    // Pero en el archivo DUEÑO, definirlo es exactamente lo que corresponde.
    expect(escribePlataSinValidar(copiaLocal, 'lib/validators.js')).toBe(false);
  });

  it('evasión 3: un JSDoc largo empujando el payload fuera de la ventana', () => {
    // `soloCodigo` rellenaba los comentarios de bloque con espacios de la MISMA
    // longitud, así que un JSDoc normal de este repo corría el `monto:` más allá de los
    // 400 chars y el archivo dejaba de contar como escritura de plata. Sin ventana esto
    // ya no depende del largo del comentario, pero el fixture se queda como candado.
    const conJsdoc = [
      '/**',
      ' * ' + 'x'.repeat(600),
      ' */',
      "await supabase.from('transacciones').insert({ monto: datos.monto });",
    ].join('\n');
    expect(escribePlataSinValidar(conJsdoc)).toBe(true);
  });

  /**
   * El límite de la ventana, fijado a propósito: un archivo que LEE `monto` para
   * calcular otra cosa y persiste esa otra cosa NO es una escritura de plata.
   *
   * Sin ventana el barrido marcaba `services/neto-score.js`, `spending-alerts.js` y
   * ocho rutas más — diez exenciones por dos hallazgos, o sea el guard apagado con
   * pasos extra. La cobertura del caso hoisteado se recupera resolviendo el
   * identificador (test de arriba), no ensanchando el radio.
   */
  it('leer un monto para calcular otra cosa NO es escribir plata', () => {
    const lejano = "await supabase.from('scores').insert({ score });" + ' '.repeat(600) + 'const monto = fila.monto;';
    expect(escribePlataSinValidar(lejano)).toBe(false);
  });
});
