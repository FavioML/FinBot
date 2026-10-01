#!/usr/bin/env node
// Las respuestas de WhatsApp que suman transacciones no se cortan en 1000 (backend).
//
// PostgREST corta cada respuesta en 1000 filas sin avisar. El 01-oct-2026 el backend tenía 41
// lecturas de `transacciones` sin cota que alimentaban sumas (resúmenes, presupuesto, score,
// suscripciones, "cuánto gasté"); se pasaron a `lib/todas-las-filas.js`. Este harness mide el
// FLUJO, no la pieza: mensaje firmado por el webhook real, en proceso (`webhook-harness.mjs`) →
// webhook.js → NLP → intent → Supabase real, y afirma sobre el TEXTO que recibiría el usuario.
//
//   · "¿cuánto gasté hoy?"       → listar_gastos_dia: "Gastos: *S/ X* (N movimientos)"
//   · "¿cuánto llevo este mes?"  → listar_gastos_mes (obtenerGastosMes): "Total: *S/ X* • N movimientos"
//
// N y X se comparan contra la base leída APARTE (paginada, con conteo exacto). Antes de las dos
// preguntas va historial adverso (producción le pasa al modelo los últimos 4 turnos) y se afirma que
// ningún intercept del webhook las registró como gasto: el conteo de filas no se mueve.
//
// **Por qué siembra.** Con menos de 1000 filas el código viejo y el nuevo dan lo mismo. Siembra
// SEMBRADAS gastos de S/1 con fecha de hoy (Lima) en el usuario QA (is_test_user, cero envíos a
// Meta), con `dedup_hash` `qa-pagb-NNNN`. **Lo que deja:** borrar la siembra copia cada fila a
// `borrados_auditoria` (trg_audit_borrado, append-only). Por eso `--conservar` deja la siembra para
// correr el CONTROL (código viejo, tiene que fallar) y la verificación con UNA sola limpieza.
//
// Uso (desde app/): node qa-e2e/qa-paginacion-backend.mjs [--conservar] [--limpiar]
// Exit 0 = pasa · 1 = REGRESIÓN · 2 = no se pudo medir. Fuera del canary: escribe en prod y usa OpenAI.

import 'dotenv/config';
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { hoyPeru } = require(path.join(appRoot, 'lib/dates.js'));

const QA_ID = 'ded7e219-e5fd-4ff4-b5a3-3cd5cdffd172';
const QA_WHATSAPP = 'qa-test-dashboard';
const PREFIJO = 'qa-pagb-';
const SEMBRADAS = 1100;
const CONSERVAR = process.argv.includes('--conservar');
const SOLO_LIMPIAR = process.argv.includes('--limpiar');

const SUPA = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_KEY;
if (!SUPA || !KEY) { console.error('NO SE PUDO MEDIR: faltan SUPABASE_URL / SUPABASE_KEY en app/.env'); process.exit(2); }

// REST directo con service role, FUERA del cliente que vigila qa-guard: la siembra y la verdad
// no pasan por el código que se está midiendo.
const rest = (ruta, init = {}) => fetch(`${SUPA}/rest/v1/${ruta}`, {
  ...init,
  headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
});

/** Todas las filas de un filtro, paginando con conteo exacto (la verdad contra la que se compara). */
async function verdad(filtro) {
  const filas = [];
  let total = null;
  for (let desde = 0; total === null || desde < total; desde += 1000) {
    const r = await rest(`transacciones?usuario_id=eq.${QA_ID}${filtro}&select=id,monto,monto_pen&order=id`, { headers: { Prefer: 'count=exact', Range: `${desde}-${desde + 999}` } });
    if (!r.ok) throw new Error(`verdad ${filtro}: HTTP ${r.status}`);
    total = Number((r.headers.get('content-range') || '').split('/')[1]);
    const lote = await r.json();
    filas.push(...lote);
    if (!lote.length) break;
  }
  const suma = filas.reduce((s, t) => s + parseFloat(t.monto_pen || t.monto || 0), 0);
  return { n: filas.length, total, suma: suma.toFixed(2) };
}

async function sembradasHoy() {
  const r = await rest(`transacciones?usuario_id=eq.${QA_ID}&dedup_hash=like.${PREFIJO}*&select=id`, { headers: { Prefer: 'count=exact', Range: '0-0' } });
  return Number((r.headers.get('content-range') || '').split('/')[1]);
}

async function limpiar() {
  const r = await rest(`transacciones?usuario_id=eq.${QA_ID}&dedup_hash=like.${PREFIJO}*`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
  if (!r.ok) throw new Error(`limpieza: HTTP ${r.status} ${await r.text()}`);
  const quedan = await sembradasHoy();
  if (quedan !== 0) throw new Error(`limpieza incompleta: quedan ${quedan}`);
  console.log('limpieza: 0 filas sembradas quedan');
}

if (SOLO_LIMPIAR) { await limpiar(); process.exit(0); }

const hoy = hoyPeru();
const yaHay = await sembradasHoy();
if (yaHay !== 0 && yaHay !== SEMBRADAS) { console.error(`NO SE PUDO MEDIR: hay ${yaHay} sembradas de otra corrida; corre --limpiar`); process.exit(2); }
if (yaHay === 0) {
  const filas = Array.from({ length: SEMBRADAS }, (_, i) => ({
    usuario_id: QA_ID, tipo: 'gasto', monto: 1, monto_pen: 1, moneda: 'PEN', fecha: hoy,
    categoria: 'Alimentación', comercio: 'QA paginación', dedup_hash: PREFIJO + String(i).padStart(4, '0'),
  }));
  for (let i = 0; i < filas.length; i += 500) {
    const r = await rest('transacciones', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(filas.slice(i, i + 500)) });
    if (!r.ok) { console.error(`NO SE PUDO MEDIR: siembra HTTP ${r.status} ${await r.text()}`); await limpiar().catch(() => {}); process.exit(2); }
  }
  console.log(`siembra: ${SEMBRADAS} gastos de S/1 con fecha ${hoy}`);
} else {
  console.log(`siembra: reutilizo las ${yaHay} de la corrida anterior (--conservar)`);
}

const resultados = [];
const check = (nombre, ok, detalle) => { resultados.push(ok); console.log((ok ? 'PASS ' : 'FAIL ') + nombre + (detalle ? '  — ' + detalle : '')); };

let exit = 0;
const { startWebhookHarness } = await import('./webhook-harness.mjs');
const h = await startWebhookHarness();
try {
  const mes = hoy.slice(0, 8) + '01';
  const dia = await verdad(`&tipo=eq.gasto&fecha=eq.${hoy}`);
  const delMes = await verdad(`&tipo=eq.gasto&fecha=gte.${mes}`);
  const antes = await verdad('');
  if (dia.n <= 1000 || delMes.n <= 1000) throw new Error(`la siembra no pasa de 1000 (día ${dia.n}, mes ${delMes.n}): el harness no distinguiría nada`);
  console.log(`verdad: hoy ${dia.n} gastos S/ ${dia.suma} · mes ${delMes.n} gastos S/ ${delMes.suma}`);

  const preguntar = async (texto) => {
    const desde = h.sent.length;
    const st = await h.postText(texto, QA_WHATSAPP);
    if (st !== 200) throw new Error(`webhook devolvió ${st} para "${texto}"`);
    return h.waitForReply(desde, 90000);
  };

  // Historial adverso: dos turnos de otros temas, uno con montos y un mes distinto, para que el
  // modelo tenga con qué confundirse en las dos preguntas que importan.
  await preguntar('hola, ¿qué puedes hacer?');
  await preguntar('¿cuánto gasté en taxi en marzo?');

  const rDia = await preguntar('¿cuánto gasté hoy?');
  console.log('respuesta (hoy):\n  ' + rDia.split('\n').slice(0, 3).join('\n  '));
  const mDia = rDia.match(/Gastos: \*S\/ ([\d.]+)\* \((\d+) movimientos?\)/);
  check('"¿cuánto gasté hoy?" contesta con el desglose del día (no lo secuestró otro intent)', !!mDia, mDia ? '' : rDia.slice(0, 160));
  if (mDia) {
    check('el día cuenta TODOS los gastos', Number(mDia[2]) === dia.n, `respuesta ${mDia[2]} · base ${dia.n}`);
    check('el día suma TODOS los gastos', mDia[1] === dia.suma, `respuesta S/ ${mDia[1]} · base S/ ${dia.suma}`);
  }

  const rMes = await preguntar('¿cuánto llevo gastado este mes?');
  console.log('respuesta (mes):\n  ' + rMes.split('\n').slice(0, 3).join('\n  '));
  const mMes = rMes.match(/Total: \*S\/ ([\d.]+)\*(?: \(incl\. USD [\d.]+\))? • (\d+) movimientos/);
  check('"¿cuánto llevo gastado este mes?" contesta con el resumen del mes', !!mMes, mMes ? '' : rMes.slice(0, 160));
  if (mMes) {
    check('el mes cuenta TODOS los gastos', Number(mMes[2]) === delMes.n, `respuesta ${mMes[2]} · base ${delMes.n}`);
    check('el mes suma TODOS los gastos', mMes[1] === delMes.suma, `respuesta S/ ${mMes[1]} · base S/ ${delMes.suma}`);
  }

  const despues = await verdad('');
  check('ninguna de las cuatro preguntas quedó registrada como gasto', despues.n === antes.n, `filas antes ${antes.n} · después ${despues.n}`);
  exit = resultados.every(Boolean) ? 0 : 1;
} catch (e) {
  console.error('NO SE PUDO MEDIR: ' + e.message);
  exit = 2;
} finally {
  await h.close();
  if (!CONSERVAR) {
    try { await limpiar(); } catch (e) { console.error('LIMPIEZA FALLÓ: ' + e.message); exit = exit || 1; }
  } else {
    console.log(`--conservar: quedan ${SEMBRADAS} sembradas (${PREFIJO}*). Limpiar con --limpiar.`);
  }
}
console.log(exit === 0 ? '\nOK: las respuestas suman todas las filas' : exit === 1 ? '\nREGRESIÓN' : '\nNO SE PUDO MEDIR');
process.exit(exit);
