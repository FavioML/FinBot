// E2E autenticado de las dos features de paridad webapp (post-eliminacion del
// flujo de gastos pendientes del bot):
//   1. /dashboard/transacciones -> badge "Por revisar" + filtro
//   2. /dashboard/configuracion -> toggle alertas_transaccion
//
// Reusa el forjado de cookie @supabase/ssr de qa-login.mjs (ver ese archivo para
// el porque: el magic link no es viable de forma autonoma).
//
// Uso: node qa-por-revisar.mjs   (o NETO_APP_URL=http://localhost:3000 node ...)
//
// REQUIERE SEED. El usuario QA no tiene transacciones sin clasificar de forma
// natural, asi que hay que sembrar las dos filas de abajo antes de correrlo (y
// borrarlas despues, para no ensuciar el score ni el dashboard del usuario QA):
//
//   insert into transacciones
//     (usuario_id, tipo, monto, monto_pen, moneda, comercio, categoria, subcategoria, fecha, metodo_pago, confirmado)
//   values
//     ('ded7e219-e5fd-4ff4-b5a3-3cd5cdffd172','gasto',33,33,'PEN','QA REVISAR OTROS','Otros',null,current_date,'Yape',true),
//     ('ded7e219-e5fd-4ff4-b5a3-3cd5cdffd172','gasto',44,44,'PEN','QA REVISAR SINCAT','Comida','Sin_categoria',current_date,'Yape',true),
//     ('ded7e219-e5fd-4ff4-b5a3-3cd5cdffd172','gasto',55,55,'PEN','QA OTROS CON SUB','Otros','Regalo',current_date,'Yape',true);
//
//   -- al terminar:
//   delete from transacciones where comercio in ('QA REVISAR OTROS','QA REVISAR SINCAT','QA OTROS CON SUB');
//
// Las tres filas cubren las tres decisiones de needsReview:
//   - "QA REVISAR OTROS"  -> Otros sin subcategoria      => SI aparece
//   - "QA REVISAR SINCAT" -> Comida / Sin_categoria      => SI aparece
//   - "QA OTROS CON SUB"  -> Otros / Regalo              => NO aparece (clasificacion
//     deliberada: usar Otros con subcategoria propia es valido, no es un pendiente)

import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const APP = process.env.NETO_APP_URL || 'https://app.neto.pe';

// De las 3 filas sembradas (ver cabecera), solo 2 son pendientes reales:
// "QA OTROS CON SUB" (Otros / Regalo) esta clasificada a proposito y NO cuenta.
const EXPECTED_POR_REVISAR = 2;

function loadEnv(path) {
  const env = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2];
  }
  return env;
}

const env = loadEnv(join(homedir(), '.config', 'neto', 'qa.env'));
const SUPA = env.NETO_QA_URL;
const ANON = env.NETO_QA_ANON;
const EMAIL = env.NETO_QA_EMAIL;
const PASSWORD = env.NETO_QA_PASSWORD;
const cookieName = `sb-${new URL(SUPA).hostname.split('.')[0]}-auth-token`;

const grant = await fetch(`${SUPA}/auth/v1/token?grant_type=password`, {
  method: 'POST',
  headers: { apikey: ANON, 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
});
if (!grant.ok) {
  console.error('Password grant failed:', grant.status);
  process.exit(2);
}
const value = 'base64-' + Buffer.from(JSON.stringify(await grant.json()), 'utf8').toString('base64url');
const MAX = 3180;
const domain = new URL(APP).hostname;
const cookies = [];
if (value.length <= MAX) cookies.push({ name: cookieName, value });
else for (let i = 0, p = 0; p < value.length; i++, p += MAX)
  cookies.push({ name: `${cookieName}.${i}`, value: value.slice(p, p + MAX) });

const browser = await chromium.launch();
const context = await browser.newContext();
await context.addCookies(cookies.map((c) => ({
  ...c, domain, path: '/', httpOnly: false, secure: APP.startsWith('https'), sameSite: 'Lax',
})));
const page = await context.newPage();

const results = {};
const rowCount = () => page.locator('table tbody tr').count();

// El tour de onboarding monta un overlay fixed inset-0 z-50 que intercepta los
// clicks. Mismo tratamiento que en qa-login.mjs: se quita antes de interactuar.
const dismissOverlay = () =>
  page.evaluate(() => {
    document.querySelectorAll('.fixed.inset-0.z-50').forEach((e) => e.remove());
  });

/* ---------- 1. Transacciones: badge "Por revisar" + filtro ---------- */
await page.goto(`${APP}/dashboard/transacciones`, { waitUntil: 'domcontentloaded' });

// El contexto es frio (sin cache persistida de React Query): la data client-side
// puede tardar. Se espera a que la tabla se estabilice antes de medir nada, o
// todas las aserciones corren contra una pagina a medio hidratar.
await page
  .locator('table tbody tr')
  .first()
  .waitFor({ timeout: 60000 })
  .catch(() => {});
await page.waitForTimeout(1000);
await dismissOverlay();

const badge = page.getByRole('button', { name: /por revisar/i });
await badge.waitFor({ timeout: 15000 }).catch(() => {});
results.badgeVisible = await badge.isVisible().catch(() => false);
results.badgeText = results.badgeVisible ? (await badge.innerText()).replace(/\n/g, ' | ') : null;

// El conteo del badge debe ser exactamente lo sembrado.
const m = (results.badgeText || '').match(/(\d+)\s+transaccion/i);
results.badgeCount = m ? Number(m[1]) : null;
results.badgeCountCorrect = results.badgeCount === EXPECTED_POR_REVISAR;

// Sin filtrar debe haber MAS filas que las por-revisar: si no, el filtro no
// prueba nada (el test seria vacuo).
results.rowsUnfiltered = await rowCount();
results.testIsNonVacuous = results.rowsUnfiltered > EXPECTED_POR_REVISAR;

// Click -> filtra.
if (results.badgeVisible) {
  await badge.click();
  await page.waitForTimeout(600);
}
results.rowsFiltered = await rowCount();
results.filterMatchesBadge = results.rowsFiltered === EXPECTED_POR_REVISAR;

// Las filas visibles deben ser exactamente las sembradas (no "unas 2 cualquiera").
const filteredText = await page.locator('table tbody').innerText().catch(() => '');
results.showsOtrosRow = /QA REVISAR OTROS/.test(filteredText);
results.showsSinCatRow = /QA REVISAR SINCAT/.test(filteredText);
// Y no debe colarse una bien clasificada...
results.leaksClassifiedRow = /Netflix|Uber|Movistar/.test(filteredText);
// ...ni "Otros / Regalo", que es Otros pero CON subcategoria deliberada.
results.leaksOtrosConSub = /QA OTROS CON SUB/.test(filteredText);

// El select de categoria refleja el filtro activo (se puede limpiar desde ahi).
// Se busca por contenido, no por indice: la fila de filtros comparte el DOM con
// el selector de mes y el de metodo de pago.
const comboTexts = await page.locator('button[role="combobox"]').allInnerTexts();
results.comboTexts = comboTexts.map((t) => t.replace(/\n/g, ' '));
results.selectShowsPorRevisar = comboTexts.some((t) => /por revisar/i.test(t));

// Toggle off -> vuelve a mostrar todo.
if (results.badgeVisible) {
  await page.getByRole('button', { name: /por revisar/i }).click();
  await page.waitForTimeout(600);
}
results.rowsAfterUntoggle = await rowCount();
results.untoggleRestores = results.rowsAfterUntoggle === results.rowsUnfiltered;

/* ---------- 2. Configuracion: toggle alertas_transaccion ---------- */
await page.goto(`${APP}/dashboard/configuracion`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2000);
await dismissOverlay();

// La tarjeta del toggle: el contenedor .rounded-lg que envuelve el copy Y el switch.
const card = page
  .locator('div.rounded-lg')
  .filter({ hasText: 'Avisos de movimientos detectados' })
  .first();
await card.waitFor({ timeout: 20000 }).catch(() => {});
results.togglePresent = await card.isVisible().catch(() => false);
results.toggleCopy = results.togglePresent ? (await card.innerText()).replace(/\n/g, ' | ') : null;

// Lee el estado real que sirve el API (fuente de verdad, no el DOM).
const readApi = async () =>
  page.evaluate(async () => (await fetch('/api/notifications')).json());
const before = await readApi();
results.apiExposesFlag = typeof before.alertas_transaccion === 'boolean';
results.apiBefore = before.alertas_transaccion;

// El switch es el unico <button> dentro de la tarjeta.
const sw = card.getByRole('button').first();
await sw.click({ timeout: 8000 }).catch((e) => { results.clickError = String(e).split('\n')[0]; });
await page.waitForTimeout(1500);

const after = await readApi();
results.apiAfter = after.alertas_transaccion;
results.togglePersisted = results.apiExposesFlag && after.alertas_transaccion === !before.alertas_transaccion;

// Restaura el valor original para no dejar el usuario QA alterado.
await sw.click({ timeout: 5000 }).catch(() => {});
await page.waitForTimeout(1500);
const restored = await readApi();
results.apiRestored = restored.alertas_transaccion;
results.restoredOk = restored.alertas_transaccion === before.alertas_transaccion;

/* ---------- Veredicto ---------- */
const checks = {
  'badge visible': results.badgeVisible,
  'test no vacuo (hay mas filas que por-revisar)': results.testIsNonVacuous,
  'conteo del badge correcto': results.badgeCountCorrect,
  'click filtra al mismo conteo': results.filterMatchesBadge,
  'filtro captura la rama categoria (Otros)': results.showsOtrosRow,
  'filtro captura la rama subcategoria (Sin_categoria)': results.showsSinCatRow,
  'filtro no cuela transacciones bien clasificadas': results.leaksClassifiedRow === false,
  'filtro no cuela "Otros" con subcategoria deliberada': results.leaksOtrosConSub === false,
  'select de categoria refleja el filtro': results.selectShowsPorRevisar,
  'destoggle restaura la vista completa': results.untoggleRestores,
  'toggle de alertas presente': results.togglePresent,
  'API expone alertas_transaccion': results.apiExposesFlag,
  'toggle persiste en la DB': results.togglePersisted,
  'valor original restaurado': results.restoredOk,
};
results.verdict = Object.fromEntries(
  Object.entries(checks).map(([k, v]) => [k, v ? 'PASS' : 'FAIL']),
);
results.allPass = Object.values(checks).every(Boolean);

console.log(JSON.stringify(results, null, 2));
await browser.close();
process.exit(results.allPass ? 0 : 1);
