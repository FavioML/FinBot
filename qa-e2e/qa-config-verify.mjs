// Verificación E2E autenticada de la página de Configuración (app.neto.pe).
//
// Cubre los 3 fixes del rework de Configuración (commit 7eb4ed9):
//   1. "Ver planes y precios" enlaza a /dashboard/pro (precios), NO a
//      /dashboard/planes (que es metas de ahorro).
//   2. El índice lateral (scroll-spy) resalta la sección correcta al hacer clic
//      (antes se quedaba clavado en "Categorías").
//   3. /api/categories no devuelve categorías raíz duplicadas (bug de .single()
//      en services/categories.js que multiplicaba filas; limpiado en DB).
//
// Ruta 3: password grant + cookie @supabase/ssr forjada + Playwright real. Sin
// magic link, sin inyección por el navegador del MCP, sin exponer el token.
// Credenciales desde ~/.config/neto/qa.env, nunca impresas.
//
// Usage: node qa-config-verify.mjs
// Exit 0 = todo PASS, 1 = alguna aserción falló, 2 = error de setup.

import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = process.env.NETO_APP_URL || 'https://app.neto.pe';
const HERE = dirname(fileURLToPath(import.meta.url));

function loadEnv(path) {
  const env = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2];
  }
  return env;
}
function ok(cond) { return cond ? 'PASS' : 'FAIL'; }

const env = loadEnv(join(homedir(), '.config', 'neto', 'qa.env'));
const SUPA = env.NETO_QA_URL;
const ANON = env.NETO_QA_ANON;
// Usuario Free por defecto: ejercita el bloque de upsell Pro (link a precios).
const EMAIL = env.NETO_QA_FREE_EMAIL || env.NETO_QA_EMAIL;
const PASSWORD = env.NETO_QA_FREE_PASSWORD || env.NETO_QA_PASSWORD;
const ref = new URL(SUPA).hostname.split('.')[0];
const cookieName = `sb-${ref}-auth-token`;

if (!SUPA || !ANON || !EMAIL || !PASSWORD) {
  console.error('Missing creds in ~/.config/neto/qa.env');
  process.exit(2);
}

// 1) Password grant -> session
const grant = await fetch(`${SUPA}/auth/v1/token?grant_type=password`, {
  method: 'POST',
  headers: { apikey: ANON, 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
});
if (!grant.ok) {
  console.error('Password grant failed:', grant.status, await grant.text());
  process.exit(2);
}
const session = await grant.json();

// 2) Forjar la cookie @supabase/ssr: 'base64-' + base64url(JSON(session)),
//    troceada a 3180 chars en name.0/name.1/... si desborda.
const value = 'base64-' + Buffer.from(JSON.stringify(session), 'utf8').toString('base64url');
const MAX = 3180;
const domain = new URL(APP).hostname;
const cookieParts = [];
if (value.length <= MAX) {
  cookieParts.push({ name: cookieName, value });
} else {
  for (let i = 0, p = 0; p < value.length; i++, p += MAX) {
    cookieParts.push({ name: `${cookieName}.${i}`, value: value.slice(p, p + MAX) });
  }
}
const toAdd = cookieParts.map((c) => ({
  name: c.name, value: c.value, domain, path: '/', httpOnly: false, secure: true, sameSite: 'Lax',
}));

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await context.addCookies(toAdd);
const page = await context.newPage();

const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });

const results = {};

// --- Cargar Configuración (con retry por cold-start de Vercel) ---
let loaded = false;
for (let attempt = 0; attempt < 2 && !loaded; attempt++) {
  await page.goto(`${APP}/dashboard/configuracion`, { waitUntil: 'domcontentloaded' });
  loaded = await page.locator('#perfil').first().waitFor({ timeout: 15000 }).then(() => true).catch(() => false);
  if (!loaded) results.coldStartRetry = attempt + 1;
}
results.urlAfterLoad = page.url();
results.pageRendered = loaded && page.url().includes('/dashboard/configuracion');

// Quitar overlay del tour de onboarding si aparece (bloquea clics).
await page.evaluate(() => document.querySelectorAll('.fixed.inset-0.z-50').forEach((e) => e.remove()));

// ------------------------------------------------------------------
// Check 1 — "Ver planes y precios" apunta a /dashboard/pro
// ------------------------------------------------------------------
const planLinks = await page.locator('#plan a').evaluateAll((as) =>
  as.map((a) => ({ text: a.textContent.trim(), href: a.getAttribute('href') })));
results.planLinks = planLinks;
const preciosLink = planLinks.find((l) => /planes y precios/i.test(l.text));
results.check1_linkAPro = !!preciosLink && preciosLink.href === '/dashboard/pro';
results.check1_ningunLinkAMetas = !planLinks.some((l) => l.href === '/dashboard/planes');

// ------------------------------------------------------------------
// Check 2 — scroll-spy resalta la sección correcta al hacer clic
// (regresión: se quedaba en "Categorías")
// ------------------------------------------------------------------
async function activeNavHref() {
  return page.evaluate(() => {
    const links = [...document.querySelectorAll('nav a[href^="#"]')];
    const active = links.find((a) => a.className.includes('bg-primary/10'));
    return active ? active.getAttribute('href') : null;
  });
}
// Al cargar la página (sin scrollear) el ítem activo debe ser Perfil, no la
// última sección. Regresión: en el primer render corto, el override de "fondo"
// robaba el resaltado a "Sesión y cuenta".
await page.evaluate(() => window.scrollTo(0, 0));
await page.waitForTimeout(400);
results.initialActive = await activeNavHref();
results.check2b_initialActiveEsPerfil = results.initialActive === '#perfil';

const navSpy = {};
for (const id of ['privacidad', 'exportar', 'sesion']) {
  await page.locator(`nav a[href="#${id}"]`).click();
  await page.waitForTimeout(1200); // pasa el click-lock de 700ms
  navSpy[id] = await activeNavHref();
}
results.navSpy = navSpy;
results.check2_scrollSpyOk =
  navSpy.privacidad === '#privacidad' &&
  navSpy.exportar === '#exportar' &&
  navSpy.sesion === '#sesion';

// ------------------------------------------------------------------
// Check 3 — /api/categories sin raíces duplicadas
// ------------------------------------------------------------------
const cats = await page.evaluate(async () => {
  const r = await fetch('/api/categories');
  if (!r.ok) return { status: r.status, roots: [] };
  const data = await r.json();
  return { status: r.status, roots: data.map((c) => c.nombre) };
});
const names = cats.roots || [];
const dupNames = names.filter((n, i) => names.indexOf(n) !== i);
results.categoriesStatus = cats.status;
results.rootCategoryCount = names.length;
results.duplicateRootNames = [...new Set(dupNames)];
results.check3_noDuplicates = cats.status === 200 && dupNames.length === 0;

// Evidencia visual
const shot = join(HERE, 'config-verify-shot.png');
await page.screenshot({ path: shot, fullPage: true });
results.screenshot = shot;

results.consoleErrorCount = consoleErrors.length;
results.consoleErrors = consoleErrors.slice(0, 6);

// --- Verdict ---
const checks = {
  'página Configuración renderiza autenticada': results.pageRendered,
  'C1: "Ver planes y precios" -> /dashboard/pro': results.check1_linkAPro,
  'C1: ningún link del plan va a /dashboard/planes': results.check1_ningunLinkAMetas,
  'C2b: al cargar, el índice resalta Perfil (no Sesión)': results.check2b_initialActiveEsPerfil,
  'C2: scroll-spy resalta la sección clicada (no Categorías)': results.check2_scrollSpyOk,
  'C3: /api/categories sin raíces duplicadas': results.check3_noDuplicates,
};
results.verdict = Object.fromEntries(Object.entries(checks).map(([k, v]) => [k, ok(v)]));
results.allPass = Object.values(checks).every(Boolean);

console.log(JSON.stringify(results, null, 2));

await browser.close();
process.exit(results.allPass ? 0 : 1);
