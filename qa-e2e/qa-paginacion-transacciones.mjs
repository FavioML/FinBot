// Las lecturas de transacciones que la webapp le ENTREGA al usuario no se cortan en 1000.
//
// PostgREST corta cada respuesta en 1000 filas sin avisar. El 01-oct-2026 un usuario real tenía
// 1105 transacciones, y `/api/export` le devolvía un archivo con las 1000 más recientes y
// `totalTransacciones: 1000`. El arreglo (`webapp/src/lib/supabase/todas-las-filas.ts`) se mide
// acá contra PRODUCCIÓN, con el usuario QA, en las dos rutas que entregan un número o un archivo:
//
//   · `/api/export`  → el archivo trae TODAS las filas, sin repetidas, y `totalTransacciones`
//                      coincide con el conteo exacto de la base.
//   · `/api/pro/muro` → `totalMes` es la suma de TODOS los gastos del mes, no de 1000.
//
// **Por qué hace falta sembrar.** El usuario QA tiene decenas de transacciones, y con menos de
// 1000 el código viejo y el nuevo dan lo mismo: el harness pasaría en verde contra el bug. Por
// eso siembra SEMBRADAS gastos de S/1 con fecha de hoy (Lima), con `dedup_hash` `qa-pag-NNNN`
// (la convención `qa%` de limpieza del usuario QA): el mes pasa de 1000 gastos y el total, de
// 1000 filas. El universo contra el que se compara se LEE de la base, no se asume.
//
// **Lo que deja, y por qué no se corre seguido.** `transacciones` tiene `trg_audit_borrado`
// (migración 055): borrar la siembra copia cada fila a `borrados_auditoria`, que es append-only.
// Cada ciclo siembra→limpia deja ~SEMBRADAS filas ahí, todas del usuario QA y reconocibles por el
// `dedup_hash`. Por eso `--conservar` deja la siembra puesta para correr el control contra el
// deploy viejo y la verificación contra el nuevo con UNA sola limpieza. Fuera del canary.
//
// Uso: node qa-paginacion-transacciones.mjs [--conservar] [--limpiar]
// Exit 0 = pasa · 1 = REGRESIÓN · 2 = no se pudo medir (credenciales, red, siembra)

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const APP = process.env.NETO_APP_URL || 'https://app.neto.pe';
const QA_USUARIO_ID = 'ded7e219-e5fd-4ff4-b5a3-3cd5cdffd172';
const PREFIJO = 'qa-pag-';
const SEMBRADAS = 1100;
const CONSERVAR = process.argv.includes('--conservar');
const SOLO_LIMPIAR = process.argv.includes('--limpiar');

function loadEnv(path) {
  const env = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2];
  }
  return env;
}

class NoSePudoMedir extends Error {}

// Antes de sembrar sale directo; después, tira, para que el `finally` decida si limpia.
let sembrando = false;
function abortar(motivo) {
  if (sembrando) throw new NoSePudoMedir(motivo);
  console.error(`NO SE PUDO MEDIR: ${motivo}`);
  process.exit(2);
}

const env = loadEnv(join(homedir(), '.config', 'neto', 'qa.env'));
const SUPA = env.NETO_QA_URL;
const ANON = env.NETO_QA_ANON;
if (!SUPA || !ANON || !env.NETO_QA_EMAIL || !env.NETO_QA_PASSWORD) abortar('faltan credenciales en ~/.config/neto/qa.env');

const SERVICE =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  loadEnv(new URL('../webapp/.env.local', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')).SUPABASE_SERVICE_ROLE_KEY;
if (!SERVICE) abortar('falta SUPABASE_SERVICE_ROLE_KEY (entorno o webapp/.env.local)');

const rest = (ruta, init = {}) =>
  fetch(`${SUPA}/rest/v1/${ruta}`, {
    ...init,
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
  });

const conteo = async (filtro) => {
  const r = await rest(`transacciones?usuario_id=eq.${QA_USUARIO_ID}${filtro}&select=id`, { headers: { Prefer: 'count=exact', Range: '0-0' } });
  const n = Number((r.headers.get('content-range') || '').split('/')[1]);
  if (!r.ok || !Number.isFinite(n)) abortar(`no se pudo contar (${filtro || 'todo'}): HTTP ${r.status}`);
  return n;
};

async function limpiar() {
  // Fijado al usuario QA Y al prefijo: no puede tocar una fila de nadie más ni una suya real.
  // `like` con `*`: PostgREST lo traduce a `%` en el servidor.
  const r = await rest(`transacciones?usuario_id=eq.${QA_USUARIO_ID}&dedup_hash=like.${PREFIJO}*`, { method: 'DELETE' });
  if (!r.ok) console.error(`AVISO: la limpieza devolvió ${r.status}. Borrar a mano las filas dedup_hash like '${PREFIJO}%' del usuario QA.`);
  else console.log('limpieza hecha');
}

if (SOLO_LIMPIAR) { await limpiar(); process.exit(0); }

const hoyLima = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Lima' });
const inicioMes = hoyLima.slice(0, 8) + '01';
let limpiarAlFinal = !CONSERVAR;

sembrando = true;
try {
  // ── Siembra (idempotente: si quedó de una corrida con --conservar, no se repite) ──
  const yaSembradas = await conteo(`&dedup_hash=like.${PREFIJO}*`);
  if (yaSembradas === 0) {
    const filas = Array.from({ length: SEMBRADAS }, (_, i) => ({
      usuario_id: QA_USUARIO_ID,
      tipo: 'gasto',
      monto: 1,
      monto_pen: 1,
      moneda: 'PEN',
      comercio: 'QA paginacion',
      categoria: 'Otros',
      fecha: hoyLima,
      descripcion_original: 'Sembrada por qa-paginacion-transacciones.mjs',
      dedup_hash: `${PREFIJO}${String(i).padStart(4, '0')}`,
    }));
    const ins = await rest('transacciones', { method: 'POST', body: JSON.stringify(filas), headers: { Prefer: 'return=minimal' } });
    if (!ins.ok) abortar(`la siembra falló: HTTP ${ins.status} ${await ins.text()}`);
    console.log(`sembradas ${SEMBRADAS} filas (${hoyLima})`);
  } else if (yaSembradas !== SEMBRADAS) {
    abortar(`hay ${yaSembradas} filas sembradas de una corrida anterior, no ${SEMBRADAS}: correr con --limpiar`);
  } else {
    console.log(`la siembra ya estaba (${yaSembradas} filas)`);
  }

  // ── El universo REAL, de la base ─────────────────────────────────────────────
  const totalReal = await conteo('');
  const gastosMes = await (async () => {
    // La suma se pide paginada a mano: es justamente lo que no se puede leer de una vez.
    let suma = 0;
    let filas = 0;
    for (let desde = 0; ; desde += 1000) {
      const r = await rest(
        `transacciones?usuario_id=eq.${QA_USUARIO_ID}&tipo=eq.gasto&fecha=gte.${inicioMes}&fecha=lte.${hoyLima}&select=id,monto,monto_pen&order=id`,
        { headers: { Range: `${desde}-${desde + 999}` } },
      );
      if (!r.ok) abortar(`no se pudo sumar el mes: HTTP ${r.status}`);
      const lote = await r.json();
      for (const t of lote) suma += Number(t.monto_pen != null ? t.monto_pen : (t.monto ?? 0));
      filas += lote.length;
      if (lote.length === 0) break;
    }
    return { suma, filas };
  })();
  if (totalReal <= 1000) abortar(`el universo quedó en ${totalReal}: con <=1000 el bug y el arreglo dan lo mismo`);
  if (gastosMes.filas <= 1000) abortar(`el mes quedó con ${gastosMes.filas} gastos: con <=1000 el muro no distingue`);
  console.log(`universo: ${totalReal} transacciones, ${gastosMes.filas} gastos del mes que suman ${gastosMes.suma.toFixed(2)}`);

  // ── Sesión: password grant + cookie @supabase/ssr (la API no acepta Bearer) ───
  const grant = await fetch(`${SUPA}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: env.NETO_QA_EMAIL, password: env.NETO_QA_PASSWORD }),
  });
  if (!grant.ok) abortar(`password grant: HTTP ${grant.status}`);
  const session = await grant.json();
  const ref = new URL(SUPA).hostname.split('.')[0];
  const valor = 'base64-' + Buffer.from(JSON.stringify(session), 'utf8').toString('base64url');
  const MAX = 3180;
  const cookie = valor.length <= MAX
    ? `sb-${ref}-auth-token=${valor}`
    : Array.from({ length: Math.ceil(valor.length / MAX) }, (_, i) => `sb-${ref}-auth-token.${i}=${valor.slice(i * MAX, (i + 1) * MAX)}`).join('; ');

  const pedir = async (ruta) => {
    const r = await fetch(`${APP}${ruta}`, { headers: { cookie } });
    if (!r.ok) abortar(`${ruta}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
    return r.json();
  };

  const exp = await pedir('/api/export');
  const muro = await pedir('/api/pro/muro');

  const ids = (exp.transacciones || []).map((t) => t.id);
  const sembradasEnExport = (exp.transacciones || []).filter((t) => String(t.dedup_hash || '').startsWith(PREFIJO)).length;
  const casos = [
    [`export: trae las ${totalReal} transacciones`, ids.length === totalReal, `trae ${ids.length}`],
    ['export: ninguna repetida', new Set(ids).size === ids.length, `${ids.length - new Set(ids).size} repetidas`],
    [`export: resumen.totalTransacciones = ${totalReal}`, exp.resumen?.totalTransacciones === totalReal, `dice ${exp.resumen?.totalTransacciones}`],
    [`export: están las ${SEMBRADAS} sembradas`, sembradasEnExport === SEMBRADAS, `${sembradasEnExport}`],
    ['export: ordenado por fecha descendente', ids.length > 1 && exp.transacciones.every((t, i, a) => i === 0 || a[i - 1].fecha >= t.fecha), 'hay una fila más nueva después de una más vieja'],
    [`muro: conteoTx = ${totalReal}`, muro.conteoTx === totalReal, `dice ${muro.conteoTx}`],
    [`muro: totalMes = ${gastosMes.suma.toFixed(2)} (los ${gastosMes.filas} gastos del mes)`, Math.abs(muro.totalMes - gastosMes.suma) < 0.005, `dice ${muro.totalMes}`],
  ];

  let fallos = 0;
  for (const [nombre, ok, detalle] of casos) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${nombre}${ok ? '' : ` — ${detalle}`}`);
    if (!ok) fallos++;
  }
  console.log(`\n${casos.length - fallos}/${casos.length}${CONSERVAR ? '  (siembra conservada: correr con --limpiar al terminar)' : ''}`);
  process.exitCode = fallos ? 1 : 0;
} catch (e) {
  process.exitCode = 2;
  if (e instanceof NoSePudoMedir) {
    console.error(`NO SE PUDO MEDIR: ${e.message}`);
  } else {
    // Un error inesperado no puede dejar 1100 gastos falsos en el usuario QA sin avisar.
    limpiarAlFinal = true;
    console.error(e);
  }
} finally {
  if (limpiarAlFinal) await limpiar();
}
