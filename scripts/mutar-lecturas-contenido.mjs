#!/usr/bin/env node
/**
 * Mutación sobre las 30 guardas de `{ error }` de `handlers/intents/`: las 16 del ítem 9B más
 * las 14 de 9B-quater (deudas 2, espacios 2, metas 8, moderación 1, presupuestos 1).
 *
 * Neutraliza UNA por vez y corre los tests. Una guarda que sobrevive es una guarda sin test:
 * el código quedó arreglado y nada lo sostiene.
 *
 * **Familias de mutación, y todas hacen falta.** La primera es obvia; las otras salieron de lo
 * que estos ítems tienen de particular:
 *
 *  · `if (err)` → `if (false)` — el bug original: el error destructurado y descartado.
 *  · `return MSG_LECTURA_CAIDA` → `throw` — esos sitios DEVUELVEN a propósito: un throw
 *    termina en el catch general de `procesarMensajeLibre`, que lo anota en `nlp_errors`
 *    como fallo de NLP y avisa al admin. Sin esta familia, "devuelve" y "lanza" son
 *    indistinguibles para la suite y esa decisión no está sostenida por nada. (Una versión
 *    anterior de este párrafo decía que el camino REGISTRA un gasto: es falso, `transacciones.js:411`
 *    corta el rescate con `redirect ||`. Lo encontró la revisión adversarial.)
 *  · en los dos `Promise.all`, `if (a || b)` → `if (a)` y → `if (b)` — o sea quitarle la
 *    guarda a UNA mitad. Es la mutación que un fixture que tira las dos queries a la vez no
 *    puede matar, y es exactamente el fallo real: la mitad que sobrevive fabrica el número.
 *  · **el log queda y el corte se va** (9B-quater). Sin esta familia, "avisa" y "corta" son
 *    una sola mutación: `if (false)` mata las dos afirmaciones de cada test a la vez, así que
 *    ninguna de las dos queda probada por separado. Es el modo de falla que
 *    `feedback_guards_que_no_ven` describe, aplicado a la mutación en vez de al guard.
 *  · **la decisión propia de un sitio**, que la forma común no cubre: el copy del aviso que no
 *    puede afirmar lo que no midió, las DOS condiciones del corte de `abonar_deuda`,
 *    `maybeSingle` vs `single`, y el conteo que `head: true` deja en `count` y no en `data`.
 *
 * **El script AFIRMA que la mutación se aplicó.** Una que no matcheó y una que el test no
 * atrapa producen el MISMO verde (defecto `mutacion-que-no-se-aplico`, ítem 1).
 *
 * Uso:
 *   node scripts/mutar-lecturas-contenido.mjs             # contra el archivo de 9B
 *   node scripts/mutar-lecturas-contenido.mjs --completa  # cada superviviente contra la suite entera
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const G = 'handlers/intents/gastos.js';
const U = 'handlers/intents/utilidades.js';
const A = 'handlers/intents/analytics.js';
const P = 'handlers/intents/presupuestos.js';
// ── 9B-quater ──
const D = 'handlers/intents/deudas.js';
const E = 'handlers/intents/espacios.js';
const M = 'handlers/intents/metas.js';
const MO = 'handlers/intents/moderacion.js';

const TEST = 'tests/handlers/lecturas-de-contenido.test.js';
const completa = process.argv.includes('--completa');

/**
 * `nth` (1-based) es para los ocho `return MSG_LECTURA_CAIDA;` (cinco de los dieciséis más los
 * tres call-sites de helper), que son literalmente el mismo texto: sin él, "reemplazar el
 * primero" pasaría por cubrir los ocho.
 */
const MUTACIONES = [
  // ── if (err) → if (false): el bug original, sitio por sitio ────────────────
  { id: 'gastos:37 errTodas', archivo: G, de: 'if (errTodas) {', a: 'if (false) {' },
  { id: 'gastos:56 errMes', archivo: G, de: 'if (errMes) {', a: 'if (false) {' },
  { id: 'gastos:72 errAnt (accesoria)', archivo: G, de: "if (errAnt) log.warn(", a: 'if (false) log.warn(' },
  { id: 'gastos:99 errDia', archivo: G, de: 'if (errDia) {', a: 'if (false) {' },
  { id: 'gastos:130 errCat', archivo: G, de: 'if (errCat) {', a: 'if (false) {' },
  { id: 'gastos:172 errRango', archivo: G, de: 'if (errRango) throw errRango;', a: 'if (false) throw errRango;' },
  { id: 'gastos:219 errGH', archivo: G, de: 'if (errGH) {', a: 'if (false) {' },
  { id: 'utilidades:71 errBusq', archivo: U, de: 'if (errBusq) throw errBusq;', a: 'if (false) throw errBusq;' },
  { id: 'utilidades:132 errFreq', archivo: U, de: 'if (errFreq) throw errFreq;', a: 'if (false) throw errFreq;' },
  { id: 'analytics:84 errModif', archivo: A, de: 'if (errModif) throw errModif;', a: 'if (false) throw errModif;' },
  { id: 'analytics:110 errIngSem', archivo: A, de: 'if (errIngSem) throw errIngSem;', a: 'if (false) throw errIngSem;' },
  { id: 'analytics:115 errIngMes', archivo: A, de: 'if (errIngMes) throw errIngMes;', a: 'if (false) throw errIngMes;' },

  // ── los dos Promise.all: la guarda entera, y cada mitad por separado ───────
  { id: 'utilidades:100/101 par completo', archivo: U, de: 'if (err1 || err2) {', a: 'if (false) {' },
  { id: 'utilidades:101 sin guarda (solo mira mes1)', archivo: U, de: 'if (err1 || err2) {', a: 'if (err1) {' },
  { id: 'utilidades:100 sin guarda (solo mira mes2)', archivo: U, de: 'if (err1 || err2) {', a: 'if (err2) {' },
  { id: 'presupuestos:70/71 par completo', archivo: P, de: 'if (errG || errI) {', a: 'if (false) {' },
  { id: 'presupuestos:71 sin guarda (solo mira gastos)', archivo: P, de: 'if (errG || errI) {', a: 'if (errG) {' },
  { id: 'presupuestos:70 sin guarda (solo mira ingresos)', archivo: P, de: 'if (errG || errI) {', a: 'if (errI) {' },

  // ── el rastro en producción: si el tag se renombra, nadie lo encuentra ────
  { id: 'gastos: tag renombrado', archivo: G, de: "const LECTURA_CAIDA_TAG = 'LECTURA_CAIDA';", a: "const LECTURA_CAIDA_TAG = 'OTRA_COSA';" },
  { id: 'utilidades: tag renombrado', archivo: U, de: "tag: 'LECTURA_CAIDA'", a: "tag: 'OTRA_COSA'" },
  { id: 'presupuestos: tag renombrado (ver_balance)', archivo: P, nth: 1, de: "tag: 'LECTURA_CAIDA'", a: "tag: 'OTRA_COSA'" },
  { id: 'presupuestos: mitad vuelve a nombrar una sola', archivo: P, de: "mitad: [errG && 'gastos', errI && 'ingresos'].filter(Boolean).join('+')", a: "mitad: errG ? 'gastos' : 'ingresos'" },
  { id: 'utilidades: mitad vuelve a nombrar una sola', archivo: U, de: "mitad: [err1 && 'mes1', err2 && 'mes2'].filter(Boolean).join('+')", a: "mitad: err1 ? 'mes1' : 'mes2'" },

  // ── los tres call-sites de helper (no son de los 16, ver gastos.js) ────────
  { id: 'gastos: helper mes actual sin guarda', archivo: G, de: 'if (r.caida) return MSG_LECTURA_CAIDA;', a: 'if (false) return MSG_LECTURA_CAIDA;' },
  { id: 'gastos: helper semana sin guarda', archivo: G, de: 'if (rSem.caida) return MSG_LECTURA_CAIDA;', a: 'if (false) return MSG_LECTURA_CAIDA;' },
  { id: 'gastos: helper total gastado sin guarda', archivo: G, de: 'if (rVt.caida) return MSG_LECTURA_CAIDA;', a: 'if (false) return MSG_LECTURA_CAIDA;' },

  // ── devolver → lanzar: la decisión que protege el camino del redirect ──────
  ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({
    id: 'gastos: return→throw #' + n,
    archivo: G, nth: n,
    de: 'return MSG_LECTURA_CAIDA;',
    a: "throw new Error('mutante: lanza en vez de devolver');",
  })),
  // ══ 9B-quater: las 14 lecturas de deudas/espacios/metas/moderación/presupuestos ══

  // ── if (err) → if (false): el bug original, sitio por sitio ────────────────
  { id: 'metas:20 ver_metas sin guarda', archivo: M, de: 'if (errMetasVer) {', a: 'if (false) {' },
  { id: 'metas:62 crear_meta sin guarda', archivo: M, de: 'if (errMetasActivas) {', a: 'if (false) {' },
  { id: 'metas:111 editar_meta sin guarda', archivo: M, de: 'if (errMetasEdit) {', a: 'if (false) {' },
  { id: 'metas:156 eliminar_meta sin guarda', archivo: M, de: 'if (errMetasDel) {', a: 'if (false) {' },
  { id: 'metas:250 compartir_meta sin guarda', archivo: M, de: 'if (errMetasComp) {', a: 'if (false) {' },
  { id: 'metas:299 viabilidad_plan sin guarda', archivo: M, de: 'if (errMetasViab) {', a: 'if (false) {' },
  { id: 'metas:327 abandonar_plan sin guarda', archivo: M, de: 'if (errMetasAband) {', a: 'if (false) {' },
  { id: 'metas:357 sugerir_recortes sin guarda', archivo: M, de: 'if (errMetasRec) {', a: 'if (false) {' },
  { id: 'espacios:185 liquidar_espacio sin guarda', archivo: E, de: 'if (errMembers) {', a: 'if (false) {' },
  { id: 'espacios:217 invitar_espacio sin guarda', archivo: E, de: 'if (errMembersInv) {', a: 'if (false) {' },
  { id: 'presupuestos:123 eliminar_presupuesto sin guarda', archivo: P, de: 'if (errPresElim) {', a: 'if (false) {' },
  { id: 'deudas:116 registrar_deuda sin guarda', archivo: D, de: 'if (errDupOpuesta) {', a: 'if (false) {' },
  { id: 'deudas:199 abonar_deuda sin guarda', archivo: D, de: 'if (errDeudasCalc) {', a: 'if (false) {' },
  { id: 'moderacion:32 silenciar sin guarda', archivo: MO, de: 'if (errLastEvent) {', a: 'if (false) {' },

  // ── el LOG queda, el CORTE se va ──────────────────────────────────────────
  // Sin esta familia, "avisa" y "corta" son una sola mutación: la de arriba mata las dos
  // afirmaciones de cada test a la vez, así que ninguna queda probada por separado.
  { id: 'metas:20 ver_metas loguea pero no corta', archivo: M, de: 'throw errMetasVer;', a: '/* mutante: no corta */;' },
  // `crear_meta` NO lanza a propósito (el conteo informa, no decide). Sus mutaciones son las
  // dos direcciones del error: no cortar cuando el conteo SÍ decidiría, y cortar cuando no.
  { id: 'metas:62 no corta ni con cuota finita (abre el muro)', archivo: M,
    de: 'if (errMetasActivas && Number.isFinite(limitCheck.limit) && limitCheck.limit > 0) {', a: 'if (false) {' },
  { id: 'metas:62 corta siempre (apaga de mas)', archivo: M,
    de: 'if (errMetasActivas && Number.isFinite(limitCheck.limit) && limitCheck.limit > 0) {', a: 'if (errMetasActivas) {' },
  { id: 'metas:62 el muro vuelve a recitar un conteo que no es el motivo', archivo: M,
    de: 'if (!Number.isFinite(limitCheck.limit) || limitCheck.limit === 0) {', a: 'if (false) {' },
  { id: 'metas:62 plural roto', archivo: M,
    de: "(countActivas === 1 ? ' plan de ahorro activo' : ' planes de ahorro activos')", a: "' plan de ahorro activo'" },
  // Sin `{ count: 'exact' }` postgrest devuelve `count: null` y el conteo vuelve a ser 0 fijo.
  { id: 'metas:62 sin count exact', archivo: M,
    de: "{ count: 'exact', head: true }", a: '{ head: true }' },
  { id: 'metas:111 editar_meta loguea pero no corta', archivo: M, de: 'throw errMetasEdit;', a: '/* mutante: no corta */;' },
  { id: 'metas:156 eliminar_meta loguea pero no corta', archivo: M, de: 'throw errMetasDel;', a: '/* mutante: no corta */;' },
  { id: 'metas:250 compartir_meta loguea pero no corta', archivo: M, de: 'throw errMetasComp;', a: '/* mutante: no corta */;' },
  { id: 'metas:299 viabilidad_plan loguea pero no corta', archivo: M, de: 'throw errMetasViab;', a: '/* mutante: no corta */;' },
  { id: 'metas:327 abandonar_plan loguea pero no corta', archivo: M, de: 'throw errMetasAband;', a: '/* mutante: no corta */;' },
  { id: 'metas:357 sugerir_recortes loguea pero no corta', archivo: M, de: 'throw errMetasRec;', a: '/* mutante: no corta */;' },
  { id: 'espacios:185 liquidar_espacio loguea pero no corta', archivo: E, de: 'throw errMembers;', a: '/* mutante: no corta */;' },
  { id: 'espacios:217 invitar_espacio loguea pero no corta', archivo: E, de: 'throw errMembersInv;', a: '/* mutante: no corta */;' },
  { id: 'presupuestos:123 eliminar_presupuesto loguea pero no corta', archivo: P, de: 'throw errPresElim;', a: '/* mutante: no corta */;' },
  // Este no lanza a propósito —decide más abajo, y sólo si el mensaje pedía una fracción—, así
  // que su versión de "loguea pero no actúa" es apagarle el flag.
  { id: 'deudas:199 abonar_deuda loguea pero no corta', archivo: D, de: 'pendienteNoLeido = true;', a: 'pendienteNoLeido = false;' },

  // ── el rastro: un tag renombrado no lo encuentra nadie en producción ──────
  { id: 'metas:20 ver_metas tag renombrado', archivo: M, nth: 1, de: "tag: 'LECTURA_CAIDA'", a: "tag: 'OTRA_COSA'" },
  { id: 'metas:62 crear_meta tag renombrado', archivo: M, nth: 2, de: "tag: 'LECTURA_CAIDA'", a: "tag: 'OTRA_COSA'" },
  { id: 'metas:111 editar_meta tag renombrado', archivo: M, nth: 3, de: "tag: 'LECTURA_CAIDA'", a: "tag: 'OTRA_COSA'" },
  { id: 'metas:156 eliminar_meta tag renombrado', archivo: M, nth: 4, de: "tag: 'LECTURA_CAIDA'", a: "tag: 'OTRA_COSA'" },
  { id: 'metas:250 compartir_meta tag renombrado', archivo: M, nth: 5, de: "tag: 'LECTURA_CAIDA'", a: "tag: 'OTRA_COSA'" },
  { id: 'metas:299 viabilidad_plan tag renombrado', archivo: M, nth: 6, de: "tag: 'LECTURA_CAIDA'", a: "tag: 'OTRA_COSA'" },
  { id: 'metas:327 abandonar_plan tag renombrado', archivo: M, nth: 7, de: "tag: 'LECTURA_CAIDA'", a: "tag: 'OTRA_COSA'" },
  { id: 'metas:357 sugerir_recortes tag renombrado', archivo: M, nth: 8, de: "tag: 'LECTURA_CAIDA'", a: "tag: 'OTRA_COSA'" },
  { id: 'espacios:185 liquidar_espacio tag renombrado', archivo: E, nth: 1, de: "tag: 'LECTURA_CAIDA'", a: "tag: 'OTRA_COSA'" },
  { id: 'espacios:217 invitar_espacio tag renombrado', archivo: E, nth: 2, de: "tag: 'LECTURA_CAIDA'", a: "tag: 'OTRA_COSA'" },
  { id: 'presupuestos:123 eliminar_presupuesto tag renombrado', archivo: P, nth: 2, de: "tag: 'LECTURA_CAIDA'", a: "tag: 'OTRA_COSA'" },
  { id: 'deudas:116 registrar_deuda tag renombrado', archivo: D, nth: 1, de: "tag: 'LECTURA_CAIDA'", a: "tag: 'OTRA_COSA'" },
  { id: 'deudas:199 abonar_deuda tag renombrado', archivo: D, nth: 2, de: "tag: 'LECTURA_CAIDA'", a: "tag: 'OTRA_COSA'" },
  { id: 'moderacion:32 silenciar tag renombrado', archivo: MO, nth: 1, de: "tag: 'LECTURA_CAIDA'", a: "tag: 'OTRA_COSA'" },

  // ── las decisiones propias de un sitio, que la forma común no cubre ───────
  // El aviso de `registrar_deuda` es la MITAD que ve el usuario: el log puede seguir vivo y
  // el desenlace —dos anotaciones opuestas sin ninguna pista— volver a ser invisible.
  { id: 'deudas:116 el aviso vuelve a afirmar lo que no midio', archivo: D,
    de: '⚠️ No pude revisar si te quedó', a: '⚠️ Ojo: te quedó también' },
  // El corte de `abonar_deuda` tiene DOS condiciones y las dos deciden: sin la fracción
  // apaga de más (frena un abono que no dependía de esa lectura), sin el flag no apaga nada.
  { id: 'deudas:199 no corta nunca', archivo: D,
    de: 'if (contraparte && pideFraccion(msg) && montoAbono === null) {', a: 'if (false) {' },
  { id: 'deudas:199 corta sin mirar si pidio fraccion (apaga de mas)', archivo: D,
    de: 'if (contraparte && pideFraccion(msg) && montoAbono === null) {', a: 'if (contraparte && montoAbono === null) {' },
  // La corrección de la revisión adversarial: cortar por la CAUSA deja afuera las otras dos
  // que producen el mismo daño (sin deuda activa, `monto_pendiente` en null/0).
  { id: 'deudas:199 vuelve a cortar por la causa y no por el desenlace', archivo: D,
    de: 'if (contraparte && pideFraccion(msg) && montoAbono === null) {', a: 'if (contraparte && pideFraccion(msg) && pendienteNoLeido) {' },
  // Los dos desenlaces cortan igual pero no dicen lo mismo: uno manda a reintentar, el otro
  // a revisar el nombre. Unificarlos borra la distinción que este ítem entero persigue.
  { id: 'deudas:199 un solo mensaje para los dos desenlaces', archivo: D,
    de: 'return pendienteNoLeido', a: 'return true' },
  // `single` devuelve PGRST116 con cero filas, o sea que la guarda gritaría todos los días
  // sobre quien nunca recibió una encuesta. Un warn que suena siempre no es un rastro.
  { id: 'moderacion:32 vuelve a single()', archivo: MO, de: '.maybeSingle();', a: '.single();' },
  // El conteo del muro: `head: true` no devuelve filas, sólo `count`.
  { id: 'metas:62 el conteo vuelve a 0 fijo', archivo: M, de: 'const countActivas = countActivasDb || 0;', a: 'const countActivas = 0;' },
];

function reemplazar(src, de, a, nth) {
  const partes = src.split(de);
  const total = partes.length - 1;
  if (nth === undefined) {
    if (total !== 1) return { error: total + ' matches (se esperaba 1)' };
    return { src: partes.join(a) };
  }
  if (total < nth) return { error: 'hay ' + total + ' matches, se pidió el #' + nth };
  return { src: partes.slice(0, nth).join(de) + a + partes.slice(nth).join(de) };
}

function corridaVerde(objetivo) {
  try {
    execSync('npx vitest run ' + objetivo, { stdio: 'pipe', encoding: 'utf-8' });
    return true;
  } catch {
    return false;
  }
}

// Línea base: si la suite ya está roja, "muere" no significa nada.
process.stdout.write('base… ');
if (!corridaVerde(TEST)) {
  console.error('FATAL: ' + TEST + ' ya está rojo sin mutar. Arreglá eso primero.');
  process.exit(1);
}
console.log('verde\n');

const originales = new Map();
for (const f of [G, U, A, P, D, E, M, MO]) originales.set(f, readFileSync(f, 'utf-8'));
const restaurar = () => { for (const [f, s] of originales) writeFileSync(f, s); };
process.on('exit', restaurar);
process.on('SIGINT', () => { restaurar(); process.exit(130); });

const sobreviven = [];
for (const m of MUTACIONES) {
  const original = originales.get(m.archivo);
  const r = reemplazar(original, m.de, m.a, m.nth);
  if (r.error) {
    console.error('FATAL [' + m.id + ']: la mutación NO se aplicó — ' + r.error);
    console.error('  Una mutación que no toca el archivo sale verde por vacuidad y se lee como cobertura faltante.');
    process.exit(1);
  }
  writeFileSync(m.archivo, r.src);
  const verde = corridaVerde(TEST);
  writeFileSync(m.archivo, original);
  console.log((verde ? 'SOBREVIVE  ' : 'muere      ') + m.id);
  if (verde) sobreviven.push(m);
}

console.log('\n' + (MUTACIONES.length - sobreviven.length) + '/' + MUTACIONES.length + ' mueren');

if (sobreviven.length && completa) {
  console.log('\n— supervivientes contra la suite entera —');
  for (const m of sobreviven) {
    const original = originales.get(m.archivo);
    writeFileSync(m.archivo, reemplazar(original, m.de, m.a, m.nth).src);
    const verde = corridaVerde('');
    writeFileSync(m.archivo, original);
    console.log((verde ? 'SOBREVIVE  ' : 'muere      ') + m.id);
  }
}

process.exit(sobreviven.length ? 1 : 0);
