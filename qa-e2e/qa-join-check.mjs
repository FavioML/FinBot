// Verifies collaborative join links render for an invited (unauthenticated) user.
// Generates invite codes on throwaway goal + debt as the PRO user, then opens
// /join/meta/[code] and /join/deuda/[code] in a COOKIELESS context (the invitee),
// checking the public preview renders (no 500, shows the item). Cleans up.
//
// POR QUE ASEVERA Y NO SOLO IMPRIME (22-ago-2026)
//
// Hasta hoy este harness imprimia un JSON y salia exit 0 SIEMPRE. La mitad de deudas
// nunca se ejercitaba: creaba la deuda con `tipo: 'debo'` y `POST /api/debts/invite`
// rechaza con 400 todo lo que no sea `me_deben`, asi que no habia `code`, el `if`
// saltaba la pantalla, y `R.joinDeudaPage` simplemente no aparecia en la salida. Un
// campo ausente se lee igual que uno que paso. Medido contra produccion ese dia:
// `debtInvite: { status: 400 }`, sin `joinDeudaPage`, exit 0.
//
// De ahi las dos reglas de abajo: el invite tiene que emitirse (200 + code), y la
// pantalla tiene que MOSTRAR los datos resueltos (acreedor y monto), no solo devolver
// 200. Sin la segunda, la pantalla de "Invitacion invalida o expirada" tambien pasa:
// es un 200 con un cuerpo que no le sirve de nada a quien abre el link.
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const APP = 'https://app.neto.pe';
const env = {};
for (const l of readFileSync(join(homedir(), '.config', 'neto', 'qa.env'), 'utf8').split(/\r?\n/)) {
  const m = l.match(/^([A-Z0-9_]+)=(.*)$/); if (m) env[m[1]] = m[2];
}
const SUPA = env.NETO_QA_URL, ANON = env.NETO_QA_ANON, ref = new URL(SUPA).hostname.split('.')[0];
const grant = await (await fetch(`${SUPA}/auth/v1/token?grant_type=password`, {
  method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: env.NETO_QA_EMAIL, password: env.NETO_QA_PASSWORD }),
})).json();
if (!grant.access_token) { console.error('grant fallido', JSON.stringify(grant).slice(0, 200)); process.exit(2); }
const value = 'base64-' + Buffer.from(JSON.stringify(grant), 'utf8').toString('base64url');
const domain = new URL(APP).hostname;
const cookie = { name: `sb-${ref}-auth-token`, value, domain, path: '/', secure: true, sameSite: 'Lax' };

// El monto de la deuda de prueba lo elige el harness, asi que es verdad de referencia
// propia: la asercion del monto no depende de leerle nada al producto.
const MONTO_DEUDA = 200;
const MONTO_ESPERADO = 'S/ 200.00'; // lo que `formatCurrency(200, 'PEN')` imprime

const fallos = [];
const exigir = (cond, msg) => { if (!cond) fallos.push(msg); return !!cond; };

const browser = await chromium.launch();
const authCtx = await browser.newContext();
await authCtx.addCookies([cookie]);
const authP = await authCtx.newPage();
await authP.goto(`${APP}/dashboard`, { waitUntil: 'domcontentloaded' });
const api = (path, opts) => authP.evaluate(async ({ path, opts }) => {
  const r = await fetch(path, opts); let b = null; try { b = await r.json(); } catch {}
  return { status: r.status, body: b };
}, { path, opts: opts || {} });

const R = {};
let gid = null, did = null;
try {
  // Throwaway goal + invite
  const g = await api('/api/goals', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nombre: 'QA_JOIN_DELETE_ME', monto_objetivo: 500, monto_actual: 100, icono: '\u{1F3AF}' }) });
  gid = g.body?.id;
  exigir(gid, `POST /api/goals no devolvio id (status ${g.status})`);
  const gInvite = await api('/api/goals/invite', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ meta_id: gid }) });
  R.goalInvite = { status: gInvite.status, code: gInvite.body?.invite_code, link: gInvite.body?.link };
  exigir(gInvite.status === 200, `POST /api/goals/invite respondio ${gInvite.status}, no 200: ${JSON.stringify(gInvite.body).slice(0, 160)}`);
  exigir(!!R.goalInvite.code, 'POST /api/goals/invite no devolvio invite_code: sin codigo la pantalla /join/meta no se abre y el resto del harness se saltea en silencio');

  // Throwaway debt + invite. `me_deben` NO es cosmetico: `/api/debts/invite` rechaza con
  // 400 cualquier otro tipo, y con 'debo' este bloque no emitia codigo nunca.
  const d = await api('/api/debts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tipo: 'me_deben', contraparte: 'QA_JOIN_DELETE_ME', monto_original: MONTO_DEUDA, moneda: 'PEN' }) });
  did = d.body?.id;
  exigir(did, `POST /api/debts no devolvio id (status ${d.status})`);
  const dInvite = await api('/api/debts/invite', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deuda_id: did }) });
  R.debtInvite = { status: dInvite.status, code: dInvite.body?.invite_code, link: dInvite.body?.link };
  exigir(dInvite.status === 200, `POST /api/debts/invite respondio ${dInvite.status}, no 200: ${JSON.stringify(dInvite.body).slice(0, 160)}`);
  exigir(!!R.debtInvite.code, 'POST /api/debts/invite no devolvio invite_code: sin codigo la pantalla /join/deuda no se abre y el harness sale verde sin haberla mirado');

  // Open join pages in cookieless (invitee) context
  const guestCtx = await browser.newContext();
  const guest = await guestCtx.newPage();
  const guestErrors = [];
  guest.on('console', (m) => { if (m.type() === 'error') guestErrors.push(m.text().slice(0, 200)); });
  guest.on('response', (r) => { if (r.status() >= 500 && r.url().includes(domain)) guestErrors.push(`5xx ${r.url().replace(APP, '')}`); });
  const cuerpo = async () => (await guest.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ');

  if (R.goalInvite.code) {
    await guest.goto(`${APP}/join/meta/${R.goalInvite.code}`, { waitUntil: 'domcontentloaded' });
    await guest.waitForTimeout(2500);
    const texto = await cuerpo();
    R.joinMetaPage = {
      httpOk: !guestErrors.some((e) => e.includes('/join/meta')),
      showsGoalName: texto.includes('QA_JOIN_DELETE_ME'),
      bodyText: texto.slice(0, 200),
    };
    exigir(R.joinMetaPage.httpOk, '/join/meta devolvio 5xx al invitado sin sesion');
    exigir(R.joinMetaPage.showsGoalName, `/join/meta no muestra el nombre de la meta al invitado sin sesion. Cuerpo: "${texto.slice(0, 200)}"`);
  }

  if (R.debtInvite.code) {
    // El acreedor lo resuelve el producto (es `usuarios.nombre` del dueno), asi que se lee
    // por el GET publico de la misma invitacion en vez de cablearlo. Lo que la asercion
    // prueba es que ESE dato llegue al HTML que ve el invitado: el guard estatico
    // `app/join/contenido-en-el-html.test.ts` mira la FORMA del componente, no el render.
    const vista = await (await fetch(`${APP}/api/debts/invite?code=${R.debtInvite.code}`)).json().catch(() => null);
    R.vistaDeuda = vista;
    const acreedor = vista?.acreedor;
    exigir(acreedor && acreedor !== 'Alguien', `GET /api/debts/invite no resolvio el acreedor (${JSON.stringify(vista).slice(0, 160)})`);

    await guest.goto(`${APP}/join/deuda/${R.debtInvite.code}`, { waitUntil: 'domcontentloaded' });
    await guest.waitForTimeout(2500);
    const texto = await cuerpo();
    R.joinDeudaPage = {
      httpOk: !guestErrors.some((e) => e.includes('/join/deuda')),
      showsAcreedor: !!acreedor && texto.includes(acreedor),
      showsMonto: texto.includes(MONTO_ESPERADO),
      showsInvalida: /invitacion invalida|invitación inválida/i.test(texto),
      bodyText: texto.slice(0, 200),
    };
    exigir(R.joinDeudaPage.httpOk, '/join/deuda devolvio 5xx al invitado sin sesion');
    exigir(!R.joinDeudaPage.showsInvalida, `/join/deuda le muestra "Invitacion invalida o expirada" a un invitado con un codigo recien emitido. Cuerpo: "${texto.slice(0, 200)}"`);
    exigir(R.joinDeudaPage.showsAcreedor, `/join/deuda no muestra el nombre del acreedor ("${acreedor}") al invitado sin sesion. Cuerpo: "${texto.slice(0, 200)}"`);
    exigir(R.joinDeudaPage.showsMonto, `/join/deuda no muestra el monto (${MONTO_ESPERADO}) al invitado sin sesion. Cuerpo: "${texto.slice(0, 200)}"`);
  }
  R.guestErrors = guestErrors;
} finally {
  // La limpieza corre aunque una asercion haya fallado: si no, cada corrida roja deja una
  // meta y una deuda QA_JOIN_DELETE_ME vivas en produccion.
  if (gid) R.cleanupGoal = (await api(`/api/goals?id=${gid}`, { method: 'DELETE' })).status;
  if (did) R.cleanupDebt = (await api(`/api/debts?id=${did}`, { method: 'DELETE' })).status;
  exigir(!gid || R.cleanupGoal === 200, `limpieza de la meta QA respondio ${R.cleanupGoal}`);
  exigir(!did || R.cleanupDebt === 200, `limpieza de la deuda QA respondio ${R.cleanupDebt}`);
  await browser.close();
}

console.log(JSON.stringify(R, null, 2));
if (fallos.length) {
  console.error('\nFALLOS:');
  for (const f of fallos) console.error(` - ${f}`);
  process.exit(1);
}
console.log('\nOK: /join/meta y /join/deuda renderizan los datos de la invitacion para un invitado sin sesion.');
