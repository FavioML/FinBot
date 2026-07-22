// Confirma que el bundle DESPLEGADO del dashboard contiene el throw de
// `fetchNetoUser` (commit c1befdc).
//
// Por que hace falta autenticarse: el string vive en `lib/hooks/use-user.ts`,
// que importa el dashboard, no /login. Un probe que mire los chunks de /login
// nunca lo va a encontrar por mas que el deploy este listo.
//
// Usage: node probe-deploy-fetchnetouser.mjs

import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const APP = process.env.NETO_APP_URL || 'https://app.neto.pe';
const AGUJA = 'No se pudo leer el usuario';

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
const ref = new URL(SUPA).hostname.split('.')[0];
const cookieName = `sb-${ref}-auth-token`;

const grant = await fetch(`${SUPA}/auth/v1/token?grant_type=password`, {
  method: 'POST',
  headers: { apikey: ANON, 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: env.NETO_QA_EMAIL, password: env.NETO_QA_PASSWORD }),
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
await context.addCookies(
  cookies.map((c) => ({ ...c, domain, path: '/', httpOnly: false, secure: true, sameSite: 'Lax' }))
);
// Overlays: se re-montan si se borran del DOM, hay que sembrarlos antes de cargar.
await context.addInitScript(() => {
  localStorage.setItem('neto_welcome_seen', '1');
  localStorage.setItem('neto_tour_v2', '1');
});

const page = await context.newPage();
const scripts = new Set();
page.on('response', (r) => {
  if (r.url().includes('/_next/static/') && r.url().endsWith('.js')) scripts.add(r.url());
});

await page.goto(`${APP}/dashboard`, { waitUntil: 'networkidle' });

const url = page.url();
let encontrado = null;
for (const s of scripts) {
  const res = await fetch(s);
  if ((await res.text()).includes(AGUJA)) { encontrado = s; break; }
}

await browser.close();

const out = {
  urlFinal: url,
  noExpulsado: !url.includes('/onboarding') && !url.includes('/login'),
  chunksCargados: scripts.size,
  bundleConElThrow: encontrado ? encontrado.replace(APP, '') : null,
  verdict: {
    'la sesion aterriza en el dashboard': !url.includes('/onboarding') && !url.includes('/login') ? 'PASS' : 'FAIL',
    'el bundle desplegado trae el throw de fetchNetoUser': encontrado ? 'PASS' : 'FAIL',
  },
};
console.log(JSON.stringify(out, null, 2));
process.exit(Object.values(out.verdict).every((v) => v === 'PASS') ? 0 : 1);
