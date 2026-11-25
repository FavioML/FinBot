// E2E: borrar una categoría RAÍZ que tiene movimientos no puede tumbar la webapp.
//
// POR QUÉ EXISTE (25-nov-2026). Un pagador reportó "el sitio web no funciona" después de
// borrar sus categorías Alimentación y Transporte para rehacerlas. El DELETE de una raíz
// deja sus movimientos en "Por revisar" con `categoria = null` (cascadeRootDelete), y la
// webapp asumía `categoria: string`: `getCategoriaEmoji(null)` hace `null.toLowerCase()`
// en cada fila que pinta, y la pantalla entera cae al error boundary ("Algo salió mal").
// En producción era el ÚNICO usuario con filas `categoria IS NULL` (39), porque es la
// única forma de fabricarlas.
//
// Hace el camino real, por la API y no por SQL: crea una raíz, anota un gasto en ella,
// borra la raíz (y verifica con el oráculo que la fila quedó con categoria NULL), y abre
// las pantallas que pintan movimientos en un navegador de verdad. Self-cleaning.
//
// Uso: node qa-raiz-borrada-render.mjs      (NETO_APP_URL para otro deploy)
// Exit 0 = ninguna pantalla cae, 1 = alguna cae, 2 = setup/inconcluso.

import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { cerrar } from './lib/veredicto.mjs';

const APP = process.env.NETO_APP_URL || 'https://app.neto.pe';
const TAG = 'QA-RaizBorrada';
// Los dos error boundaries: el del dashboard (dashboard/error.tsx) y el raíz (app/error.tsx),
// que es el que atrapa un error del shell y tumba TODAS las pantallas a la vez.
const BOUNDARY = /Algo salió mal|Algo se rompió de nuestro lado/;

function loadEnv(path) {
  const env = {};
  try {
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* opcional */ }
  return env;
}

const env = loadEnv(join(homedir(), '.config', 'neto', 'qa.env'));
const SUPA = env.NETO_QA_URL;
const ANON = env.NETO_QA_ANON;
const EMAIL = env.NETO_QA_EMAIL;
const PASSWORD = env.NETO_QA_PASSWORD;
const UID = env.NETO_QA_USUARIO_ID;
const SERVICE =
  env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  loadEnv(new URL('../webapp/.env.local', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
    .SUPABASE_SERVICE_ROLE_KEY;

if (!SUPA || !ANON || !EMAIL || !PASSWORD || !UID || !SERVICE) {
  console.error('Faltan creds: NETO_QA_* en ~/.config/neto/qa.env y SUPABASE_SERVICE_ROLE_KEY.');
  process.exit(2);
}

const cookieName = `sb-${new URL(SUPA).hostname.split('.')[0]}-auth-token`;
// Fecha de Lima: el gasto tiene que caer en el mes que el dashboard abre por defecto.
const hoy = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima' }).format(new Date());

async function sb(path, init = {}) {
  const r = await fetch(`${SUPA}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SERVICE,
      Authorization: `Bearer ${SERVICE}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
      ...(init.headers || {}),
    },
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${init.method || 'GET'} ${path} -> ${r.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

const grant = await fetch(`${SUPA}/auth/v1/token?grant_type=password`, {
  method: 'POST',
  headers: { apikey: ANON, 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
});
if (!grant.ok) { console.error('Password grant falló:', grant.status); process.exit(2); }
const session = await grant.json();
const value = 'base64-' + Buffer.from(JSON.stringify(session), 'utf8').toString('base64url');
const MAX = 3180;
const pares = [];
if (value.length <= MAX) pares.push([cookieName, value]);
else for (let i = 0, p = 0; p < value.length; i++, p += MAX) pares.push([`${cookieName}.${i}`, value.slice(p, p + MAX)]);
const cookieHeader = pares.map(([n, v]) => `${n}=${v}`).join('; ');

async function api(method, path, body) {
  const r = await fetch(`${APP}${path}`, {
    method,
    headers: { Cookie: cookieHeader, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  const text = await r.text().catch(() => '');
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* no-json */ }
  return { status: r.status, json };
}

async function limpiar() {
  await sb(`transacciones?usuario_id=eq.${UID}&comercio=ilike.${TAG}*`, { method: 'DELETE' }).catch((e) => console.error('[limpiar tx]', e.message));
  await sb(`reglas_comercio?usuario_id=eq.${UID}&comercio_pattern=ilike.${TAG}*`, { method: 'DELETE' }).catch(() => {});
  // Subs antes que raíces (FK padre_id).
  await sb(`categorias_usuario?usuario_id=eq.${UID}&nombre=ilike.${TAG}*&padre_id=not.is.null`, { method: 'DELETE' }).catch(() => {});
  await sb(`categorias_usuario?usuario_id=eq.${UID}&nombre=ilike.${TAG}*`, { method: 'DELETE' }).catch((e) => console.error('[limpiar cat]', e.message));
}

const R = { app: APP, hoy };
const fallas = [];
let medidos = 0;
let inconcluso = null;
let browser;

try {
  await limpiar();

  // 1. Raíz + gasto en ella, por la API como lo haría la persona.
  const raiz = await api('POST', '/api/categories', { nombre: TAG });
  R.crearRaiz = raiz.status;
  if (raiz.status !== 201 && raiz.status !== 200) throw new Error(`crear raíz: ${raiz.status} ${JSON.stringify(raiz.json)}`);
  const tx = await api('POST', '/api/transactions', {
    tipo: 'gasto', monto: 7.5, moneda: 'PEN', comercio: `${TAG} bodega`,
    categoria: TAG, subcategoria: 'snacks', fecha: hoy, metodo_pago: 'efectivo',
  });
  R.crearTx = tx.status;
  if (tx.status !== 200) throw new Error(`crear tx: ${tx.status} ${JSON.stringify(tx.json)}`);
  const txId = tx.json.id;

  // 2. Borrar la raíz. Es lo que hizo el pagador.
  const del = await api('DELETE', `/api/categories?id=${raiz.json.id}`);
  R.borrarRaiz = del.status;
  if (del.status !== 200) throw new Error(`borrar raíz: ${del.status} ${JSON.stringify(del.json)}`);

  // 3. Oráculo: la fila quedó como la del pagador (precondición, no afirmación).
  const [fila] = await sb(`transacciones?id=eq.${txId}&select=categoria,subcategoria`);
  R.filaTrasBorrar = fila;
  if (!fila) throw new Error('la transacción sembrada desapareció');
  medidos++;
  if (fila.categoria !== 'Otros' || (fila.subcategoria || '').toLowerCase() !== 'sin_categoria') {
    fallas.push(`borrar la raíz dejó la fila en ${JSON.stringify(fila)}; se espera categoria 'Otros' + 'sin_categoria'`);
  }


  // 4. Navegador real sobre las pantallas que pintan movimientos.
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const domain = new URL(APP).hostname;
  await context.addCookies(pares.map(([name, v]) => ({ name, value: v, domain, path: '/', httpOnly: false, secure: true, sameSite: 'Lax' })));
  await context.addInitScript(() => {
    try { localStorage.setItem('neto_tour_v2', 'true'); localStorage.setItem('neto_welcome_seen', '1'); } catch {}
  });
  const page = await context.newPage();
  const errores = [];
  page.on('pageerror', (e) => errores.push(String(e).slice(0, 240)));
  // Un error que atrapa un error boundary de React NO llega como pageerror: sale por console.error.
  page.on('console', (m) => { if (m.type() === 'error' && /TypeError|Cannot read|is not a function|\[(?:Dashboard|Root) Error\]/.test(m.text())) errores.push(m.text().slice(0, 400)); });

  const pantallas = [
    { ruta: '/dashboard', listo: /Gastos por Categor|Transacciones recientes|S\/\s*[\d.,]+/i },
    { ruta: '/dashboard/transacciones', listo: new RegExp(`${TAG} bodega`, 'i') },
    { ruta: '/dashboard/reportes', listo: /S\/\s*[\d.,]+/ },
    { ruta: '/dashboard/presupuestos', listo: /Nuevo presupuesto|Crear presupuesto|Sin presupuestos|S\/\s*[\d.,]+/i },
  ];
  R.pantallas = {};
  for (const p of pantallas) {
    errores.length = 0;
    await page.goto(`${APP}${p.ruta}`, { waitUntil: 'domcontentloaded' });
    // Esperar a que pinte datos o a que caiga al boundary, lo que pase primero.
    await Promise.race([
      page.getByText(p.listo).first().waitFor({ timeout: 45000 }),
      page.getByText(BOUNDARY).first().waitFor({ timeout: 45000 }),
    ]).catch(() => {});
    await page.waitForTimeout(2500);
    const boundary = await page.getByText(BOUNDARY).first().isVisible().catch(() => false);
    // Sobre el texto VISIBLE del body y no con getByText().first(): en /dashboard el primer
    // nodo que matchea está oculto (layout de celular) y daba "no pintó" con la pantalla llena.
    const visible = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ');
    const pinto = p.listo.test(visible);
    const url = page.url();
    const texto = visible.slice(0, 300);
    if (process.env.NETO_QA_SHOT) await page.screenshot({ path: `raiz-borrada${p.ruta.replace(/\//g, '_')}.png` }).catch(() => {});
    R.pantallas[p.ruta] = { url: url.replace(APP, ''), boundary, pinto, pageerrors: [...errores], texto };
    medidos++;
    if (boundary || errores.length) {
      fallas.push(`${p.ruta}: ${boundary ? 'cae al error boundary' : 'pageerror'} — ${errores[0] || ''}`);
    } else if (!pinto) {
      fallas.push(`${p.ruta}: no pintó datos en 45s (ni boundary ni error)`);
    }
  }

  // 5. La fila "Por revisar" tiene que verse en transacciones, no solo no romper.
  await page.goto(`${APP}/dashboard/transacciones`, { waitUntil: 'domcontentloaded' });
  await page.getByText(new RegExp(`${TAG} bodega`, 'i')).first().waitFor({ timeout: 45000 }).catch(() => {});
  R.filaVisible = await page.getByText(new RegExp(`${TAG} bodega`, 'i')).first().isVisible().catch(() => false);
  medidos++;
  if (!R.filaVisible) fallas.push('transacciones: el gasto de la raíz borrada no aparece');

  // 6. El escritor hermano: el PATCH en lote convierte '' en null. La base tiene que
  // guardarlo como 'Otros' (trigger de la 094) en vez de dejar un null que tumba la app.
  // Va AL FINAL a propósito: sin la 094 este paso fabrica un null, y antes de las pantallas
  // las tumbaba él mismo, mezclando dos defectos en una sola medición.
  const patch = await api('PATCH', '/api/transactions', { ids: [txId], updates: { categoria: '' } });
  const [trasPatch] = await sb(`transacciones?id=eq.${txId}&select=categoria`);
  R.patchVacio = { status: patch.status, categoria: trasPatch?.categoria };
  medidos++;
  if (trasPatch?.categoria !== 'Otros') {
    fallas.push(`PATCH con categoria '' dejó ${JSON.stringify(trasPatch?.categoria)} (HTTP ${patch.status}); se espera 'Otros' (¿está aplicada la migración 094?)`);
  }
} catch (e) {
  inconcluso = String(e.message || e).slice(0, 300);
} finally {
  if (browser) await browser.close().catch(() => {});
  await limpiar();
}

cerrar({ nombre: 'qa-raiz-borrada-render', fallas, medidos, inconcluso, R });
