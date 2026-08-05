// Chequeo de solapamiento del botón "Cambiar" (Hueco 1.1) con los FAB flotantes
// (Agregar transacción + WhatsApp) en viewport MÓVIL. Mide intersección de rects
// en la posición natural de lectura (sección Cuentas conectadas visible).
//
// Usa el QA Pro user (whatsapp no-null -> muestra el botón "Cambiar").
// Usage: node qa-unlink-overlap.mjs

import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = process.env.NETO_APP_URL || 'https://app.neto.pe';
const HERE = dirname(fileURLToPath(import.meta.url));
function loadEnv(path) { const e = {}; for (const l of readFileSync(path, 'utf8').split(/\r?\n/)) { const m = l.match(/^([A-Z0-9_]+)=(.*)$/); if (m) e[m[1]] = m[2]; } return e; }
const env = loadEnv(join(homedir(), '.config', 'neto', 'qa.env'));
const SUPA = env.NETO_QA_URL, ANON = env.NETO_QA_ANON, EMAIL = env.NETO_QA_EMAIL, PASSWORD = env.NETO_QA_PASSWORD;
const cookieName = `sb-${new URL(SUPA).hostname.split('.')[0]}-auth-token`;

const grant = await fetch(`${SUPA}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: EMAIL, password: PASSWORD }) });
if (!grant.ok) { console.error('grant', grant.status); process.exit(2); }
const session = await grant.json();
const value = 'base64-' + Buffer.from(JSON.stringify(session), 'utf8').toString('base64url');
const MAX = 3180, domain = new URL(APP).hostname, parts = [];
if (value.length <= MAX) parts.push({ name: cookieName, value }); else for (let i = 0, p = 0; p < value.length; i++, p += MAX) parts.push({ name: `${cookieName}.${i}`, value: value.slice(p, p + MAX) });
const toAdd = parts.map((c) => ({ name: c.name, value: c.value, domain, path: '/', httpOnly: false, secure: true, sameSite: 'Lax' }));

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true });
await context.addInitScript(() => { try { localStorage.setItem('neto_welcome_seen', '1'); localStorage.setItem('neto_tour_v2', 'done'); } catch (e) {} });
await context.addCookies(toAdd);
const page = await context.newPage();

let loaded = false;
for (let a = 0; a < 2 && !loaded; a++) { await page.goto(`${APP}/dashboard/configuracion`, { waitUntil: 'domcontentloaded' }); loaded = await page.locator('#cuentas').first().waitFor({ timeout: 15000 }).then(() => true).catch(() => false); }
await page.evaluate(() => document.querySelectorAll('.fixed.inset-0.z-50').forEach((e) => e.remove()));

// PEOR CASO: scrollear para que el botón "Cambiar" caiga dentro de la banda
// vertical de los FAB (centro ~ a 108px del fondo del viewport).
await page.locator('#cuentas').scrollIntoViewIfNeeded();
await page.waitForTimeout(300);
await page.evaluate(() => {
  const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.trim().startsWith('Cambiar'));
  if (!btn) return;
  const scroller = document.querySelector('main.overflow-y-auto') || document.scrollingElement;
  const r = btn.getBoundingClientRect();
  // llevar el centro del botón a ~108px del fondo (centro de la banda del FAB)
  const target = window.innerHeight - 108;
  scroller.scrollTop += (r.top + r.height / 2) - target;
});
await page.waitForTimeout(500);

const rects = await page.evaluate(() => {
  const vis = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, inView: r.top < window.innerHeight && r.bottom > 0 }; };
  const cambiar = [...document.querySelectorAll('button')].find((b) => b.textContent.trim().startsWith('Cambiar'));
  // FABs fixed: el de Agregar (Plus) y el de WhatsApp (a[href*=wa]/aria WhatsApp)
  const fixedFabs = [...document.querySelectorAll('a,button')].filter((el) => {
    const cs = getComputedStyle(el); return cs.position === 'fixed' && el.getBoundingClientRect().width <= 64 && el.getBoundingClientRect().width >= 40;
  });
  return { cambiar: vis(cambiar), fabs: fixedFabs.map((f) => ({ label: f.getAttribute('aria-label') || f.textContent.trim().slice(0, 20), ...vis(f) })), vw: window.innerWidth, vh: window.innerHeight };
});

function intersect(a, b) {
  if (!a || !b) return null;
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  return ix > 0 && iy > 0 ? { ix, iy, area: ix * iy } : null;
}

const overlaps = (rects.fabs || []).map((f) => ({ label: f.label, hit: intersect(rects.cambiar, f) })).filter((o) => o.hit);
const result = {
  viewport: `${rects.vw}x${rects.vh}`,
  cambiarRect: rects.cambiar,
  fabs: rects.fabs,
  overlaps,
  cambiarEnPosicionLectura: rects.cambiar?.inView === true,
  haySolapamiento: overlaps.length > 0,
};

await page.screenshot({ path: join(HERE, 'unlink-mobile-overlap.png'), fullPage: false });
console.log(JSON.stringify(result, null, 2));
await browser.close();
process.exit(result.haySolapamiento ? 1 : 0);
