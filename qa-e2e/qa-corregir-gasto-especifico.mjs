// E2E: corregir y borrar EL gasto que la persona describe, aunque no esté entre los más recientes
// (02-oct-2026, `docs/DEFECTOS.md`).
//
// Qué ejercita, con OpenAI real y la Supabase real, sobre 22 Cabify sembrados en el usuario QA:
//   1. por el webhook REAL (firmado): "gasté 15.55 en cabify", el alta que deja historial adverso;
//   2. el intent `corregir_multiple` con "el cabify de 8.37 era salud y el cabify de 99.91 era
//      educación": el parser REAL extrae monto y fecha, el de 8.37 es el más viejo de 23 Cabify
//      (fuera de los 10 que leía el código anterior) y el de 99.91 no existe. Tiene que corregir
//      ESE, decir que no encontró el otro, y no armar la regla cabify → Salud;
//   3. por el webhook REAL: "borra el cabify de 8.37" → `eliminar_transaccion`: el mismo gasto está
//      fuera de los 20 más recientes que leía `qElim`. Tiene que borrar ESE;
//   4. el intent con una corrección sin monto y otra con céntimos: cada una mueve UNA fila (la
//      primera, el Cabify más reciente; la segunda, EL de 15.17 aunque haya 15.01 a 15.21 más
//      recientes), y no se guarda ninguna regla (eso es `set_category_rule`).
//
// **Por qué los pasos 2 y 4 entran por el intent y no por el webhook.** Medido el 02-oct-2026: el
// clasificador manda esas frases (y otras tres formas de "varias correcciones") a
// `corregir_categoria`, no a `corregir_multiple`, y en producción hay 0 respuestas de
// `corregir_multiple` desde marzo. Ese ruteo es un defecto aparte (backlog, ítem 45). Este harness
// prueba lo que hace la rama cuando se la alcanza; el día que el ruteo cambie, los pasos 2 y 4
// tienen que pasar a `enviar()`.
//
// Veredicto sobre la respuesta Y sobre la tabla: las filas sembradas quedan como dice el mensaje, y
// las filas que el usuario QA ya tenía no cambian de categoría.
//
// Escribe en el usuario QA (is_test_user) y limpia lo que crea: las transacciones de Cabify, la
// copia del borrado, las reglas de cabify y los turnos de conversación de la corrida. Cuesta unas
// 4-6 llamadas a OpenAI. Manual, no canariable.
//
// Correr:  node qa-e2e/qa-corregir-gasto-especifico.mjs   (desde app/)  → exit 0 si pasa.

import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';
import { startWebhookHarness } from './webhook-harness.mjs';

const require = createRequire(import.meta.url);
const R = (m) => path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), m);

const QA_ID = 'ded7e219-e5fd-4ff4-b5a3-3cd5cdffd172';
const QA_WHATSAPP = 'qa-test-dashboard';
const MARCA = 'qa-cge-' + Date.now();

const results = [];
const check = (name, cond, detail) => {
  results.push({ name, pass: !!cond, detail });
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail ? '  — ' + detail : ''));
  return !!cond;
};

const dia = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

/** 21 Cabify de S/ 15.xx, uno por día, y el de S/ 8.37 más viejo que todos (fecha y created_at). */
function siembra() {
  const filas = [];
  for (let i = 1; i <= 21; i++) {
    const monto = 15 + i / 100;
    filas.push({ usuario_id: QA_ID, comercio: 'Cabify', categoria: 'Transporte', tipo: 'gasto', moneda: 'PEN',
      monto, monto_pen: monto, fecha: dia(i), created_at: dia(i) + 'T12:00:00', dedup_hash: MARCA + '-' + i });
  }
  filas.push({ usuario_id: QA_ID, comercio: 'Cabify', categoria: 'Transporte', tipo: 'gasto', moneda: 'PEN',
    monto: 8.37, monto_pen: 8.37, fecha: dia(30), created_at: dia(30) + 'T12:00:00', dedup_hash: MARCA + '-objetivo' });
  return filas;
}

async function cabifys(h) {
  const { data, error } = await h.supabase.from('transacciones').select('id, monto, categoria, dedup_hash, fecha')
    .eq('usuario_id', QA_ID).ilike('comercio', '%cabify%').order('fecha', { ascending: false }).limit(100);
  if (error) throw new Error('leer cabify: ' + error.message);
  return data || [];
}

async function categoriasPrevias(h) {
  const { data, error } = await h.supabase.from('transacciones').select('id, categoria')
    .eq('usuario_id', QA_ID).not('comercio', 'ilike', '%cabify%').order('id').limit(500);
  if (error) throw new Error('leer previas: ' + error.message);
  return Object.fromEntries((data || []).map((r) => [r.id, r.categoria]));
}

async function limpiar(h, inicio) {
  const restos = await cabifys(h);
  if (restos.length) {
    const ids = restos.map((r) => r.id);
    const { error } = await h.supabase.from('transacciones').delete().in('id', ids);
    if (error) console.log('limpieza transacciones: ' + error.message);
  }
  const { data: copias } = await h.supabase.from('transacciones_eliminadas').select('id, snapshot')
    .eq('usuario_id', QA_ID).gte('deleted_at', inicio).limit(50);
  const copiasCabify = (copias || []).filter((c) => /cabify/i.test((c.snapshot && c.snapshot.comercio) || ''));
  if (copiasCabify.length) await h.supabase.from('transacciones_eliminadas').delete().in('id', copiasCabify.map((c) => c.id));
  const { data: reglas } = await h.supabase.from('reglas_comercio').select('id').eq('usuario_id', QA_ID).ilike('comercio_pattern', '%cabify%');
  if (reglas && reglas.length) await h.supabase.from('reglas_comercio').delete().in('id', reglas.map((r) => r.id));
  const { data: turnos } = await h.supabase.from('conversaciones').select('id').eq('usuario_id', QA_ID).gte('created_at', inicio).limit(50);
  if (turnos && turnos.length) await h.supabase.from('conversaciones').delete().in('id', turnos.map((t) => t.id));
  // El árbol de categorías también se escribe: el alta crea su subcategoría y una corrección asegura
  // la raíz de la categoría nueva. Se borra lo que nació en la corrida, las hijas antes que las raíces.
  const { data: cats } = await h.supabase.from('categorias_usuario').select('id, padre_id').eq('usuario_id', QA_ID).gte('created_at', inicio).limit(50);
  for (const grupo of [(cats || []).filter((c) => c.padre_id), (cats || []).filter((c) => !c.padre_id)]) {
    if (grupo.length) await h.supabase.from('categorias_usuario').delete().in('id', grupo.map((c) => c.id));
  }
  return { transacciones: restos.length, copias: copiasCabify.length, reglas: (reglas || []).length, turnos: (turnos || []).length, categorias: (cats || []).length };
}

async function enviar(h, texto) {
  const antes = h.sent.length;
  const status = await h.postText(texto, QA_WHATSAPP);
  const reply = (await h.waitForReply(antes, 90000)).trim();
  console.log('\n> ' + texto + '\n< ' + reply.replace(/\n/g, '\n< ') + '\n');
  return { status, reply };
}

/**
 * El intent `corregir_multiple` con las MISMAS piezas que le arma `message-processor` (parser con
 * OpenAI real, servicio, regla, retroaplicación y árbol de categorías reales). Lo único que no pasa
 * es el clasificador: ver el docblock.
 */
async function corregirMultiple(h, texto) {
  const tx = require(R('services/transactions.js'));
  const { parsearCorreccionesMultiples } = require(R('services/parsers.js'));
  const { asegurarCategoriaUsuario, crearSubcategoriaLibreUsuario } = require(R('services/categories.js'));
  const handler = require(R('handlers/intents/transacciones.js'));
  const ctx = {
    supabase: h.supabase, historialConv: [], parsearCorreccionesMultiples, asegurarCategoriaUsuario, crearSubcategoriaLibreUsuario,
    corregirTransaccionEspecifica: tx.corregirTransaccionEspecifica, guardarReglaComercio: tx.guardarReglaComercio, retroaplicarRegla: tx.retroaplicarRegla,
  };
  const reply = String(await handler.handle({ intencion: 'corregir_multiple', msg: texto, datos: {}, usuario: { id: QA_ID, plan: 'premium' }, from: QA_WHATSAPP, ctx })).trim();
  console.log('\n> [intent corregir_multiple] ' + texto + '\n< ' + reply.replace(/\n/g, '\n< ') + '\n');
  return { reply };
}

async function run(h, inicio) {
  const { data: user } = await h.supabase.from('usuarios').select('id, whatsapp, is_test_user').eq('id', QA_ID).single();
  if (!check('usuario QA existe y es de prueba', user?.is_test_user === true && user?.whatsapp === QA_WHATSAPP)) return;

  // Precondición: sin Cabify de corridas anteriores (si quedó algo de una abortada, se limpia).
  if ((await cabifys(h)).length) await limpiar(h, '1970-01-01T00:00:00');
  if (!check('precondición: el usuario QA no tiene gastos de Cabify', (await cabifys(h)).length === 0)) return;

  const previas = await categoriasPrevias(h);
  const { data: sembradas, error: errSiembra } = await h.supabase.from('transacciones').insert(siembra()).select('id, dedup_hash');
  if (!check('siembra de 22 Cabify', !errSiembra && sembradas?.length === 22, errSiembra?.message)) return;
  const objetivo = sembradas.find((f) => f.dedup_hash === MARCA + '-objetivo').id;

  // ── 1. historial adverso: un alta del mismo comercio justo antes ──
  const alta = await enviar(h, 'gasté 15.55 en cabify');
  check('el alta previa se registró (historial adverso armado)', /15\.55/.test(alta.reply), alta.reply.slice(0, 80));

  // ── 2. corrección múltiple ──
  const corr = await corregirMultiple(h, 'el cabify de 8.37 era salud y el cabify de 99.91 era educación');
  check('corrige EL de 8.37 (el parser real extrajo el monto) y la línea dice de qué día es',
    new RegExp('✅ \\*Cabify\\* \\(S\\/ 8\\.37 · ' + dia(30) + '\\) → Salud').test(corr.reply), corr.reply.slice(0, 120));
  check('el que no existe sale "no encontré" con lo que se buscó (y "otro": la búsqueda excluyó el ya movido)',
    /❌ No encontré otro gasto de \*cabify\* \(99\.91\) aparte de los que ya moví/i.test(corr.reply));
  check('la cabecera cuenta 1 de 2 correcciones, no "Listo"', /^Apliqué 1 de 2 correcciones:/.test(corr.reply));

  const tras = await cabifys(h);
  const enSalud = tras.filter((f) => f.categoria === 'Salud').map((f) => f.id);
  check('en la tabla, el ÚNICO Cabify en Salud es el de 8.37', enSalud.length === 1 && enSalud[0] === objetivo,
    enSalud.length + ' en Salud');
  const { data: reglas } = await h.supabase.from('reglas_comercio').select('id').eq('usuario_id', QA_ID).ilike('comercio_pattern', '%cabify%');
  check('no se armó la regla cabify → Salud', (reglas || []).length === 0, (reglas || []).length + ' reglas');

  // ── 3. borrado del mismo gasto, más viejo que los 20 más recientes ──
  const borra = await enviar(h, 'borra el cabify de 8.37');
  check('el borrado nombra ESE gasto', /Eliminé \*Cabify\* \(S\/ 8\.37\)/.test(borra.reply), borra.reply.slice(0, 120));
  const quedan = await cabifys(h);
  check('en la tabla, se fue el de 8.37 y nada más', !quedan.some((f) => f.id === objetivo) && quedan.length === tras.length - 1,
    quedan.length + ' Cabify quedan, había ' + tras.length);

  // ── 4. sin monto + con céntimos en el mismo mensaje: cada una es UN gasto, sin regla ──
  // "los de cabify son entretenimiento" ya no retroaplica (eso es `set_category_rule`): mueve el
  // más reciente. "15.17" trae céntimos, así que gana el exacto aunque haya 15.01 a 15.21 más cerca.
  const objetivo2 = sembradas.find((f) => f.dedup_hash === MARCA + '-17').id; // el de 15.17 (no se puede leer como DD.MM: el parser leyó "15.03" como 15-mar una vez)
  const mix = await corregirMultiple(h, 'los de cabify son entretenimiento y el cabify de 15.17 era salud');
  const hoy = require(R('lib/dates.js')).hoyPeru(); // el alta del paso 1 queda con la fecha de Lima
  check('dos líneas, una fila cada una: el más reciente a Entretenimiento y EL de 15.17 a Salud',
    new RegExp('^Listo! Apliqué 2 correcciones:\\n\\n✅ \\*Cabify\\* \\(S\\/ 15\\.55 · ' + hoy + '\\) → Entretenimiento\\n✅ \\*Cabify\\* \\(S\\/ 15\\.17 · ' + dia(17) + '\\) → Salud\\n\\n_Moví solo el más reciente de ese comercio\\. Para que todos vayan ahí, escríbeme "todo lo de \\[comercio\\] va en \\[categoría\\]"\\._$').test(mix.reply),
    mix.reply.slice(0, 160));
  const fin = await cabifys(h);
  const salud = fin.filter((f) => f.categoria === 'Salud').map((f) => f.id);
  const entret = fin.filter((f) => f.categoria === 'Entretenimiento');
  check('en la tabla: el de 15.17 en Salud, UNO en Entretenimiento (el de 15.55) y el resto como estaba',
    salud.length === 1 && salud[0] === objetivo2 && entret.length === 1 && Number(entret[0].monto) === 15.55,
    salud.length + ' en Salud, ' + entret.length + ' en Entretenimiento');
  const { data: reglas2 } = await h.supabase.from('reglas_comercio').select('categoria').eq('usuario_id', QA_ID).ilike('comercio_pattern', '%cabify%');
  check('no se guardó ninguna regla de cabify', (reglas2 || []).length === 0, JSON.stringify(reglas2));

  // ── Lo que el usuario ya tenía no se tocó ──
  const despues = await categoriasPrevias(h);
  const cambiadas = Object.keys(previas).filter((id) => despues[id] !== previas[id]);
  check('las ' + Object.keys(previas).length + ' transacciones previas del usuario QA no cambiaron de categoría', cambiadas.length === 0,
    cambiadas.length + ' cambiadas');
}

const inicio = new Date(Date.now() - 5000).toISOString().replace('Z', '');
const h = await startWebhookHarness();
let fatal = null;
try { await run(h, inicio); } catch (e) { fatal = e; console.log('FAIL excepción — ' + e.message); }
try {
  const l = await limpiar(h, inicio);
  check('limpieza', (await cabifys(h)).length === 0, JSON.stringify(l));
} catch (e) { console.log('FAIL limpieza — ' + e.message); fatal = fatal || e; }
await h.close();

const fallidos = results.filter((r) => !r.pass);
console.log('\n=== ' + (results.length - fallidos.length) + '/' + results.length + ' checks OK ===');
if (fatal) console.log(fatal.stack);
process.exit(fallidos.length === 0 && !fatal ? 0 : 1);
