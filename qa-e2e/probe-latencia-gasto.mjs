// MIDE la latencia de registrar un gasto por WhatsApp, punta a punta, con el pipeline REAL:
// webhook firmado → limiter → webhook.js → procesarMensajeLibre → OpenAI (clasificación) →
// intent `registrar_manual` → parser + clasificador de categoría → `guardarTransaccion`.
//
// POR QUÉ EXISTE. La Ola 3 de la auditoría del 10-ago-2026 (P′2/P′3/P′4) es puro trabajo de
// latencia, y la única evidencia disponible eran los percentiles sobre la tabla `conversaciones`
// en prod. Ese número tarda DÍAS en moverse: son ~3 gastos por día de usuarios reales, así que
// después de un deploy la ventana sigue dominada por las mediciones viejas. Este probe produce
// la muestra a voluntad, contra la misma Supabase y el mismo OpenAI, para poder comparar dos
// versiones del código EL MISMO DÍA.
//
// LO QUE MIDE Y LO QUE NO. Corre el código del WORKING TREE en proceso, igual que
// `qa-e2e-registro-gasto.mjs`. O sea que compara CÓDIGO, no deploys: para eso está
// `backend-deploy-fresh`. Y el reloj incluye la red hacia OpenAI y Supabase desde esta máquina,
// que no es la de Railway — los valores absolutos NO son comparables contra los percentiles de
// `conversaciones`. Lo comparable es una corrida contra otra, en la misma máquina y el mismo
// rato: por eso el veredicto es un DELTA, nunca un umbral fijo.
//
// NO tiene veredicto binario y por eso no va al canary: mide, imprime y sale 0. Escribe N
// transacciones del usuario QA y las borra al final (también si se cae en el medio).
//
// Cuesta ~3 llamadas a gpt-4o-mini por iteración.
//
// Correr:  node qa-e2e/probe-latencia-gasto.mjs            (desde app/, N=8)
//          NETO_LAT_N=12 node qa-e2e/probe-latencia-gasto.mjs
//
// Comparar dos versiones:
//   node qa-e2e/probe-latencia-gasto.mjs        # código nuevo
//   git stash && node qa-e2e/probe-latencia-gasto.mjs && git stash pop

import { startWebhookHarness } from './webhook-harness.mjs';

const QA_ID = 'ded7e219-e5fd-4ff4-b5a3-3cd5cdffd172';
const QA_WHATSAPP = 'qa-test-dashboard';
const N = parseInt(process.env.NETO_LAT_N || '8', 10);

const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};

async function run(h) {
  const { data: user } = await h.supabase.from('usuarios')
    .select('id, whatsapp, is_test_user').eq('id', QA_ID).single();
  if (!user || user.is_test_user !== true || user.whatsapp !== QA_WHATSAPP) {
    throw new Error('el usuario QA no está como se espera — abortando para no escribirle a un real');
  }
  // Cuántas categorías propias tiene decide cuánto rinde el fix del N+1: con 0 raíces,
  // `obtenerCategoriasUsuario` cortaba en una query igual y no hay nada que medir.
  const { data: cats } = await h.supabase.from('categorias_usuario')
    .select('id, padre_id').eq('usuario_id', QA_ID).eq('activa', true);
  const raices = (cats || []).filter((c) => !c.padre_id).length;
  console.log(`usuario QA: ${raices} categorías raíz, ${(cats || []).length} filas activas`);
  if (raices === 0) console.log('  ⚠ sin categorías propias: el efecto de P′3 NO se verá en esta corrida');

  const muestras = [];
  const creadas = [];
  for (let i = 0; i < N; i++) {
    // Monto único por iteración: dedup_hash fresco (si no, la segunda se descarta como
    // duplicada y mediríamos otra cosa) y ancla para borrar exactamente lo que creamos.
    const monto = 50 + (10 + Math.floor(Math.random() * 89)) / 100 + i;
    const msg = `gasté ${monto.toFixed(2)} soles en taxi`;
    const before = h.sent.length;
    const t0 = Date.now();
    const status = await h.postText(msg, QA_WHATSAPP);
    if (status !== 200) throw new Error('webhook devolvió ' + status);
    const reply = await h.waitForReply(before);
    const ms = Date.now() - t0;
    const ok = /^✅/.test(reply.trim());
    muestras.push(ms);
    creadas.push(monto);
    console.log(`  ${String(i + 1).padStart(2)}/${N}  ${(ms / 1000).toFixed(2)}s  ${ok ? 'ok' : 'RESPUESTA INESPERADA: ' + reply.slice(0, 60)}`);
  }

  const { data: filas } = await h.supabase.from('transacciones')
    .select('id').eq('usuario_id', QA_ID).in('monto', creadas).eq('tipo', 'gasto');
  if (filas && filas.length) {
    await h.supabase.from('transacciones').delete().in('id', filas.map((r) => r.id));
  }
  console.log(`\nlimpieza: ${filas ? filas.length : 0} filas borradas (esperaba ${N})`);

  console.log('\n─── latencia de registrar un gasto ───');
  console.log(`n=${muestras.length}  p50=${(pct(muestras, 0.5) / 1000).toFixed(2)}s  ` +
    `p90=${(pct(muestras, 0.9) / 1000).toFixed(2)}s  ` +
    `min=${(Math.min(...muestras) / 1000).toFixed(2)}s  max=${(Math.max(...muestras) / 1000).toFixed(2)}s`);
  console.log('muestras(s): ' + muestras.map((m) => (m / 1000).toFixed(2)).join(' '));
  console.log('\n(valores absolutos NO comparables contra los percentiles de `conversaciones`:');
  console.log(' esta máquina no es Railway. Comparar SOLO contra otra corrida de este probe.)');
}

const h = await startWebhookHarness();
try {
  await run(h);
} finally {
  await h.close();
}
