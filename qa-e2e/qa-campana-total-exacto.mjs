// El `total` de la campana contra PRODUCCIÓN, con un usuario que supera el cap del listado.
//
// El panel lista con `.limit(20)` y hasta el 2026-08-27 la telemetría derivaba `total` y
// `tipos` de esa lista, mientras `unreadCount` contaba exacto. Resultado: aperturas reales en
// PostHog con `total: 20, no_leidas: 22`. El sesgo satura ARRIBA, o sea justo en el usuario con
// volumen — el único sobre el que la pregunta "¿es ruido?" tiene sentido.
//
// **Por qué hace falta sembrar.** El usuario QA tiene exactamente 20 avisos, y con 20 el código
// viejo y el nuevo dan el MISMO número. Un harness que lo corriera tal cual pasaría en verde
// contra el bug: no distingue nada. Por eso siembra 5 filas VIEJAS (fecha anterior a todas las
// suyas) con un `tipo` marcador, y así:
//   · el listado de los 20 más nuevos NO las incluye  → `notifications.length` sigue en 20
//   · `total` exacto pasa a 25                        → el viejo seguiría diciendo 20
//   · `tipos` incluye el marcador                     → el viejo no lo vería nunca
// Es la misma forma que el defecto real: en producción el tipo que desaparecía era
// `deuda_vence`, en los dos usuarios con más volumen.
//
// **Qué se ve al correrlo contra el código VIEJO.** El censurado vivía en el cliente
// (`notification-bell.tsx` hacía `total: notifications.length`), así que la API vieja no
// devuelve el campo: el control pre-deploy sale `total: undefined`, no `total: 20`. Es rojo
// igual y por el motivo correcto —la ruta no publica el número exacto—, pero conviene saberlo
// para no leer el `undefined` como un fallo del harness. Corrido así el 27-ago: 4/8.
//
// Uso: node qa-campana-total-exacto.mjs
// Exit 0 = pasa · 1 = REGRESIÓN · 2 = no se pudo medir (credenciales, red, siembra)

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const APP = process.env.NETO_APP_URL || 'https://app.neto.pe';
const QA_USUARIO_ID = 'ded7e219-e5fd-4ff4-b5a3-3cd5cdffd172';
const MARCADOR = 'qa_fuera_del_cap';
const SEMBRADAS = 5;

function loadEnv(path) {
  const env = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2];
  }
  return env;
}

function abortar(motivo) {
  console.error(`NO SE PUDO MEDIR: ${motivo}`);
  process.exit(2);
}

const env = loadEnv(join(homedir(), '.config', 'neto', 'qa.env'));
const SUPA = env.NETO_QA_URL;
const ANON = env.NETO_QA_ANON;
if (!SUPA || !ANON || !env.NETO_QA_EMAIL || !env.NETO_QA_PASSWORD) {
  abortar('faltan credenciales en ~/.config/neto/qa.env');
}

const SERVICE =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  loadEnv(new URL('../webapp/.env.local', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
    .SUPABASE_SERVICE_ROLE_KEY;
if (!SERVICE) abortar('falta SUPABASE_SERVICE_ROLE_KEY (entorno o webapp/.env.local)');

const rest = (ruta, init = {}) =>
  fetch(`${SUPA}/rest/v1/${ruta}`, {
    ...init,
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
  });

async function limpiar() {
  // `tipo=eq.<marcador>` acotado al usuario QA: no puede tocar una fila de nadie más.
  const r = await rest(`notificaciones?usuario_id=eq.${QA_USUARIO_ID}&tipo=eq.${MARCADOR}`, { method: 'DELETE' });
  if (!r.ok) console.error(`AVISO: la limpieza devolvió ${r.status}. Borrar a mano las filas tipo='${MARCADOR}'.`);
}

let sembrado = false;
try {
  // ── Estado previo ────────────────────────────────────────────────────────────
  await limpiar(); // por si una corrida anterior murió a mitad
  const previas = await rest(`notificaciones?usuario_id=eq.${QA_USUARIO_ID}&select=fecha&order=fecha.asc&limit=1`);
  if (!previas.ok) abortar(`no se pudo leer el estado previo: HTTP ${previas.status}`);
  const filas = await previas.json();
  if (filas.length !== 1) abortar(`el usuario QA no tiene avisos: no hay nada que capar`);
  const masVieja = new Date(filas[0].fecha);

  // ── Siembra: 5 filas MÁS VIEJAS que todas las suyas ──────────────────────────
  const nuevas = Array.from({ length: SEMBRADAS }, (_, i) => ({
    usuario_id: QA_USUARIO_ID,
    tipo: MARCADOR,
    titulo: 'QA fuera del cap',
    mensaje: 'Sembrada por qa-campana-total-exacto.mjs',
    datos: {},
    leida: true,
    fecha: new Date(masVieja.getTime() - (i + 1) * 86400000).toISOString(),
  }));
  const ins = await rest('notificaciones', { method: 'POST', body: JSON.stringify(nuevas) });
  if (!ins.ok) abortar(`la siembra falló: HTTP ${ins.status} ${await ins.text()}`);
  sembrado = true;

  // El universo REAL, leído de la base y no asumido: es contra esto que se compara.
  const cnt = await rest(`notificaciones?usuario_id=eq.${QA_USUARIO_ID}&select=id`, {
    headers: { Prefer: 'count=exact', Range: '0-0' },
  });
  const totalReal = Number((cnt.headers.get('content-range') || '').split('/')[1]);
  if (!Number.isFinite(totalReal)) abortar('no se pudo contar el universo real');
  if (totalReal <= 20) abortar(`el universo quedó en ${totalReal}: con <=20 el bug y el arreglo dan lo mismo`);

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
  const cookie =
    valor.length <= MAX
      ? `sb-${ref}-auth-token=${valor}`
      : Array.from({ length: Math.ceil(valor.length / MAX) }, (_, i) => `sb-${ref}-auth-token.${i}=${valor.slice(i * MAX, (i + 1) * MAX)}`).join('; ');

  const pedir = async (ruta) => {
    const r = await fetch(`${APP}${ruta}`, { headers: { cookie } });
    if (!r.ok) abortar(`${ruta}: HTTP ${r.status}`);
    return r.json();
  };

  // ── Las dos superficies: la campana pide a inbox, y el fast-path siembra su caché ──
  const inbox = await pedir('/api/notifications/inbox');
  const dash = (await pedir('/api/dashboard')).notifications;

  const casos = [];
  for (const [nombre, d] of [['inbox', inbox], ['dashboard', dash]]) {
    casos.push([`${nombre}: el listado sigue capado en 20`, d.notifications.length === 20, `largo ${d.notifications.length}`]);
    casos.push([`${nombre}: total exacto = ${totalReal}`, d.total === totalReal, `total ${d.total} (el listado tiene ${d.notifications.length})`]);
    casos.push([`${nombre}: tipos ve lo que vive FUERA del cap`, Array.isArray(d.tipos) && d.tipos.includes(MARCADOR), `tipos ${JSON.stringify(d.tipos)}`]);
    const enElListado = [...new Set(d.notifications.map((n) => n.tipo))];
    casos.push([`${nombre}: el marcador NO está en el listado (si no, no prueba nada)`, !enElListado.includes(MARCADOR), `listado ${JSON.stringify(enElListado)}`]);
  }

  let fallos = 0;
  for (const [nombre, ok, detalle] of casos) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${nombre}${ok ? '' : ` — ${detalle}`}`);
    if (!ok) fallos++;
  }
  console.log(`\n${casos.length - fallos}/${casos.length}`);
  await limpiar();
  sembrado = false;
  process.exit(fallos ? 1 : 0);
} finally {
  if (sembrado) await limpiar();
}
