#!/usr/bin/env node
/**
 * Mutación sobre las 16 guardas de `{ error }` de `handlers/intents/` (ítem 9B).
 *
 * Neutraliza UNA por vez y corre los tests. Una guarda que sobrevive es una guarda sin test:
 * el código quedó arreglado y nada lo sostiene.
 *
 * **Tres familias de mutación, y las tres hacen falta.** La primera es obvia; las otras dos
 * salieron de lo que este ítem tiene de particular:
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
  { id: 'presupuestos: tag renombrado', archivo: P, de: "tag: 'LECTURA_CAIDA'", a: "tag: 'OTRA_COSA'" },
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
for (const f of [G, U, A, P]) originales.set(f, readFileSync(f, 'utf-8'));
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
