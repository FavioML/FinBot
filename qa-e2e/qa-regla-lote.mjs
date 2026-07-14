// E2E: la edicion masiva de transacciones (PATCH /api/transactions) tiene que
// hacer que Neto APRENDA la regla comercio -> categoria, igual que la edicion
// individual. Sin esto, categorizar en lote desde la vista "Por revisar" no
// mejora la auto-categoria y los mismos comercios recaen el mes siguiente.
//
// Corre contra app.neto.pe con el usuario QA. Siembra sus propias transacciones
// via SQL (service role), maneja la UI con Playwright y verifica el efecto en la
// tabla reglas_comercio — o sea, verifica el aprendizaje, no solo el HTTP 200.
//
// Uso: node qa-regla-lote.mjs
// La service role key se lee de webapp/.env.local (o de SUPABASE_SERVICE_ROLE_KEY
// si viene en el entorno). Nunca se imprime.
//
// Se limpia solo: borra las transacciones y la regla que sembro.

import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const APP = process.env.NETO_APP_URL || 'https://app.neto.pe';
const USUARIO_ID = 'ded7e219-e5fd-4ff4-b5a3-3cd5cdffd172';

// Comercio unico de este test. Dos transacciones del MISMO comercio: el upsert
// debe colapsarlas en UNA sola regla.
const COMERCIO = 'QA BODEGA LOTE';
const PATRON = COMERCIO.toLowerCase();
const CATEGORIA_DESTINO = 'Transporte'; // distinta de la sembrada, para que el cambio sea visible

function loadEnv(path) {
  const env = {};
  try {
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* archivo opcional */ }
  return env;
}

const env = loadEnv(join(homedir(), '.config', 'neto', 'qa.env'));
const SUPA = env.NETO_QA_URL;
const ANON = env.NETO_QA_ANON;

// Service role: hace falta para sembrar las transacciones y para leer
// reglas_comercio saltando RLS. Se toma del entorno o de webapp/.env.local.
const SERVICE =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  loadEnv(new URL('../webapp/.env.local', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
    .SUPABASE_SERVICE_ROLE_KEY;
if (!SERVICE) {
  console.error('Falta SUPABASE_SERVICE_ROLE_KEY (entorno o webapp/.env.local).');
  process.exit(2);
}

// --- helpers REST sobre Supabase con service role ---
const sb = async (path, init = {}) => {
  const r = await fetch(`${SUPA}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SERVICE,
      Authorization: `Bearer ${SERVICE}`,
      'Content-Type': 'application/json',
      Prefer: init.method === 'POST' ? 'return=representation' : 'return=representation',
      ...(init.headers || {}),
    },
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${init.method || 'GET'} ${path} -> ${r.status} ${text}`);
  return text ? JSON.parse(text) : null;
};

const results = {};

/* ---------- limpieza previa (por si quedo basura de una corrida anterior) ---------- */
await sb(`transacciones?usuario_id=eq.${USUARIO_ID}&comercio=eq.${encodeURIComponent(COMERCIO)}`, { method: 'DELETE' });
await sb(`reglas_comercio?usuario_id=eq.${USUARIO_ID}&comercio_pattern=eq.${encodeURIComponent(PATRON)}`, { method: 'DELETE' });

/* ---------- seed: 2 transacciones del mismo comercio, sin clasificar ---------- */
const hoy = new Date().toISOString().slice(0, 10);
const seeded = await sb('transacciones', {
  method: 'POST',
  body: JSON.stringify([
    { usuario_id: USUARIO_ID, tipo: 'gasto', monto: 11, monto_pen: 11, moneda: 'PEN', comercio: COMERCIO, categoria: 'Otros', subcategoria: 'Sin_categoria', fecha: hoy, metodo_pago: 'Yape', confirmado: true },
    { usuario_id: USUARIO_ID, tipo: 'gasto', monto: 22, monto_pen: 22, moneda: 'PEN', comercio: COMERCIO, categoria: 'Otros', subcategoria: 'Sin_categoria', fecha: hoy, metodo_pago: 'Yape', confirmado: true },
  ]),
});
results.seeded = seeded.length;

// Estado previo: la regla NO debe existir. Si existiera, el test seria vacuo
// (podria "pasar" sin que el PATCH haga nada).
const reglaAntes = await sb(`reglas_comercio?usuario_id=eq.${USUARIO_ID}&comercio_pattern=eq.${encodeURIComponent(PATRON)}`);
results.reglaAntes = reglaAntes.length;
results.testIsNonVacuous = reglaAntes.length === 0;

/* ---------- login forjando la cookie SSR (ver qa-login.mjs) ---------- */
const grant = await fetch(`${SUPA}/auth/v1/token?grant_type=password`, {
  method: 'POST',
  headers: { apikey: ANON, 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: env.NETO_QA_EMAIL, password: env.NETO_QA_PASSWORD }),
});
if (!grant.ok) { console.error('Password grant failed:', grant.status); process.exit(2); }
const value = 'base64-' + Buffer.from(JSON.stringify(await grant.json()), 'utf8').toString('base64url');
const cookieName = `sb-${new URL(SUPA).hostname.split('.')[0]}-auth-token`;
const MAX = 3180;
const ck = [];
if (value.length <= MAX) ck.push({ name: cookieName, value });
else for (let i = 0, p = 0; p < value.length; i++, p += MAX) ck.push({ name: `${cookieName}.${i}`, value: value.slice(p, p + MAX) });

const browser = await chromium.launch();
const context = await browser.newContext();
await context.addCookies(ck.map((c) => ({
  ...c, domain: new URL(APP).hostname, path: '/', httpOnly: false, secure: APP.startsWith('https'), sameSite: 'Lax',
})));
const page = await context.newPage();

let patchStatus = null;
page.on('response', (r) => {
  if (r.url().includes('/api/transactions') && r.request().method() === 'PATCH') patchStatus = r.status();
});

/* ---------- UI: seleccionar las 2 filas del comercio y editarlas en lote ---------- */
await page.goto(`${APP}/dashboard/transacciones`, { waitUntil: 'domcontentloaded' });
await page.locator('table tbody tr').first().waitFor({ timeout: 60000 }).catch(() => {});
await page.waitForTimeout(1000);
await page.evaluate(() => document.querySelectorAll('.fixed.inset-0.z-50').forEach((e) => e.remove()));

// Buscar por comercio para aislar las 2 filas sembradas.
await page.getByPlaceholder(/buscar por comercio/i).fill(COMERCIO);
await page.waitForTimeout(800);
const filas = page.locator('table tbody tr');
results.filasDelComercio = await filas.count();

// Marcar los checkboxes de esas filas.
const checks = filas.locator('input[type="checkbox"]');
const n = await checks.count();
for (let i = 0; i < n; i++) await checks.nth(i).check();
results.seleccionadas = n;

// Abrir el panel de edicion masiva.
await page.getByRole('button', { name: /^Editar$/ }).click();
await page.waitForTimeout(400);

// Elegir la categoria destino en el select "Categoria" del panel bulk.
await page.getByRole('combobox').filter({ hasText: /Sin cambiar|Categoria/i }).nth(2).click().catch(async () => {
  // fallback: el tercer combobox del panel es Categoria
  await page.locator('button[role="combobox"]').nth(3).click();
});
await page.waitForTimeout(300);
await page.getByRole('option', { name: new RegExp(CATEGORIA_DESTINO, 'i') }).first().click();
await page.waitForTimeout(300);

// Aplicar.
await page.getByRole('button', { name: /Aplicar a \d+ transacciones/i }).click();
await page.waitForTimeout(4000); // el after() corre post-respuesta

results.patchStatus = patchStatus;

/* ---------- verificacion en la DB: nacio la regla? ---------- */
// after() corre despues de la respuesta: se reintenta unos segundos.
let regla = [];
for (let i = 0; i < 12; i++) {
  regla = await sb(`reglas_comercio?usuario_id=eq.${USUARIO_ID}&comercio_pattern=eq.${encodeURIComponent(PATRON)}`);
  if (regla.length > 0) break;
  await new Promise((r) => setTimeout(r, 1000));
}
results.reglaDespues = regla.length;
results.reglaCreada = regla.length === 1; // 2 transacciones, mismo comercio => UNA regla
results.reglaCategoria = regla[0]?.categoria ?? null;
results.categoriaCorrecta = regla[0]?.categoria === CATEGORIA_DESTINO;

// Y las transacciones quedaron efectivamente recategorizadas.
const txs = await sb(`transacciones?usuario_id=eq.${USUARIO_ID}&comercio=eq.${encodeURIComponent(COMERCIO)}&select=categoria`);
results.txsRecategorizadas = txs.filter((t) => t.categoria === CATEGORIA_DESTINO).length;

/* ---------- limpieza ---------- */
await sb(`transacciones?usuario_id=eq.${USUARIO_ID}&comercio=eq.${encodeURIComponent(COMERCIO)}`, { method: 'DELETE' });
await sb(`reglas_comercio?usuario_id=eq.${USUARIO_ID}&comercio_pattern=eq.${encodeURIComponent(PATRON)}`, { method: 'DELETE' });

const checksMap = {
  'seed ok (2 transacciones)': results.seeded === 2,
  'test no vacuo (la regla no existia antes)': results.testIsNonVacuous,
  'las 2 filas se seleccionaron en la UI': results.seleccionadas === 2,
  'PATCH respondio 200': results.patchStatus === 200,
  'las transacciones se recategorizaron': results.txsRecategorizadas === 2,
  'NACIO la regla de comercio (el fix)': results.reglaCreada,
  'la regla apunta a la categoria elegida': results.categoriaCorrecta,
};
results.verdict = Object.fromEntries(Object.entries(checksMap).map(([k, v]) => [k, v ? 'PASS' : 'FAIL']));
results.allPass = Object.values(checksMap).every(Boolean);

console.log(JSON.stringify(results, null, 2));
await browser.close();
process.exit(results.allPass ? 0 : 1);
