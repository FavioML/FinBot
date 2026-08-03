// Verifica en PRODUCCION que una transaccion con `monto_pen = NULL` ya no tira
// el dashboard al error boundary, y que se pinta honesta (monto original con su
// moneda) en vez de "S/ 0.00".
//
// El usuario QA (ded7e219…) es dueño de la unica fila con monto_pen null de toda
// la DB ("QA AUDIT TRIGGER", PEN 1.23, 2026-08-01), asi que su dashboard ES el
// caso de reproduccion. No siembra ni borra nada: solo navega y lee.
//
// Uso: node qa-monto-nulo.mjs
// Salida: JSON con los checks + PNGs en SHOT_OUT (o cwd).

import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const APP = process.env.NETO_APP_URL || 'https://app.neto.pe';
const OUT = process.env.SHOT_OUT || process.cwd();

// La fila sembrada por el trigger de auditoria (migracion 055). Si algun dia se
// borra, este harness debe fallar ruidoso, no pasar por vacuidad.
const COMERCIO_NULO = 'QA AUDIT TRIGGER';
const ESPERADO = 'S/ 1.23';

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
const ref = new URL(SUPA).hostname.split('.')[0];
const cookieName = `sb-${ref}-auth-token`;

if (!SUPA || !ANON || !EMAIL || !PASSWORD) {
  console.error('Faltan credenciales en ~/.config/neto/qa.env');
  process.exit(2);
}

// Pre-vuelo: la fila nula tiene que seguir existiendo, si no el harness verde no
// significa nada (guard vacio).
const probe = await fetch(
  `${SUPA}/rest/v1/transacciones?select=id,monto,moneda,monto_pen,comercio&monto_pen=is.null`,
  { headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` } }
);
const filasNulas = await probe.json();
if (!Array.isArray(filasNulas) || filasNulas.length === 0) {
  console.error('PRE-VUELO FALLO: ya no hay ninguna fila con monto_pen null. Este test no probaria nada.');
  process.exit(2);
}

const grant = await fetch(`${SUPA}/auth/v1/token?grant_type=password`, {
  method: 'POST',
  headers: { apikey: ANON, 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
});
if (!grant.ok) {
  console.error('Password grant fallo:', grant.status, await grant.text());
  process.exit(2);
}
const session = await grant.json();

const value = 'base64-' + Buffer.from(JSON.stringify(session), 'utf8').toString('base64url');
const MAX = 3180;
const domain = new URL(APP).hostname;
const cookies = [];
if (value.length <= MAX) {
  cookies.push({ name: cookieName, value });
} else {
  for (let i = 0, p = 0; p < value.length; i++, p += MAX) {
    cookies.push({ name: `${cookieName}.${i}`, value: value.slice(p, p + MAX) });
  }
}

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1180, height: 1400 } });
await context.addCookies(
  cookies.map((c) => ({ ...c, domain, path: '/', httpOnly: false, secure: true, sameSite: 'Lax' }))
);
await context.addInitScript(() => {
  try {
    localStorage.setItem('neto_welcome_seen', '1');
    localStorage.setItem('neto_tour_v2', 'done');
    localStorage.setItem('neto-tour', 'done');
  } catch (e) {}
});

const page = await context.newPage();
const consoleErrors = [];
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text());
});
page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + String(e)));

const checks = [];
const add = (nombre, ok, detalle) => checks.push({ nombre, ok, detalle });

async function visitar(ruta, nombre) {
  // Doble carga: la primera puede pegarle a un cold start de Vercel.
  for (let intento = 0; intento < 2; intento++) {
    await page.goto(`${APP}${ruta}`, { waitUntil: 'domcontentloaded' });
    await page.getByText(/S\/\s*[\d,—]/).first().waitFor({ timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(3000);
    const q = await page.evaluate(() => {
      try {
        const p = JSON.parse(localStorage.getItem('neto-rq') || '{}');
        return (p?.clientState?.queries || []).length;
      } catch { return 0; }
    });
    if (q > 0) break;
  }
  const cuerpo = await page.evaluate(() => document.body.innerText);
  const roto = /Algo sali[óo] mal/i.test(cuerpo);
  add(`${nombre}: carga sin error boundary`, !roto, roto ? 'se mostro "Algo salio mal"' : ruta);
  await page.screenshot({ path: join(OUT, `monto-nulo-${nombre}.png`), fullPage: true });
  return cuerpo;
}

// 1) El dashboard — la pantalla que reventaba.
const dash = await visitar('/dashboard', 'dashboard');

// 2) La fila nula se pinta con su monto real, no con un cero inventado.
const filaVisible = dash.includes(COMERCIO_NULO);
add('dashboard: la transaccion con monto_pen null es visible', filaVisible, COMERCIO_NULO);

if (filaVisible) {
  const linea = dash.split('\n').find((l) => l.includes(COMERCIO_NULO)) || '';
  // El monto va en su propio nodo; buscamos en el bloque cercano.
  const idx = dash.indexOf(COMERCIO_NULO);
  const ventana = dash.slice(idx, idx + 200);
  add(
    'dashboard: pinta el monto original (no "S/ 0.00")',
    ventana.includes(ESPERADO) && !ventana.includes('S/ 0.00'),
    ventana.replace(/\n/g, ' | ').slice(0, 160)
  );
  add('dashboard: no pinta el guion de fallback en esta fila', !ventana.includes('S/ —'), linea.slice(0, 80));
}

// 3) Las otras pantallas que leen las mismas transacciones.
await visitar('/dashboard/transacciones', 'transacciones');
await visitar('/dashboard/reportes', 'reportes');
await visitar('/dashboard/presupuestos', 'presupuestos');

// 4) Ningun toLocaleString sobre null en consola.
const crashLocale = consoleErrors.filter((e) => /toLocaleString|Cannot read properties of null/.test(e));
add('sin TypeError de toLocaleString en consola', crashLocale.length === 0, crashLocale.slice(0, 3).join(' // '));

await browser.close();

const fallos = checks.filter((c) => !c.ok);
console.log(JSON.stringify({
  filasNulasEnDB: filasNulas.length,
  checks,
  consoleErrors: consoleErrors.slice(0, 10),
  resultado: fallos.length === 0 ? 'PASS' : 'FAIL',
}, null, 2));
process.exit(fallos.length === 0 ? 0 : 1);
