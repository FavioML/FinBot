// Verifica el contrato de deshacer_ultimo → restaurar_eliminado contra la Supabase real.
//
// Por qué existe: deshacer_ultimo le promete al usuario 'escribe "restaura" y lo devuelvo'.
// Esa promesa solo es cierta si el snapshot en `transacciones_eliminadas` quedó guardado
// ANTES de borrar la fila de `transacciones`. Este harness lo prueba de punta a punta.
//
// ESCRIBE en la Supabase real, pero solo sobre una transacción sembrada por él mismo
// (comercio QA_DESHACER_PROBE) y limpia todo al final, pase o falle.
//
// Correr:  node qa-e2e/qa-deshacer-restaura.mjs   (desde app/)

import 'dotenv/config';
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const R = (m) => require(path.join(appRoot, m));

const { supabase } = R('lib/db.js');
const log = R('lib/logger.js');
const { hoyPeru, ayerPeru, ultimoDiaMes } = R('lib/dates.js');
const { CATEGORIAS_VALIDAS, CATEGORIA_MAP } = R('lib/constants.js');
const { validarMonto, normalizarCategoria } = R('lib/validators.js');
const { formatFecha } = R('lib/formatters.js');
const T = R('services/transactions.js');
const { getHandler } = R('handlers/intent-registry.js');

const QA_USER_ID = 'ded7e219-e5fd-4ff4-b5a3-3cd5cdffd172';
const MARCA = 'QA_DESHACER_PROBE';

const fallos = [];
function check(nombre, ok, detalle) {
  console.log((ok ? '  OK   ' : '  FALLA') + '  ' + nombre + (detalle ? '  → ' + detalle : ''));
  if (!ok) fallos.push(nombre + (detalle ? ': ' + detalle : ''));
}

async function limpiar() {
  await supabase.from('transacciones').delete().eq('usuario_id', QA_USER_ID).eq('comercio', MARCA);
  const { data: snaps } = await supabase.from('transacciones_eliminadas').select('id, snapshot')
    .eq('usuario_id', QA_USER_ID);
  for (const s of snaps || []) {
    if (s.snapshot && s.snapshot.comercio === MARCA) {
      await supabase.from('transacciones_eliminadas').delete().eq('id', s.id);
    }
  }
  await supabase.from('gmail_excluidos').delete().eq('usuario_id', QA_USER_ID).eq('descripcion_original', MARCA);
}

async function main() {
  const { data: usuario } = await supabase.from('usuarios').select('*').eq('id', QA_USER_ID).single();
  if (!usuario) { console.error('Usuario QA no encontrado'); process.exit(1); }

  const hoyParts = hoyPeru().split('-');
  const ctx = {
    supabase, log,
    hoyPeru, fechaHoyPeru: () => hoyPeru(), fechaAyerPeru: () => ayerPeru(), formatFecha, ultimoDiaMes,
    mesActual: parseInt(hoyParts[1], 10), anioActual: parseInt(hoyParts[0], 10),
    CATEGORIAS_VALIDAS, CATEGORIA_MAP, validarMonto, normalizarCategoria,
    ...T,
  };

  await limpiar();

  // 1. Sembrar la transacción de prueba (queda como la última por created_at).
  const { data: sembrada, error: errSem } = await supabase.from('transacciones').insert({
    usuario_id: QA_USER_ID,
    monto: 33.33, monto_pen: 33.33, moneda: 'PEN', tipo_cambio: 1,
    comercio: MARCA, categoria: 'Otros', tipo: 'gasto',
    fecha: hoyPeru(), descripcion_original: MARCA,
  }).select().single();
  if (errSem || !sembrada) { console.error('No pude sembrar la tx de prueba:', errSem); process.exit(1); }
  console.log('Sembrada tx ' + sembrada.id + ' (' + MARCA + ' S/33.33)\n');

  const handler = getHandler('deshacer_ultimo');
  if (!handler) { console.error('deshacer_ultimo sin handler registrado'); await limpiar(); process.exit(1); }

  // 2. deshacer_ultimo
  console.log('deshacer_ultimo');
  const rDeshacer = await handler({ intencion: 'deshacer_ultimo', msg: 'deshaz', datos: {}, usuario, from: usuario.whatsapp, ctx });
  console.log('  respuesta: ' + JSON.stringify(rDeshacer));

  const { data: txTrasDeshacer } = await supabase.from('transacciones').select('id').eq('id', sembrada.id);
  const borrada = !txTrasDeshacer || txTrasDeshacer.length === 0;

  const { data: snapshots } = await supabase.from('transacciones_eliminadas').select('*')
    .eq('usuario_id', QA_USER_ID).eq('tx_id', sembrada.id);
  const haySnapshot = !!(snapshots && snapshots.length > 0);

  check('snapshot guardado en transacciones_eliminadas', haySnapshot,
    haySnapshot ? 'id ' + snapshots[0].id : 'select devolvió vacío');
  check('snapshot conserva monto y comercio',
    haySnapshot && String(snapshots[0].snapshot?.comercio) === MARCA && Number(snapshots[0].snapshot?.monto) === 33.33,
    haySnapshot ? JSON.stringify({ comercio: snapshots[0].snapshot?.comercio, monto: snapshots[0].snapshot?.monto }) : 'sin snapshot');
  // Invariante central: nunca se borra sin snapshot. Si no hay snapshot, la tx debe seguir viva.
  check('no se borró la tx sin snapshot (snapshot-antes-de-delete)', haySnapshot || !borrada,
    borrada && !haySnapshot ? 'la tx se borró y NO hay snapshot: el gasto se perdió' : '');
  const prometeRestaurar = /restaur/i.test(String(rDeshacer || ''));
  check('la promesa de restaurar solo aparece si hay snapshot', !prometeRestaurar || haySnapshot,
    prometeRestaurar && !haySnapshot ? 'el mensaje ofrece restaurar pero no hay nada que restaurar' : '');

  // 3. restaurar_eliminado
  console.log('\nrestaurar_eliminado');
  const rRestaurar = await handler({ intencion: 'restaurar_eliminado', msg: 'restaura', datos: {}, usuario, from: usuario.whatsapp, ctx });
  console.log('  respuesta: ' + JSON.stringify(rRestaurar));

  const { data: txsRest } = await supabase.from('transacciones').select('*')
    .eq('usuario_id', QA_USER_ID).eq('comercio', MARCA);
  const restaurada = !!(txsRest && txsRest.length === 1);
  check('la transacción volvió a transacciones', restaurada,
    'filas con comercio ' + MARCA + ': ' + (txsRest ? txsRest.length : 0));
  check('el monto restaurado coincide', restaurada && Number(txsRest[0].monto) === 33.33,
    restaurada ? 'monto ' + txsRest[0].monto : 'no restaurada');

  await limpiar();
  console.log('\nLimpieza hecha (tx + snapshots ' + MARCA + ' borrados).');

  if (fallos.length) {
    console.log('\n' + fallos.length + ' FALLA(S):');
    fallos.forEach(f => console.log('  - ' + f));
    process.exit(1);
  }
  console.log('\nTodo OK: el snapshot se guarda antes del delete y restaurar devuelve el gasto.');
  process.exit(0);
}

main().catch(async (e) => {
  console.error(e);
  try { await limpiar(); } catch {}
  process.exit(1);
});
