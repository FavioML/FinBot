// Aceptación del prompt de `parsearRegistroManual` con el campo `decision` (chip 1 de la tanda
// "respuestas malas del día 0", 30-sep-2026).
//
// Un cambio de prompt no se mata por mutación: los tests mockean OpenAI, así que "el prompt
// tiene la regla" no prueba que el modelo la obedezca. Esta sonda llama al modelo REAL, N veces
// por mensaje, y compara el EFECTO que vería la persona (lo que se guardaría, o por qué no),
// no la salida cruda del modelo:
//
//   efecto = parser; y si el parser no registra, el rescate determinístico con las mismas
//            guardas que `registrar_manual` (detectarQuerySinMonto, esSoloUnNumero,
//            contarMontosCandidatos). Con la versión nueva, el rescate sólo corre con
//            `decision === 'sin_monto'` o sin `decision`.
//
// Con `--contra <ref>` corre ADEMÁS la versión de `services/parsers.js` de ese commit y
// reporta cada positivo que la versión de referencia registraba y la actual ya no, o que
// registra con otro tipo u otro monto. Ésa es la condición de aceptación: 0 regresiones.
//
// Tres baterías:
//   pool     los casos `registrar_manual` de `tests/nlp/pool.js`. Su esperado es el efecto de
//            la referencia cuando la referencia registra N de N; si no, se reporta sin juzgar.
//            Todo `tipo_dudoso` se lista uno por uno, para revisarlo a mano.
//   reales   mensajes reales de producción (60 días al 30-sep): los rebotes "No pude leer el
//            monto" (clase 1), los movimientos mal tipados (clase 4) y las filas que el rescate
//            número-primero sí registró (hoy las registra el rescate; desde este cambio las
//            tiene que registrar el parser, porque el rescate ya no corre con `tipo_dudoso`).
//   copy     las formas que el copy de los rebotes le enseña a la persona. Si el ejemplo del
//            rebote no entra, el rebote se contradice a sí mismo (pasó con "110.70 carne").
//
// Read-only, cero DB. Costo: N (o 2N con --contra) llamadas gpt-4o-mini por mensaje.
//
// Correr (desde app/):
//   node qa-e2e/probe-parser-decision.mjs [--n 3] [--contra 9e2adb7] [--solo pool|reales|copy]
// Exit 1 si hay regresiones en positivos o si un caso de `reales`/`copy` con esperado fijo
// no se cumple N de N.

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const N = Number(arg('--n', 3));
const CONTRA = arg('--contra', null);
const SOLO = arg('--solo', null);
const FECHA = '2026-09-30';
const CONCURRENCIA = 6;

const { extraerGastoSinIA, contarMontosCandidatos, quitarTokensDeMoneda, mencionaMonedaNoSoportada, montoEscritoEnMensaje, tipoContradiceElMensaje } = require(path.join(appRoot, 'lib/nlp-guards.js'));
const { detectarQuerySinMonto } = require(path.join(appRoot, 'handlers/intents/transacciones.js'));
const esSoloUnNumero = (m) => /^\s*\d+(?:[.,]\d+)?\s*[.!]?\s*$/.test(quitarTokensDeMoneda(m));

// La versión de referencia va al directorio temporal del sistema, NUNCA dentro del repo: una
// copia en `services/` que sobreviviera a un `taskkill` quedaba a un `git add -A` de entrar a un
// commit, y `services/` redespliega Railway (revisión adversarial, 30-sep). Sus `require`
// relativos se reescriben a rutas absolutas del árbol, así resuelve contra las mismas dependencias.
let refPath = null;
function cargarReferencia(ref) {
  const src = execFileSync('git', ['show', `${ref}:services/parsers.js`], { cwd: appRoot, encoding: 'utf8' })
    .replace(/require\((['"])(\.\.?\/[^'"]+)\1\)/g, (_, q, rel) =>
      `require(${JSON.stringify(path.resolve(appRoot, 'services', rel))})`);
  refPath = path.join(os.tmpdir(), `neto-parsers-ref-${process.pid}.cjs`);
  fs.writeFileSync(refPath, src);
  return require(refPath).parsearRegistroManual;
}
const limpiar = () => { if (refPath && fs.existsSync(refPath)) fs.unlinkSync(refPath); };
process.on('exit', limpiar);
process.on('SIGINT', () => { limpiar(); process.exit(130); });

const actual = require(path.join(appRoot, 'services/parsers.js')).parsearRegistroManual;
const referencia = CONTRA ? cargarReferencia(CONTRA) : null;

// El efecto de un mensaje en `registrar_manual`, en una cadena comparable.
// Mismo orden que el handler: moneda primero (antes de mirar la decisión), después registrar,
// después la decisión, después el redirect a consulta y el rescate.
function efecto(p, msg) {
  if (p && p._err) return 'ERR';
  if (p && p.moneda && p.moneda !== 'PEN' && p.moneda !== 'USD') return `moneda_no_soportada:${p.moneda}`;
  // Los dos invariantes del handler: monto no escrito → rebote pidiendo el número; tipo que
  // contradice el verbo → se pregunta. El rescate también pasa por el de sentido.
  if (p && p.ok && Number(p.monto) > 0 && !montoEscritoEnMensaje(p.monto, msg)) return 'sin_monto(monto_no_escrito)';
  if (p && p.ok && tipoContradiceElMensaje(p.tipo, msg)) return 'tipo_dudoso';
  const registra = p && p.ok && Number(p.monto) > 0;
  if (registra) {
    const mon = p.moneda && p.moneda !== 'PEN' ? p.moneda : '';
    return `${p.tipo === 'ingreso' ? 'ingreso' : 'gasto'} ${Number(p.monto)}${mon}`;
  }
  if (p && p.decision && p.decision !== 'sin_monto') return p.decision;
  if (detectarQuerySinMonto(msg)) return 'consulta';
  const rescate = (esSoloUnNumero(msg) || contarMontosCandidatos(msg) > 1) ? null : extraerGastoSinIA(msg);
  if (rescate && tipoContradiceElMensaje(rescate.tipo, msg)) return 'tipo_dudoso';
  if (rescate) return `${rescate.tipo} ${rescate.monto}${rescate.moneda !== 'PEN' ? rescate.moneda : ''} (rescate)`;
  if (mencionaMonedaNoSoportada(msg)) return 'moneda_no_soportada:rescate';
  return p && p.decision ? p.decision : 'rebote';
}
const sinRescate = (e) => e.replace(' (rescate)', '');
const registra = (e) => /^(gasto|ingreso) /.test(e);

async function correr(fn, msg) {
  const out = [];
  for (let i = 0; i < N; i++) {
    let p;
    try { p = await fn(msg, FECHA); } catch (e) { p = { _err: e.message }; }
    out.push(efecto(p, msg));
  }
  return out;
}

// esp: 'gasto 35' | 'ingreso 2300' | 'tipo_dudoso' | 'no_es_movimiento' | 'sin_monto' |
//      'no_registra' (cualquier cosa menos registrar) | 'moneda_no_soportada' | '*' (sólo se reporta)
const REALES = [
  // Clase 1: forma corta sin verbo, rebotaba 4/4.
  { msg: 'Almuerzo 10', esp: 'gasto 10' },
  { msg: 'Almuerzo 10.00', esp: 'gasto 10' },
  { msg: 'Uñas 35', esp: 'gasto 35' },
  // "Mamá 100" no dice si la plata fue a mamá o vino de ella: preguntar es aceptable, rebotar
  // (HEAD) no lo era y guardar el signo al revés tampoco.
  { msg: 'Mamá 100', esp: 'gasto 100|tipo_dudoso' },
  { msg: 'Serrucho 35', esp: 'gasto 35' },
  { msg: 'Tijera 27', esp: 'gasto 27' },
  { msg: 'Viaje 100', esp: 'gasto 100' },
  { msg: 'Alimentación 17.5', esp: 'gasto 17.5' },
  { msg: 'Movilidad 5.1', esp: 'gasto 5.1' },
  { msg: 'Rocotin payaso 800', esp: 'gasto 800' },
  { msg: 'Cigarros 12 tarjeta BCP', esp: 'gasto 12' },
  { msg: 'Compras en plaza vea con zip 66', esp: 'gasto 66' },
  { msg: '66 en plaza vea con zip', esp: 'gasto 66' },
  { msg: '60.00 jabones de mano y cuerpo', esp: 'gasto 60' },
  { msg: '“10 almuerzo “', esp: 'gasto 10' },
  { msg: '"10.00 almuerzo"', esp: 'gasto 10' },
  { msg: '22.07 Mass el 25 de septiembre', esp: 'gasto 22.07' },
  { msg: '22.07 Mass fecha el 25 de septiembre', esp: 'gasto 22.07' },
  { msg: '4 en pan y maca', esp: 'gasto 4' },
  // Banda inestable de gpt-4o-mini en las DOS versiones: HEAD dio gasto/rebote/gasto el 30-sep y
  // en producción rebotó; la nueva, gasto 2/3 y rebote 1/3. El peor caso es un rebote, nunca plata
  // mal guardada, así que se reporta sin juzgar.
  { msg: 'Done 50.00 para la comunidad', esp: '*' },
  { msg: 'Gasté 14.8 Alimentos', esp: 'gasto 14.8' },
  { msg: 'Gaste 2.5 transporte', esp: 'gasto 2.5' },
  { msg: 'Carne, ciento diez punto setenta.', esp: '*' },
  { msg: 'Carne, ciento noventa y ocho punto setenta.', esp: '*' },
  // Clase 1, pero sin monto o sin movimiento: tienen que seguir sin registrar.
  { msg: 'Viaje', esp: 'no_registra' },
  { msg: 'Fiesta arturo', esp: 'no_registra' },
  { msg: 'Gaste', esp: 'no_registra' },
  { msg: 'Colectivo viernrs noche', esp: 'no_registra' },
  { msg: 'suscripción de DIRECTV por el mes de julio', esp: 'no_registra' },
  { msg: 'Pago cuentas gemini ponlo en gasto', esp: 'no_registra' },
  { msg: 'El comercio es Yape', esp: 'no_es_movimiento' },
  { msg: 'Escucha ese gasto fue el domingo 6', esp: 'no_es_movimiento' },
  { msg: 'Fue el 18 de setiembre', esp: 'no_es_movimiento' },
  { msg: 'El día 25 de julio de 2026', esp: 'no_registra' },
  { msg: 'Es ingreso me dieron a mi corrige', esp: 'no_es_movimiento' },
  { msg: 'Tengo 5.23 en bcp yape', esp: 'no_es_movimiento' },
  { msg: '2.5', esp: 'tipo_dudoso' },
  // Moneda que Neto no anota: el rechazo tiene que poder decir la verdad.
  { msg: 'Eh gastado 20 euros en un polo', esp: 'moneda_no_soportada' },
  { msg: 'En revolut he gastado 18€ para pagar claude', esp: 'moneda_no_soportada' },
  // Clase 4: plata mal tipada sin preguntar. El rescate los registraba como gasto.
  { msg: 'Neto es 15800', esp: 'tipo_dudoso' },
  { msg: 'preste 118', esp: 'tipo_dudoso' },
  { msg: '35.00', esp: 'tipo_dudoso' },
  { msg: '592.91', esp: 'tipo_dudoso' },
  { msg: 'saqué una tarjeta de crédito con 500 disponibles', esp: 'no_es_movimiento' },
  { msg: 'tengo que pagar 380', esp: 'no_es_movimiento' },
  // Decidido el 30-sep: lo que alguien gana "al mes" no es un cobro fechado. Registrarlo como
  // ingreso de hoy lo duplica el día que anote el sueldo real, y el copy le dice cómo anotarlo.
  { msg: 'Ganó 2300 mensual', esp: 'no_es_movimiento' },
  // Filas que el rescate número-primero registró en producción (descripcion_original). Desde
  // este cambio las registra el parser; si saliera tipo_dudoso, dejarían de entrar.
  ...[
    ['7 guantes de cuero', 7], ['140 tubos de  metal', 140], ['500.00 junta de amigos', 500],
    ['3.00 colaboración', 3], ['27 tijera', 27], ['35 Serrucho', 35], ['5 compras laboratorio pollo', 5],
    ['25 traída de tronco', 25], ['101.00 salud', 101], ['1.40 pasajes', 1.4], ['22.07 Mass', 22.07],
    ['800 Rocotin payaso', 800], ['60.00 clases de canto', 60], ['60.00 postres', 60], ['14.3 almuerzo', 14.3],
    ['5 soles a movilidad', 5], ['4.50 tienda teodoro', 4.5], ['26.7 soles a frutas', 26.7], ['2.5 regalo', 2.5],
    ['1 sol bus transporte', 1], ['100.00  clases de filosofia', 100], ['2613 hipoteca', 2613], ['400 maestría', 400],
    ['53.7 a pollo crudo', 53.7], ['15.00 verduras', 15], ['8.10 aji', 8.1], ['7.5 en snack', 7.5],
     ['54.40 verduras y carnes', 54.4], 
    ['Gaste 20 en otros', 20], ['Gaste 208.33 dolares en seguro de vida', '208.33USD'],
  ].map(([msg, m]) => ({ msg, esp: `gasto ${m}` })),
  // Familias que la aceptación del 30-sep encontró mal leídas por el prompt, con miembros que
  // el prompt NO nombra como ejemplo: si sólo entrara el ejemplo, se habría tapado un caso.
  //  · número con ".00" + nombre de categoría salía tipo_dudoso 10/10 ("101.00 salud");
  //  · tiendas peruanas que parecen palabras comunes ("22.07 Mass" se leía "22.07 más").
  ...[
    ['101.00 salud', 101], ['101.00 educación', 101], ['50.00 vivienda', 50], ['30.00 compras', 30],
    ['12.00 alimentación', 12], ['8.40 Tambo', 8.4], ['5.60 Oxxo', 5.6], ['12 Metro', 12], ['Mass 30', 30],
  ].map(([msg, m]) => ({ msg, esp: `gasto ${m}` })),
  { msg: 'Quincena 1200', esp: 'ingreso 1200' },
  // Una propina puede ser dada o recibida: se reporta sin juzgar (salió de la lista de fuentes de
  // ingreso del prompt el 30-sep, cuando daba gasto 2/3 e ingreso 1/3).
  { msg: 'Propinas 25', esp: '*' },
  { msg: 'S/ 40.00', esp: 'tipo_dudoso' },
  // Revisión adversarial del 30-sep: "me cobraron" salía INGRESO (el prompt nombraba "cobré"
  // como ingreso y el modelo no separaba quién cobra). Ni el pool ni esta sonda tenían uno.
  { msg: 'me cobraron 25 soles de comisión en el banco', esp: 'gasto 25' },
  { msg: 'me cobraron 3.50 del pasaje', esp: 'gasto 3.5' },
  { msg: 'me cobraron 120 de luz', esp: 'gasto 120' },
  { msg: 'me descontaron 15 de la tarjeta', esp: 'gasto 15' },
  { msg: 'el taxista me cobró 12', esp: 'gasto 12' },
  { msg: 'cobré 300 por un trabajo', esp: 'ingreso 300' },
  // El ejemplo de `sin_monto` del prompt se "pegaba": con "Viaje" de ejemplo, "Viaje 100" salía
  // sin_monto 3/3; con "el colectivo", "El colectivo 2.5" también. Hoy la regla va sin ejemplos.
  { msg: 'El colectivo 2.5', esp: 'gasto 2.5' },
  { msg: 'Pagué la luz 90', esp: 'gasto 90' },
  // Un verbo de gasto sin cifra pide el número (sin_monto), no el copy de "no es un movimiento".
  { msg: 'pagué la luz', esp: 'sin_monto' },
  { msg: 'compré pan', esp: 'sin_monto' },
  // "20 euros" suelto: el modelo dice tipo_dudoso con moneda EUR; tiene que cortarse por moneda.
  { msg: '20 euros', esp: 'moneda_no_soportada' },
  // Segunda revisión adversarial del 30-sep: el prompt con "Papá 200 = gasto" daba vuelta
  // ingresos de Yape y de familiares, y "s/.25" se leía como 0.25.
  { msg: 'me yapearon 50', esp: 'ingreso 50' },
  { msg: '50 me yapearon', esp: 'ingreso 50' },
  { msg: 'me plinearon 30 por la rifa', esp: 'ingreso 30' },
  { msg: 'mi hermano me mandó 100', esp: 'ingreso 100' },
  { msg: '20.0 pasajede mi hermana', esp: 'gasto 20|tipo_dudoso' },
  { msg: 'Yape 50 de mi tía', esp: 'no_registra' },
  { msg: '200 de mi papá', esp: 'no_registra' },
  { msg: '35 me dieron', esp: 'ingreso 35' },
  { msg: 'Mi neto es 15800 soles', esp: 'no_registra' },
  { msg: 's/.25 menu', esp: 'gasto 25' },
  { msg: 'pan 3 leche 5', esp: '*' },
  { msg: '2 mil soles', esp: '*' },
  // Tercera revisión: formatos de monto que el invariante tiene que reconocer (si no, rebotan o,
  // en la versión que rescataba, se guardaban 1000 veces menores) y frases que no hablan de
  // plata aunque tengan "me dio" o "recibí".
  { msg: 'gasté 2mil en la moto', esp: 'gasto 2000' },
  { msg: 'me depositaron 15mil soles', esp: 'ingreso 15000' },
  { msg: 'pagué 50 céntimos de bolsa', esp: 'gasto 0.5' },
  { msg: 'pagué 1,250.80 de la tarjeta', esp: 'gasto 1250.8' },
  { msg: 'me dio flojera cocinar, delivery 35', esp: 'gasto 35' },
  { msg: 'recibí mi pedido de rappi 35', esp: 'gasto 35' },
  { msg: 'compré 2 polos a 35', esp: '*' },
  // Cambió de comportamiento y se reporta sin juzgar: antes eran ingreso.
  { msg: 'ahorré 200 este mes', esp: '*' },
  { msg: 'retiré 200 del cajero', esp: '*' },
  // Controles positivos de siempre.
  { msg: 'Gasté 1.5 en Movilidad', esp: 'gasto 1.5' },
  { msg: 'me pagaron 500', esp: 'ingreso 500' },
  { msg: 'Me depositaron el sueldo 2300', esp: 'ingreso 2300' },
  { msg: 'Cobré 150 por una asesoría', esp: 'ingreso 150' },
  { msg: '50 lucas en el mercado', esp: 'gasto 50' },
  { msg: 'Pata me presté 30 mangos taxi', esp: 'gasto 30' },
  // "Me preste" sin tilde roza el caso (3) de tipo_dudoso ("preste 118"): preguntar es aceptable.
  { msg: 'Me preste 50 soles', esp: 'gasto 50|tipo_dudoso' },
];

// Lo que los copys de rebote le enseñan a escribir. Tiene que entrar, siempre.
const COPY = [
  { msg: 'almuerzo 15', esp: 'gasto 15' },
  { msg: 'gasté 110.70 en carne', esp: 'gasto 110.7' },
  { msg: 'gasté 35 en almuerzo', esp: 'gasto 35' },
  { msg: 'me pagaron 35', esp: 'ingreso 35' },
  { msg: 'gasté 80 en un polo', esp: 'gasto 80' },
];

const pool = require(path.join(appRoot, 'tests/nlp/pool.js'))
  .filter((c) => c.intent === 'registrar_manual')
  .map((c) => ({ msg: c.msg, esp: null, cat: c.cat }));

const baterias = { reales: REALES, copy: COPY, pool };

async function enParalelo(items, fn) {
  const res = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: CONCURRENCIA }, async () => {
    while (i < items.length) { const k = i++; res[k] = await fn(items[k]); }
  }));
  return res;
}

// `esp` admite alternativas con "|": "gasto 20|tipo_dudoso" acepta el gasto o la pregunta. Una
// pregunta nunca es plata mal guardada; una regresión es registrar distinto o dejar de registrar.
function cumple(esp, efectos) {
  if (esp === '*') return true;
  if (esp.includes('|')) return efectos.every((e) => esp.split('|').some((alt) => cumple(alt, [e])));
  return efectos.every((e) => {
    const s = sinRescate(e);
    if (esp === 'no_registra') return !registra(s);
    if (esp === 'moneda_no_soportada') return s.startsWith('moneda_no_soportada');
    return s === esp;
  });
}

let fallos = 0;
const resumen = [];
for (const [nombre, casos] of Object.entries(baterias)) {
  if (SOLO && SOLO !== nombre) continue;
  if (nombre === 'pool' && !referencia) {
    console.log('\n[pool] se saltea: necesita --contra <ref> para tener esperado.');
    continue;
  }
  console.log(`\n══ ${nombre} (${casos.length} casos × ${N}${referencia ? ' × 2 versiones' : ''}) ══`);
  const filas = await enParalelo(casos, async (c) => {
    const act = await correr(actual, c.msg);
    const ref = referencia ? await correr(referencia, c.msg) : null;
    return { ...c, act, ref };
  });
  let regresiones = 0, incumplidos = 0, mejoras = 0;
  const dudosos = [];
  for (const f of filas) {
    const refEstable = f.ref && f.ref.every((e) => sinRescate(e) === sinRescate(f.ref[0])) ? sinRescate(f.ref[0]) : null;
    const esp = f.esp || (refEstable && registra(refEstable) ? refEstable : '*');
    const ok = cumple(esp, f.act);
    // Un caso con esperado EXPLÍCITO se juzga sólo contra él: "35.00" registraba un ingreso en
    // la referencia y dejar de hacerlo es el arreglo, no una regresión.
    const eraPositivo = !f.esp && refEstable && registra(refEstable);
    const regresion = eraPositivo && !f.act.every((e) => sinRescate(e) === refEstable);
    const mejora = f.ref && !f.ref.every((e) => registra(sinRescate(e))) && registra(sinRescate(f.act[0])) && ok;
    if (regresion) regresiones++;
    if (!ok && f.esp) incumplidos++;
    if (mejora) mejoras++;
    if (f.act.some((e) => e === 'tipo_dudoso')) dudosos.push(f);
    const marca = regresion ? 'REGRESION' : (!ok && f.esp ? 'FALLA' : (mejora ? 'mejora' : 'ok'));
    if (nombre !== 'pool' || marca !== 'ok') {
      console.log(`${marca.padEnd(10)} ${JSON.stringify(f.msg).slice(0, 58).padEnd(60)} esp=${esp.padEnd(20)} act=[${f.act.join(' | ')}]${f.ref ? `  ref=[${f.ref.join(' | ')}]` : ''}`);
    }
  }
  if (dudosos.length) {
    console.log(`\n  tipo_dudoso en ${nombre} — revisar uno por uno:`);
    for (const f of dudosos) console.log(`   · ${JSON.stringify(f.msg)}  act=[${f.act.join(' | ')}]${f.ref ? `  ref=[${f.ref.join(' | ')}]` : ''}`);
  }
  resumen.push(`${nombre}: ${casos.length} casos · regresiones ${regresiones} · esperados incumplidos ${incumplidos} · mejoras ${mejoras} · tipo_dudoso ${dudosos.length}`);
  fallos += regresiones + incumplidos;
}

console.log('\n' + resumen.join('\n'));
console.log(fallos ? `\nFALLA: ${fallos}` : '\nOK');
process.exit(fallos ? 1 : 0);
