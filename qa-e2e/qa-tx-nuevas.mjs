// Movimientos nuevos en Transacciones (migración 091, `transacciones.vista_at`), contra PRODUCCIÓN.
//
// Lo que se prueba, en orden, porque cada paso depende del anterior:
//   1. Lo que entra SIN nombrar la columna (como lo inserta el bot o el barrido de Gmail) nace
//      `vista_at NULL`. Si alguien vuelve a poner un DEFAULT en la columna, esto se pone rojo y
//      la pantalla deja de marcar nada sin que ningún test unitario lo vea.
//   2. `POST /api/transactions/vistas {ids}` marca solo esa fila.
//   3. El mismo endpoint NO toca la fila de otro usuario aunque se le pase su id (IDOR).
//   4. Lo que se crea desde la webapp (`POST /api/transactions`) nace visto.
//   5. La pantalla (`/dashboard/transacciones`, en un navegador de verdad) muestra el banner con
//      el conteo real de la base y la pastilla "Nuevo", y "Ya los vi" deja el conteo en cero.
//
// Siembra con `dedup_hash` `qa-nuevas-*` (la convención `qa%` del usuario QA) y limpia al final.
// Borrar deja copia en `borrados_auditoria` (trg_audit_borrado, append-only): ~5 filas del QA
// por corrida. Fuera del canary por eso. Antes del deploy de la webapp sirve como CONTROL: los
// pasos 2 a 5 tienen que fallar.
//
// Uso: node qa-tx-nuevas.mjs        Exit 0 = pasa · 1 = REGRESIÓN · 2 = no se pudo medir

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const APP = process.env.NETO_APP_URL || 'https://app.neto.pe';
const QA_PRO = 'ded7e219-e5fd-4ff4-b5a3-3cd5cdffd172';
const QA_FREE = 'a9664eeb-ee0b-4640-b848-fdd0daa5aff0';
const PREFIJO = 'qa-nuevas-';

function loadEnv(path) {
  const env = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2];
  }
  return env;
}

class NoSePudoMedir extends Error {}
const abortar = (motivo) => { throw new NoSePudoMedir(motivo); };

const env = loadEnv(join(homedir(), '.config', 'neto', 'qa.env'));
const SUPA = env.NETO_QA_URL;
const ANON = env.NETO_QA_ANON;
const SERVICE =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  loadEnv(new URL('../webapp/.env.local', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')).SUPABASE_SERVICE_ROLE_KEY;
if (!SUPA || !ANON || !env.NETO_QA_EMAIL || !env.NETO_QA_PASSWORD || !SERVICE) {
  console.error('NO SE PUDO MEDIR: faltan credenciales (~/.config/neto/qa.env o SUPABASE_SERVICE_ROLE_KEY)');
  process.exit(2);
}

const rest = (ruta, init = {}) =>
  fetch(`${SUPA}/rest/v1/${ruta}`, {
    ...init,
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
  });

const leer = async (ruta) => {
  const r = await rest(ruta);
  if (!r.ok) abortar(`${ruta}: HTTP ${r.status} ${await r.text()}`);
  return r.json();
};

const vistaDe = async (id) => (await leer(`transacciones?id=eq.${id}&select=vista_at`))[0]?.vista_at;
const nuevasDelQa = async () => (await leer(`transacciones?usuario_id=eq.${QA_PRO}&vista_at=is.null&select=id`)).length;

async function limpiar() {
  // Fijado a los dos usuarios QA Y al prefijo: no puede tocar una fila de nadie más.
  for (const u of [QA_PRO, QA_FREE]) {
    const r = await rest(`transacciones?usuario_id=eq.${u}&dedup_hash=like.${PREFIJO}*`, { method: 'DELETE' });
    if (!r.ok) console.error(`AVISO: la limpieza de ${u} devolvió ${r.status}. Borrar a mano dedup_hash like '${PREFIJO}%'.`);
  }
}

const hoy = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Lima' });
const sello = Date.now().toString(36);
const fila = (usuario, n, extra = {}) => ({
  usuario_id: usuario, tipo: 'gasto', monto: 1, monto_pen: 1, moneda: 'PEN', comercio: `QA nuevas ${n}`,
  categoria: 'Otros', fecha: hoy, descripcion_original: 'Sembrada por qa-tx-nuevas.mjs', dedup_hash: `${PREFIJO}${sello}-${n}`,
  // PostgREST exige las mismas claves en todas las filas de un insert múltiple (PGRST102).
  gmail_msg_id: null, ...extra,
});

const casos = [];
const caso = (nombre, ok, detalle = '') => casos.push([nombre, !!ok, detalle]);
let creadaPorWeb = null;
let cookieHeader = null;

try {
  // ── Siembra: tal como insertan el bot y el barrido, sin nombrar vista_at ──
  const ins = await rest('transacciones?select=id,usuario_id,dedup_hash', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify([
      fila(QA_PRO, 'a'),
      fila(QA_PRO, 'b', { gmail_msg_id: `${PREFIJO}${sello}` }),
      fila(QA_FREE, 'ajena'),
    ]),
  });
  if (!ins.ok) abortar(`siembra: HTTP ${ins.status} ${await ins.text()}`);
  const sembradas = await ins.json();
  const id = (n) => sembradas.find((s) => s.dedup_hash.endsWith(`-${n}`)).id;

  // 1
  const sinMarca = await Promise.all(['a', 'b', 'ajena'].map((n) => vistaDe(id(n))));
  caso('lo que entra sin nombrar vista_at nace NULL (nuevo)', sinMarca.every((v) => v === null), JSON.stringify(sinMarca));

  // ── Sesión del QA Pro: password grant + cookie @supabase/ssr ──
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
  const cookies = valor.length <= MAX
    ? [[`sb-${ref}-auth-token`, valor]]
    : Array.from({ length: Math.ceil(valor.length / MAX) }, (_, i) => [`sb-${ref}-auth-token.${i}`, valor.slice(i * MAX, (i + 1) * MAX)]);
  cookieHeader = cookies.map(([k, v]) => `${k}=${v}`).join('; ');
  const api = (ruta, body, method = 'POST') =>
    fetch(`${APP}${ruta}`, { method, headers: { cookie: cookieHeader, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });

  // 2
  const r2 = await api('/api/transactions/vistas', { ids: [id('a')] });
  const j2 = r2.ok ? await r2.json() : null;
  caso('vistas {ids}: responde 200 con vistas=1', r2.status === 200 && j2?.vistas === 1, `HTTP ${r2.status} ${JSON.stringify(j2)}`);
  caso('vistas {ids}: marca esa fila', (await vistaDe(id('a'))) !== null);
  caso('vistas {ids}: no toca la otra', (await vistaDe(id('b'))) === null);

  // 3
  const r3 = await api('/api/transactions/vistas', { ids: [id('ajena')] });
  caso('vistas: la fila de otro usuario no se toca (IDOR)', (await vistaDe(id('ajena'))) === null, `HTTP ${r3.status}`);

  // 4
  const r4 = await api('/api/transactions', { monto: 1, fecha: hoy, categoria: 'Otros', tipo: 'gasto', comercio: `QA nuevas web ${sello}` });
  creadaPorWeb = r4.ok ? (await r4.json()).id : null;
  caso('lo creado desde la webapp nace visto', creadaPorWeb && (await vistaDe(creadaPorWeb)) !== null, `HTTP ${r4.status}`);

  // 5 · navegador de verdad
  const esperadas = await nuevasDelQa();
  const { chromium } = require('playwright');
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await ctx.addCookies(cookies.map(([name, value]) => ({ name, value, url: APP })));
    // El tour de bienvenida tapa la pantalla en un navegador limpio. Se salta con su marca local,
    // sin tocar `usuarios.tour_visto` del QA (otros harness pueden querer verlo).
    await ctx.addInitScript(() => localStorage.setItem('neto_tour_v2', 'true'));
    const page = await ctx.newPage();
    await page.goto(`${APP}/dashboard/transacciones`, { waitUntil: 'networkidle' });
    const banner = page.getByText(/Neto registró \d+ movimientos? que todavía no viste/);
    await banner.waitFor({ timeout: 20000 }).catch(() => {});
    const texto = (await banner.textContent().catch(() => null)) || '';
    const n = Number(texto.match(/registró (\d+)/)?.[1]);
    caso(`pantalla: el banner cuenta ${esperadas} (lo que dice la base)`, n === esperadas, `dice "${texto}"`);
    caso('pantalla: hay al menos una pastilla "Nuevo"', (await page.getByText('Nuevo', { exact: true }).count()) > 0);
    // Sin el botón es un FAIL de la pantalla, no un "no se pudo medir".
    const boton = page.getByRole('button', { name: 'Ya los vi' });
    const hayBoton = (await boton.count()) > 0;
    caso('pantalla: está el botón "Ya los vi"', hayBoton);
    if (hayBoton) {
      const respuesta = page.waitForResponse((res) => res.url().includes('/api/transactions/vistas'), { timeout: 15000 }).catch(() => null);
      await boton.click();
      await respuesta;
      caso('pantalla: "Ya los vi" deja la base sin nuevas', (await nuevasDelQa()) === 0);
      caso('pantalla: el banner desaparece', (await page.getByText(/que todavía no viste/).count()) === 0);
    }
  } finally {
    await browser.close();
  }
} catch (e) {
  console.error(e instanceof NoSePudoMedir ? `NO SE PUDO MEDIR: ${e.message}` : e);
  process.exitCode = 2;
} finally {
  await limpiar();
  if (creadaPorWeb && cookieHeader) {
    const r = await fetch(`${APP}/api/transactions?id=${creadaPorWeb}`, { method: 'DELETE', headers: { cookie: cookieHeader } });
    if (!r.ok) console.error(`AVISO: no se pudo borrar la creada por la webapp (${creadaPorWeb}): HTTP ${r.status}`);
  }
}

let fallos = 0;
for (const [nombre, ok, detalle] of casos) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${nombre}${ok ? '' : ` — ${detalle}`}`);
  if (!ok) fallos++;
}
console.log(`\n${casos.length - fallos}/${casos.length}`);
if (process.exitCode !== 2) process.exitCode = fallos ? 1 : 0;
