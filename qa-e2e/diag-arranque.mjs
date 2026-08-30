// Censo de peticiones del arranque del dashboard autenticado, con A/B interleaved.
//
// `diag-load.mjs` reporta las 20 peticiones mas LENTAS de una carga; esto cuenta CUANTAS
// de cada clase y sobre varias cargas, que es la pregunta del punto 2 del item 16 del
// backlog de confiabilidad ("4 llamadas a /auth/v1/user, mas el prefetch del menu").
// La primera corrida contra produccion, el 30-ago-2026, encontro 24 prefetch RSC por
// carga donde la nota decia 5.
//
// Interleaved cuando hay mas de un target, y por el mismo motivo que `ab-endpoint`:
// la dispersion entre contextos limpios sobre la MISMA build fue de 2.7 a 11.7 s, asi
// que medir A durante un rato y B despues confunde el cambio con la deriva del rato.
// Cada ronda toca todos los targets, rotando el orden.
//
// uso: node diag-arranque.mjs <rondas> <url> [<url> ...]
//      node diag-arranque.mjs 4 https://app.neto.pe https://<preview>.vercel.app
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const RONDAS = Number(process.argv[2] || 3);
const TARGETS = (process.argv.slice(3).length ? process.argv.slice(3) : ['https://app.neto.pe'])
  .map((u) => u.replace(/\/$/, ''));

function loadEnv(p) { const e = {}; for (const l of readFileSync(p, 'utf8').split(/\r?\n/)) { const m = l.match(/^([A-Z0-9_]+)=(.*)$/); if (m) e[m[1]] = m[2]; } return e; }
const env = loadEnv(join(homedir(), '.config', 'neto', 'qa.env'));
const SUPA = env.NETO_QA_URL;
const grant = await fetch(`${SUPA}/auth/v1/token?grant_type=password`, {
  method: 'POST', headers: { apikey: env.NETO_QA_ANON, 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: env.NETO_QA_EMAIL, password: env.NETO_QA_PASSWORD }),
});
const session = await grant.json();
if (!session.access_token) { console.error('grant fallo'); process.exit(2); }
const ref = new URL(SUPA).hostname.split('.')[0];
const cookieName = `sb-${ref}-auth-token`;
const value = 'base64-' + Buffer.from(JSON.stringify(session), 'utf8').toString('base64url');
const MAX = 3180;
function cookiesPara(host) {
  const partes = [];
  if (value.length <= MAX) partes.push({ name: cookieName, value });
  else for (let i = 0, p = 0; p < value.length; i++, p += MAX) partes.push({ name: `${cookieName}.${i}`, value: value.slice(p, p + MAX) });
  return partes.map((k) => ({ ...k, domain: host, path: '/', httpOnly: false, secure: true, sameSite: 'Lax' }));
}

// Clases que interesan. El orden importa: la primera que matchea gana.
const CLASES = [
  ['auth/v1/user', /\/auth\/v1\/user/],
  ['auth/v1/token', /\/auth\/v1\/token/],
  ['postgrest usuarios', /\/rest\/v1\/usuarios/],
  ['postgrest otras', /\/rest\/v1\//],
  ['/api/dashboard', /\/api\/dashboard/],
  ['/api/ otras', /\/api\//],
  ['prefetch RSC', /_rsc=/],
  ['posthog', /posthog|i\.posthog\.com/],
];
function clasificar(url) {
  for (const [nombre, re] of CLASES) if (re.test(url)) return nombre;
  return null;
}

const browser = await chromium.launch();
const datos = new Map(); // url -> { tiempos: [], conteos: Map, primeraDespues: [] }
for (const t of TARGETS) datos.set(t, { tiempos: [], conteos: new Map(), tarde: [] });

async function unaCarga(app) {
  const context = await browser.newContext();
  await context.addCookies(cookiesPara(new URL(app).hostname));
  const page = await context.newPage();
  const conteo = new Map();
  const starts = new Map();
  const eventos = [];

  const t0 = Date.now();
  page.on('request', (r) => {
    starts.set(r, Date.now());
    const cl = clasificar(r.url());
    if (cl) {
      conteo.set(cl, (conteo.get(cl) || 0) + 1);
      // `desde` = cuando ARRANCO respecto del goto. Es lo que distingue "esta peticion
      // ya no existe" de "existe pero dejo de competir con el arranque", que es el
      // efecto que busca el diferido del prefetch y de PostHog.
      eventos.push({ cl, desde: Date.now() - t0, ms: null, r });
    }
  });
  page.on('requestfinished', (r) => {
    const s = starts.get(r); if (!s) return;
    const ev = eventos.find((e) => e.r === r);
    if (ev) ev.ms = Date.now() - s;
  });

  await page.goto(`${app}/dashboard`, { waitUntil: 'domcontentloaded' });
  let tt = null;
  for (let i = 0; i < 60; i++) {
    const has = await page.evaluate(() => /S\/\s*[\d,]+\.\d/.test(document.querySelector('main')?.innerText || ''));
    if (has) { tt = Date.now() - t0; break; }
    await page.waitForTimeout(200);
  }
  await page.waitForTimeout(3000); // dejar asentar lo diferido
  await context.close();
  return { tt, conteo, eventos };
}

const med = (a) => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length ? (s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2)) : null; };

for (let r = 0; r < RONDAS; r++) {
  const orden = TARGETS.map((_, i) => TARGETS[(i + r) % TARGETS.length]);
  for (const app of orden) {
    const { tt, conteo, eventos } = await unaCarga(app);
    const d = datos.get(app);
    d.tiempos.push(tt);
    for (const [k, v] of conteo) d.conteos.set(k, (d.conteos.get(k) || 0) + v);
    // Cuantas peticiones arrancaron DESPUES de que hubo dato en pantalla.
    if (tt != null) d.tarde.push(eventos.filter((e) => e.desde > tt).length);
    const resumen = [...conteo].map(([k, v]) => `${v}x${k.replace(/^\/api\//, '')}`).join(' ');
    console.log(`r${r + 1} ${new URL(app).hostname.slice(0, 32).padEnd(32)} ttd=${String(tt ?? 'NO').padStart(5)}  ${resumen}`);
  }
}
await browser.close();

console.log('');
for (const app of TARGETS) {
  const d = datos.get(app);
  const ok = d.tiempos.filter((t) => t != null);
  console.log(`== ${app}`);
  console.log(`   time-to-data: [${d.tiempos.join(', ')}]  mediana ${med(ok) ?? 'n/a'}  dispersion ${ok.length ? Math.max(...ok) - Math.min(...ok) : 'n/a'}`);
  for (const [nombre] of CLASES) {
    const n = d.conteos.get(nombre) || 0;
    if (n) console.log(`   ${(n / RONDAS).toFixed(1).padStart(5)} por carga  ${nombre}`);
  }
  if (d.tarde.length) console.log(`   peticiones que arrancan DESPUES del primer dato: [${d.tarde.join(', ')}]`);
}
