// Free-vs-Pro parity sweep over ALL 13 dashboard routes.
// For each plan, visits every route and captures:
//   - console errors + pageerrors
//   - 4xx/5xx responses
//   - whether a ProGate ("<feature> es Pro") lock is shown on the page
//   - final URL (catch unexpected redirects)
// Usage: node qa-parity-allroutes.mjs pro | free   (run both, diff the ProGate columns)
//
// VEREDICTO. Hasta el 23-ago-2026 este archivo terminaba en `console.log(JSON.stringify(out))`
// y salía 0 pasara lo que pasara. El 22-ago un React #310 que mandaba /dashboard/presupuestos
// al error boundary estuvo ONCE DÍAS impreso en esta salida sin que nadie lo leyera: la
// regresión estaba medida y el harness igual decía que sí. Ahora cierra por `lib/veredicto.mjs`.

import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { cerrar } from './lib/veredicto.mjs';

const APP = 'https://app.neto.pe';
const PLAN = (process.argv[2] || 'pro').toLowerCase();
const P = PLAN === 'free' ? 'NETO_QA_FREE_' : 'NETO_QA_';
function le(p) { const e = {}; for (const l of readFileSync(p, 'utf8').split(/\r?\n/)) { const m = l.match(/^([A-Z0-9_]+)=(.*)$/); if (m) e[m[1]] = m[2]; } return e; }
const env = le(join(homedir(), '.config', 'neto', 'qa.env'));
const SUPA = env[P + 'URL'] || env.NETO_QA_URL, ANON = env[P + 'ANON'] || env.NETO_QA_ANON, EMAIL = env[P + 'EMAIL'], PASSWORD = env[P + 'PASSWORD'] || env.NETO_QA_PASSWORD;
if (!SUPA || !ANON || !EMAIL || !PASSWORD) { console.error(`Faltan credenciales ${P}* en ~/.config/neto/qa.env`); process.exit(2); }
const ref = new URL(SUPA).hostname.split('.')[0], cn = `sb-${ref}-auth-token`;
const g = await fetch(`${SUPA}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: EMAIL, password: PASSWORD }) });
// Sin sesion, las 13 rutas rebotan a /login y el barrido mediria el login trece veces. Eso es
// no haber mirado nada, no "todo bien": se corta aca con exit 2 y el motivo a la vista.
if (!g.ok) { console.error('Password grant fallo:', g.status, await g.text()); process.exit(2); }
const s = await g.json();
const v = 'base64-' + Buffer.from(JSON.stringify(s), 'utf8').toString('base64url');
const MAX = 3180, domain = new URL(APP).hostname, ck = [];
if (v.length <= MAX) ck.push({ name: cn, value: v }); else for (let i = 0, p = 0; p < v.length; i++, p += MAX) ck.push({ name: `${cn}.${i}`, value: v.slice(p, p + MAX) });

const br = await chromium.launch();
const ctx = await br.newContext({ viewport: { width: 1280, height: 1600 } });
await ctx.addCookies(ck.map(c => ({ name: c.name, value: c.value, domain, path: '/', httpOnly: false, secure: true, sameSite: 'Lax' })));
await ctx.addInitScript(() => { try { localStorage.setItem('neto_tour_v2', 'true'); localStorage.setItem('neto_welcome_seen', '1'); } catch {} });
const page = await ctx.newPage();

const ROUTES = [
  ['overview', '/dashboard'],
  ['transacciones', '/dashboard/transacciones'],
  ['presupuestos', '/dashboard/presupuestos'],
  ['planes', '/dashboard/planes'],
  ['deudas', '/dashboard/deudas'],
  ['suscripciones', '/dashboard/suscripciones'],
  ['reportes', '/dashboard/reportes'],
  ['score', '/dashboard/score'],
  ['alertas', '/dashboard/alertas'],
  ['espacios', '/dashboard/espacios'],
  ['logros', '/dashboard/logros'],
  ['configuracion', '/dashboard/configuracion'],
  ['pro', '/dashboard/pro'],
];

// Copiado TAL CUAL de qa-planning-sweep.mjs. Es el mismo criterio en los dos barridos a
// proposito: dos definiciones de "que ruido explica el muro" divergen sin que nadie lo note,
// y la que quede floja excusa un error real.
//
// Angosto en DOS formas: la lista de consola trae "Failed to load resource: ... 402" y la de
// respuestas "402 GET /api/x". Un `\b402\b` suelto excusaria un error de JS que lo mencione.
const esperadoPorGating = (l) => PLAN === 'free' &&
  (/Failed to load resource.*\b(402|403)\b/.test(l) || /^\s*(402|403)\s/.test(l));

const out = { plan: PLAN, routes: {} };
for (const [name, path] of ROUTES) {
  const consoleErrors = [], failed = [];
  const onConsole = (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200)); };
  const onPageErr = (e) => consoleErrors.push('PAGEERROR: ' + String(e).slice(0, 200));
  const onResp = (r) => { const u = r.url(); if (r.status() >= 400 && (u.includes('/api/') || u.includes(domain))) failed.push(`${r.status()} ${r.request().method()} ${u.replace(APP, '')}`); };
  page.on('console', onConsole); page.on('pageerror', onPageErr); page.on('response', onResp);

  // El `.catch()` que se tragaba el error de navegacion dejaba la ruta con listas vacias, o
  // sea indistinguible de una ruta sana. Ahora se guarda el motivo.
  let navErr = null;
  await page.goto(`${APP}${path}`, { waitUntil: 'domcontentloaded' }).catch((e) => { navErr = String(e).split('\n')[0].slice(0, 200); });
  // Wait for content to hydrate
  await page.waitForTimeout(4000);

  // ProGate lock present? (the ProGate component renders "<X> es Pro")
  const proGateCount = await page.locator('text=/\\bes Pro\\b/').count().catch(() => 0);
  const proGateLabels = proGateCount > 0
    ? await page.locator('text=/\\bes Pro\\b/').allInnerTexts().catch(() => [])
    : [];

  const finalUrl = page.url().replace(APP, '');
  out.routes[name] = {
    path,
    navErr,
    // `enRuta` separa las dos formas de no haber medido: la navegacion que se cayo, y la que
    // llego a otra pantalla (un rebote a /login mide el login, no la ruta).
    enRuta: finalUrl.replace(/\/$/, '') === path.replace(/\/$/, ''),
    finalUrl,
    proGate: proGateCount > 0,
    proGateLabels: [...new Set(proGateLabels.map(t => t.replace(/\s+/g, ' ').trim()))].slice(0, 4),
    consoleErrors: [...new Set(consoleErrors)],
    failed: [...new Set(failed)].filter(f => !esperadoPorGating(f)),
    rawFailed: [...new Set(failed)],
  };

  page.off('console', onConsole); page.off('pageerror', onPageErr); page.off('response', onResp);
}

console.log(JSON.stringify(out, null, 2));
await br.close();

// -- Veredicto ---------------------------------------------------------------
// Se afirma POR RUTA y no en un contador global: saber CUAL de las 13 se rompio es lo que
// hubiera hecho visible el React #310 de presupuestos el primer dia en vez de el onceavo.
const fallas = [];
let medidos = 0;
const afirmar = (ok, msg) => { medidos++; if (!ok) fallas.push(msg); };

let visitadas = 0;
const noVisitadas = [];
for (const [ruta, d] of Object.entries(out.routes)) {
  if (d.navErr) { noVisitadas.push(`${ruta} (no cargo: ${d.navErr})`); continue; }
  if (!d.enRuta) {
    // Llego a OTRA pantalla. Eso si esta medido -la URL final es una observacion- asi que es
    // falla y no incertidumbre, y por la precedencia de cerrar() gana sobre el inconcluso.
    afirmar(false, `${d.path}: redirigio a ${d.finalUrl}`);
    noVisitadas.push(`${ruta} (redirigio a ${d.finalUrl})`);
    continue;
  }
  visitadas++;
  const cons = (d.consoleErrors || []).filter((l) => !esperadoPorGating(l));
  afirmar(cons.length === 0, `${d.path}: ${cons.length} errores de consola no explicados por el gating - ${cons.slice(0, 2).join(' | ')}`);
  afirmar(d.failed.length === 0, `${d.path}: ${d.failed.length} respuestas 4xx/5xx no explicadas por el gating - ${d.failed.slice(0, 2).join(' | ')}`);
}

// Piso de antivacuidad PROPIO del barrido, ademas del de cerrar(). El generico solo mira que
// haya habido alguna afirmacion: con 12 rutas caidas y 1 sana este harness saldria verde
// diciendo "2 afirmaciones OK". La promesa aca es la COBERTURA de las 13, asi que medir menos
// no es un OK mas chico, es no haber contestado la pregunta.
const inconcluso = visitadas < ROUTES.length
  ? `solo se visitaron ${visitadas} de ${ROUTES.length} rutas en ${PLAN}: ${noVisitadas.join(', ')}`
  : null;

cerrar({ nombre: `PARITY-ALLROUTES ${PLAN.toUpperCase()}`, fallas, medidos, inconcluso });
