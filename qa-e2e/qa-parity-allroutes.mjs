// Free-vs-Pro parity sweep sobre TODAS las rutas del dashboard (hoy 13 barridas + 1 declarada
// sin barrer). Cuantas son no se escribe a mano: la referencia sale del arbol de `src/app/dashboard`
// y una ruta nueva sin clasificar es INCONCLUSO.
// For each plan, visits every route and captures:
//   - console errors + pageerrors
//   - 4xx/5xx responses
//   - QUE decidio el muro en esa ruta, y si el Paywall se pinto
//   - final URL (catch unexpected redirects)
// Usage: node qa-parity-allroutes.mjs free | pro   (el argumento es obligatorio; correr los dos)
//
// VEREDICTO. Hasta el 23-ago-2026 este archivo terminaba en `console.log(JSON.stringify(out))`
// y salía 0 pasara lo que pasara. El 22-ago un React #310 que mandaba /dashboard/presupuestos
// al error boundary estuvo ONCE DÍAS impreso en esta salida sin que nadie lo leyera: la
// regresión estaba medida y el harness igual decía que sí. Ahora cierra por `lib/veredicto.mjs`.
//
// EL MURO. Hasta el 26-ago-2026 las dos únicas afirmaciones eran de AUSENCIA (sin errores de
// consola sin explicar, sin 4xx/5xx sin explicar), y eso fallaba hacia la calma en la regresión
// exacta que este barrido está parado para ver: si el muro desapareciera para un free —la API
// deja de dar 402, el Paywall deja de renderizar— la página tendría MENOS errores y el harness
// saldría MÁS VERDE. La columna que le da el nombre al archivo era la única que no decidía nada.
//
// Lo que faltaba es la afirmación POSITIVA, y va en las DOS direcciones porque una sola deja
// pasar el caso que importa: el muro ESTÁ en las rutas de muro bajo free, y NO está en las
// exentas ni bajo pro. Ninguna corrida sola contesta la pregunta entera — la dirección de
// PRESENCIA solo la ejercita el plan `free`. Correr las dos.
//
// Se afirma sobre DOS señales del DOM, y hace falta que sean dos:
//   · `[data-muro]` — qué DECIDIÓ el shell (`dashboard-shell.tsx`). Sale de la misma
//     expresión que elige el render, así que no puede declarar una cosa y pintar otra.
//   · `[data-testid="paywall"]` — que el muro SE PINTÓ. Una declaración que nadie contrasta
//     contra el render es un guard midiéndose contra sí mismo.
//
// Por qué NO se busca por el copy: `text=/\bes Pro\b/` daba `false` en las 13 rutas del free y
// eso invitaba a concluir que el ProGate estaba roto. No lo estaba —el copy sigue siendo
// `{featureName} es Pro` en `components/shared/pro-gate.tsx`— lo que pasa es que `ContenidoOMuro`
// reemplaza el contenido ENTERO por <Paywall/> antes de que las ramas por-feature lleguen a
// evaluarse. O sea que lo que había que afirmar era el MURO, no el ProGate. El ProGate se afirma
// igual, pero donde sí es alcanzable (plan pro) y por testid, no por el título.

import { chromium } from 'playwright';
import { readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { cerrar } from './lib/veredicto.mjs';

const APP = 'https://app.neto.pe';
/** El separador de lineas, en una constante: escribirlo inline en cada plantilla invita a que un
 *  editor o un pipeline lo convierta en un salto de verdad y rompa el archivo. */
const SALTO = String.fromCharCode(10);
// Sin default a proposito. Con `|| 'pro'`, quien lo corriera sin argumento medía el plan que
// NO ejercita la dirección de presencia: el muro podía estar caído para todos los del muro y
// este barrido salía verde para siempre. Elegir el plan es parte de la pregunta.
const PLAN = String(process.argv[2] || '').toLowerCase();
if (PLAN !== 'free' && PLAN !== 'pro') {
  console.error('Uso: node qa-parity-allroutes.mjs free|pro');
  console.error('La dirección de PRESENCIA del muro solo la ejercita `free`; `pro` sola no contesta la pregunta. Correr las dos.');
  process.exit(2);
}
const P = PLAN === 'free' ? 'NETO_QA_FREE_' : 'NETO_QA_';
function le(p) { const e = {}; for (const l of readFileSync(p, 'utf8').split(/\r?\n/)) { const m = l.match(/^([A-Z0-9_]+)=(.*)$/); if (m) e[m[1]] = m[2]; } return e; }
const env = le(join(homedir(), '.config', 'neto', 'qa.env'));
const SUPA = env[P + 'URL'] || env.NETO_QA_URL, ANON = env[P + 'ANON'] || env.NETO_QA_ANON, EMAIL = env[P + 'EMAIL'], PASSWORD = env[P + 'PASSWORD'] || env.NETO_QA_PASSWORD;
if (!SUPA || !ANON || !EMAIL || !PASSWORD) { console.error(`Faltan credenciales ${P}* en ~/.config/neto/qa.env`); process.exit(2); }

// ── Precondición: el fixture tiene que estar del lado que dice ──────────────────────────────
//
// El usuario "QA Free" SE AUTO-DESTRUYE: el trial arranca con el PRIMER GASTO, así que cualquier
// harness que le registre uno le pone `plan='premium'` por 14 días. Y durante el trial `plan`
// vale `premium`, o sea que NO taparle el dashboard pasa a ser el comportamiento CORRECTO. Sin
// esta comprobación este barrido reportaría "el muro desapareció para un free" —lo más alarmante
// que puede decir— cada vez que alguien le registra un gasto de prueba. Ya pasó en
// `qa-espacios-gating-verify`: 5 rojas, ninguna real.
//
// El lado Pro tiene el mismo problema al revés: con el premium vencido, ver el Paywall en las 11
// rutas también es correcto.
//
// Es exit 2 y no exit 1 a propósito: con el fixture del lado equivocado no se midió nada.
const UID_ESPERADO = PLAN === 'free' ? env.NETO_QA_FREE_USUARIO_ID : env.NETO_QA_USUARIO_ID;
const SRK = env.SUPABASE_SERVICE_ROLE_KEY;
let precondicion = null, fixture = null;
if (!UID_ESPERADO || !SRK) {
  precondicion = `falta ${!UID_ESPERADO ? (PLAN === 'free' ? 'NETO_QA_FREE_USUARIO_ID' : 'NETO_QA_USUARIO_ID') : 'SUPABASE_SERVICE_ROLE_KEY'} en ~/.config/neto/qa.env: sin eso no se puede saber de qué lado está el fixture, y un fixture del lado equivocado convierte este barrido en un rojo inventado`;
} else {
  // Envuelto: un timeout de red acá salía como unhandled rejection, o sea exit 1 = REGRESIÓN,
  // justo lo contrario de lo que este bloque decide dos líneas más arriba.
  try {
    const r = await fetch(`${SUPA}/rest/v1/usuarios?id=eq.${UID_ESPERADO}&select=supabase_auth_id,plan,trial_estado,trial_vence,premium_vence`, { headers: { apikey: SRK, Authorization: `Bearer ${SRK}` } });
    const filas = r.ok ? await r.json().catch(() => null) : null;
    fixture = Array.isArray(filas) && filas.length === 1 ? filas[0] : null;
    if (!fixture) {
      precondicion = r.ok
        ? `la lectura del usuario QA ${PLAN} (${UID_ESPERADO}) devolvió ${Array.isArray(filas) ? filas.length : 'algo que no es una lista'} filas y se esperaba exactamente 1`
        : `no se pudo leer al usuario QA ${PLAN} (${UID_ESPERADO}): HTTP ${r.status}`;
    }
  } catch (e) {
    precondicion = `no se pudo leer al usuario QA ${PLAN} (${UID_ESPERADO}): ${String(e).split(SALTO)[0].slice(0, 160)}`;
  }
  if (!fixture || precondicion) {
    // el motivo ya está escrito
  } else if (PLAN === 'free' && fixture.plan !== 'free') {
    precondicion = `el usuario "QA Free" NO está en el muro: plan=${fixture.plan}, trial_estado=${fixture.trial_estado}`
      + (fixture.trial_vence ? `, vence ${fixture.trial_vence}` : '')
      + '. Durante el trial `plan` vale `premium`, así que NO taparle el dashboard es CORRECTO y las '
      + 'afirmaciones del muro no pueden decir nada. Alguien (probablemente otro harness) le registró '
      + `un gasto. Para volver a usarlo: UPDATE usuarios SET plan='free', trial_estado='vencido' WHERE id='${UID_ESPERADO}'`;
  } else if (PLAN === 'pro' && fixture.plan !== 'premium') {
    precondicion = `el usuario "QA Dashboard" (pro) NO tiene Pro: plan=${fixture.plan}, premium_vence=${fixture.premium_vence}. `
      + 'Con el premium vencido el muro le tapa las 11 rutas y eso es CORRECTO, así que este barrido no puede '
      + `afirmar nada. Para restaurarlo: UPDATE usuarios SET plan='premium', premium_vence=now()+interval '365 days' WHERE id='${UID_ESPERADO}'`;
  }
}

const ref = new URL(SUPA).hostname.split('.')[0], cn = `sb-${ref}-auth-token`;
const g = await fetch(`${SUPA}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: EMAIL, password: PASSWORD }) });
// Sin sesion, las 13 rutas rebotan a /login y el barrido mediria el login trece veces. Eso es
// no haber mirado nada, no "todo bien": se corta aca con exit 2 y el motivo a la vista.
if (!g.ok) { console.error('Password grant fallo:', g.status, await g.text()); process.exit(2); }
const s = await g.json();
// El UID del fixture y las credenciales del login son DOS entradas distintas de qa.env, y nada
// las ataba: si divergen, la precondición valida el plan del usuario A y el navegador mide al
// usuario B — el guard midiendo un sujeto distinto del que afirma. Se cruzan acá, contra el
// `supabase_auth_id` de la misma fila que se leyó.
if (!precondicion && fixture && fixture.supabase_auth_id !== (s.user && s.user.id)) {
  precondicion = `el fixture que se validó y la sesión que se va a medir NO son el mismo usuario: `
    + `${UID_ESPERADO} tiene supabase_auth_id=${fixture.supabase_auth_id} y el login de ${EMAIL} devolvió `
    + `${s.user && s.user.id}. Revisar ${P}USUARIO_ID vs ${P}EMAIL en ~/.config/neto/qa.env`;
}
const v = 'base64-' + Buffer.from(JSON.stringify(s), 'utf8').toString('base64url');
const MAX = 3180, domain = new URL(APP).hostname, ck = [];
if (v.length <= MAX) ck.push({ name: cn, value: v }); else for (let i = 0, p = 0; p < v.length; i++, p += MAX) ck.push({ name: `${cn}.${i}`, value: v.slice(p, p + MAX) });

const br = await chromium.launch();
const ctx = await br.newContext({ viewport: { width: 1280, height: 1600 } });
await ctx.addCookies(ck.map(c => ({ name: c.name, value: c.value, domain, path: '/', httpOnly: false, secure: true, sameSite: 'Lax' })));
await ctx.addInitScript(() => { try { localStorage.setItem('neto_tour_v2', 'true'); localStorage.setItem('neto_welcome_seen', '1'); } catch {} });
const page = await ctx.newPage();

// La tercera columna es la CLASE de la ruta frente al muro, y es obligatoria: sin ella una ruta
// nueva entraría al barrido sin que nadie decidiera si se tapa o no, y pasaría por el lado
// silencioso. La lista de exentas la declara ESTE archivo a propósito, en vez de derivarla de
// `dashboard-shell.tsx`: es la afirmación independiente de lo que el producto quiere. Si alguien
// agrega una exención allá y no acá, el barrido sale rojo nombrando la ruta — que es exactamente
// la revisión que una exención nueva merece.
const ROUTES = [
  ['overview', '/dashboard', 'muro'],
  ['transacciones', '/dashboard/transacciones', 'muro'],
  ['presupuestos', '/dashboard/presupuestos', 'muro'],
  ['planes', '/dashboard/planes', 'muro'],
  ['deudas', '/dashboard/deudas', 'muro'],
  ['suscripciones', '/dashboard/suscripciones', 'muro'],
  ['reportes', '/dashboard/reportes', 'muro'],
  ['score', '/dashboard/score', 'muro'],
  ['alertas', '/dashboard/alertas', 'muro'],
  ['espacios', '/dashboard/espacios', 'muro'],
  ['logros', '/dashboard/logros', 'muro'],
  // Exentas a propósito: `/dashboard/pro` es el camino de salida (taparlo sería cerrar la puerta
  // de pagar) y `/dashboard/configuracion` no tiene data financiera acumulada.
  ['configuracion', '/dashboard/configuracion', 'exenta'],
  ['pro', '/dashboard/pro', 'exenta'],
];

// El piso de cobertura se medía contra la tabla que el propio archivo declara, así que recortar
// `ROUTES` a una ruta de cada clase salía OK con 4 afirmaciones verdes mientras el encabezado
// seguía prometiendo 13. Y una ruta NUEVA entraba al dashboard sin que nadie la barriera: así se
// quedó afuera `/dashboard/espacios/[id]`, que es justo la pantalla donde el muro de UI es lo
// único que protege (las rutas de `/api/spaces/*` autorizan por membresía, no por `requireLectura`).
//
// Ahora la referencia sale del ÁRBOL: cada `page.tsx` bajo `src/app/dashboard/` tiene que estar
// barrido o declarado en `SIN_BARRER` con su motivo. Una ruta nueva sin decidir es INCONCLUSO.
const RAIZ_RUTAS = join(new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), '..', 'webapp', 'src', 'app', 'dashboard');
function rutasDelArbol(dir, prefijo = '/dashboard') {
  const encontradas = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isFile() && e.name === 'page.tsx') encontradas.push(prefijo);
    else if (e.isDirectory() && !e.name.startsWith('_')) encontradas.push(...rutasDelArbol(join(dir, e.name), `${prefijo}/${e.name}`));
  }
  return encontradas;
}

// Declaradas y NO barridas. Cada una es una decisión, no un olvido.
const SIN_BARRER = {
  // Ruta dinámica: barrerla pide un id de espacio del usuario QA, y sembrarlo es escribir en
  // producción. Hoy `ContenidoOMuro` la tapa igual (cuelga del mismo layout), pero eso NO está
  // medido. Anotado en docs/DEFECTOS.md.
  '/dashboard/espacios/[id]': 'ruta dinámica: necesita un id de espacio sembrado para el usuario QA',
};

/** Qué `data-muro` corresponde a esta clase de ruta bajo este plan. */
const esperadoDelMuro = (clase) => (clase === 'exenta' ? 'exenta' : PLAN === 'free' ? 'muro' : 'contenido');

// El piso ABSOLUTO, contra el árbol y no contra la tabla. Sin esto, recortar `ROUTES` a una ruta
// de cada clase salía OK con cuatro afirmaciones verdes mientras el encabezado seguía prometiendo
// trece, y una ruta nueva del dashboard entraba sin que nadie decidiera si se tapa.
let desajusteDeArbol = null;
let enElArbol = [];
try {
  enElArbol = rutasDelArbol(RAIZ_RUTAS);
  const enLaTabla = new Set(ROUTES.map(([, ruta]) => ruta));
  const sinDecidir = enElArbol.filter((r) => !enLaTabla.has(r) && !(r in SIN_BARRER));
  const fantasmas = [...enLaTabla].filter((r) => !enElArbol.includes(r));
  if (sinDecidir.length) desajusteDeArbol = `hay rutas del dashboard que este barrido no mira y nadie declaró: ${sinDecidir.join(', ')}. Agregarlas a ROUTES con su clase, o a SIN_BARRER con el motivo`;
  else if (fantasmas.length) desajusteDeArbol = `la tabla nombra rutas que ya no existen en el árbol: ${fantasmas.join(', ')}`;
} catch (e) {
  desajusteDeArbol = `no se pudo leer el árbol de rutas en ${RAIZ_RUTAS}: ${String(e).split(SALTO)[0].slice(0, 140)}. Sin esa referencia el piso de cobertura se mide contra la tabla que el propio archivo declara, que es no tener piso`;
}

// El muro tiene su propio piso, y por CLASE. Contar solo el total dejaría pasar una tabla
// recortada a puras exentas: el barrido diría "todo medido" sin haber ejercitado nunca la
// dirección de PRESENCIA, que es la que ve la regresión. Y una ruta puede estar visitada y sana
// —dos afirmaciones verdes— con el muro sin medir; sin este piso eso sale OK.

// Copiado TAL CUAL de qa-planning-sweep.mjs. Es el mismo criterio en los dos barridos a
// proposito: dos definiciones de "que ruido explica el muro" divergen sin que nadie lo note,
// y la que quede floja excusa un error real.
//
// Angosto en DOS formas: la lista de consola trae "Failed to load resource: ... 402" y la de
// respuestas "402 GET /api/x". Un `\b402\b` suelto excusaria un error de JS que lo mencione.
const esperadoPorGating = (l) => PLAN === 'free' &&
  (/Failed to load resource.*\b(402|403)\b/.test(l) || /^\s*(402|403)\s/.test(l));

const out = { plan: PLAN, fixture, arbol: { enElArbol, sinBarrer: Object.keys(SIN_BARRER) }, routes: {} };
for (const [name, path, clase] of ROUTES) {
  const consoleErrors = [], failed = [];
  const onConsole = (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200)); };
  const onPageErr = (e) => consoleErrors.push('PAGEERROR: ' + String(e).slice(0, 200));
  const onResp = (r) => { const u = r.url(); if (r.status() >= 400 && (u.includes('/api/') || u.includes(domain))) failed.push(`${r.status()} ${r.request().method()} ${u.replace(APP, '')}`); };
  page.on('console', onConsole); page.on('pageerror', onPageErr); page.on('response', onResp);

  // El `.catch()` que se tragaba el error de navegacion dejaba la ruta con listas vacias, o
  // sea indistinguible de una ruta sana. Ahora se guarda el motivo.
  let navErr = null;
  await page.goto(`${APP}${path}`, { waitUntil: 'domcontentloaded' }).catch((e) => { navErr = String(e).split(SALTO)[0].slice(0, 200); });
  // Wait for content to hydrate
  await page.waitForTimeout(4000);

  const finalUrl = page.url().replace(APP, '');
  // `enRuta` separa las dos formas de no haber medido: la navegacion que se cayo, y la que
  // llego a otra pantalla (un rebote a /login mide el login, no la ruta).
  const enRuta = finalUrl.replace(/\/$/, '') === path.replace(/\/$/, '');

  // ── Las dos señales del muro ────────────────────────────────────────────────────────────
  // `muroErr` no es un `.catch(() => {})`: guarda el MOTIVO, porque "no medí" y "medí y está
  // sano" se veían idénticos (los dos como un `false`) y esa era justo la confusión que dejaba
  // pasar la regresión.
  let muroEstado = null, paywalls = null, paywallSiguientes = null, muroErr = null, aparecio = false;
  if (!navErr && enRuta) {
    try {
      // `pendiente` NO emite marcador a propósito: mientras la lectura del usuario no resuelve,
      // el muro no decidió nada, y leer eso como "no hay muro" fabrica un verde falso. Si el
      // selector nunca aparece, la ruta queda SIN MEDIR con el motivo escrito.
      await page.waitForSelector('[data-muro]', { state: 'attached', timeout: 15000 });
      aparecio = true;
    } catch {
      muroErr = 'no apareció [data-muro] en 15s: el shell se quedó en `pendiente` (la lectura del usuario nunca resolvió) o no montó';
    }
    // El `$$eval` va en su PROPIO try: con uno solo, un fallo al leer el marcador quedaba
    // registrado con el motivo del `waitForSelector` — una causa inventada, que manda a buscar
    // donde no es. Un motivo falso es peor que no tener motivo.
    if (aparecio) {
      try {
        const vistos = await page.$$eval('[data-muro]', (els) => els.map((e) => e.getAttribute('data-muro')));
        if (vistos.length !== 1) muroErr = `se esperaba UN [data-muro] y hay ${vistos.length} (${vistos.join(', ')})`;
        else muroEstado = vistos[0];
      } catch (e) {
        muroErr = 'el marcador apareció pero no se pudo leer: ' + String(e).split(SALTO)[0].slice(0, 120);
      }
    }
    try {
      paywalls = await page.locator('[data-testid="paywall"]').count();
      // Lo que se renderiza DESPUÉS del muro. Las dos señales de arriba preguntan las dos por
      // PRESENCIA, así que un `{estado === 'muro' && <Paywall />}{children}` —una mutación de una
      // línea, plausible en cualquier refactor— las deja verdes con la página entera montada
      // debajo del paywall. Medido en las rutas de muro del free: 0 en 4 de 4 sondeadas.
      paywallSiguientes = paywalls > 0 ? await page.locator('[data-testid="paywall"] ~ *').count() : 0;
    } catch (e) {
      muroErr = muroErr || ('no se pudo contar [data-testid="paywall"]: ' + String(e).split(SALTO)[0].slice(0, 120));
      paywalls = null;
    }
  }

  // El ProGate por-feature. Por testid y no por el copy: `text=/\bes Pro\b/` deja de ver el día
  // que alguien reescribe el título, y un guard que deja de ver sale verde.
  let proGates = null, proGateLabels = [], proGateErr = null;
  if (!navErr && enRuta) {
    try {
      proGates = await page.locator('[data-testid="pro-gate"]').count();
      if (proGates > 0) {
        const textos = await page.locator('[data-testid="pro-gate"]').allInnerTexts();
        proGateLabels = [...new Set(textos.map((t) => t.replace(/\s+/g, ' ').trim().slice(0, 80)))].slice(0, 4);
      }
    } catch (e) {
      proGates = null;
      proGateErr = 'no se pudo contar [data-testid="pro-gate"]: ' + String(e).split(SALTO)[0].slice(0, 120);
    }
  }

  out.routes[name] = {
    path,
    clase,
    navErr,
    enRuta,
    finalUrl,
    muroEstado,
    muroEsperado: esperadoDelMuro(clase),
    paywalls,
    muroErr,
    paywallSiguientes,
    proGates,
    proGateLabels,
    proGateErr,
    consoleErrors: [...new Set(consoleErrors)],
    failed: [...new Set(failed)].filter(f => !esperadoPorGating(f)),
    rawFailed: [...new Set(failed)],
  };

  page.off('console', onConsole); page.off('pageerror', onPageErr); page.off('response', onResp);
}

console.log(JSON.stringify(out, null, 2));
// Envuelto: si `close()` lanza, el bloque del veredicto ni corre y la corrida sale como fallo
// desconocido. Cerrar el navegador no es parte de la pregunta.
await br.close().catch(() => {});

// El fixture se lee al empezar, y el barrido dura 13 rutas x (4s + hasta 15s). El motivo por el
// que puede cambiar —otro harness que le registre un gasto al usuario QA Free y le arranque el
// trial— puede ocurrir DURANTE la corrida, y ahí las 11 afirmaciones de muro salen rojas: el
// rojo inventado que la precondición existe para evitar. Se re-lee y, si se movió, se degrada.
if (!precondicion && fixture) {
  try {
    const r2 = await fetch(`${SUPA}/rest/v1/usuarios?id=eq.${UID_ESPERADO}&select=plan,trial_estado`, { headers: { apikey: SRK, Authorization: `Bearer ${SRK}` } });
    const f2 = r2.ok ? (await r2.json().catch(() => null)) : null;
    const ahora = Array.isArray(f2) && f2.length === 1 ? f2[0] : null;
    out.fixtureAlCerrar = ahora;
    if (ahora && ahora.plan !== fixture.plan) {
      precondicion = `el fixture cambió DURANTE la corrida: empezó en plan=${fixture.plan} y terminó en plan=${ahora.plan}`
        + ` (trial_estado=${ahora.trial_estado}). Lo medido es una mezcla de los dos lados, así que no afirma nada. Volver a correrlo.`;
    }
  } catch {
    // No poder re-leerlo no invalida lo medido: la lectura del principio sí se hizo.
    out.fixtureAlCerrar = 'no se pudo re-leer';
  }
}

// -- Veredicto ---------------------------------------------------------------
// Se afirma POR RUTA y no en un contador global: saber CUAL de las 13 se rompio es lo que
// hubiera hecho visible el React #310 de presupuestos el primer dia en vez de el onceavo.
const fallas = [];
let medidos = 0;
const afirmar = (ok, msg) => { medidos++; if (!ok) fallas.push(msg); };

let visitadas = 0;
const noVisitadas = [];
const sinMedir = [];
const muroMedidoPorClase = { muro: 0, exenta: 0 };
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

  // ── El muro, en las dos direcciones ─────────────────────────────────────────────────────
  // Con el fixture del lado equivocado no se afirma NADA acá: sería un rojo inventado. Lo
  // levanta el inconcluso de más abajo.
  if (precondicion) {
    // nada que afirmar sobre el muro en esta corrida
  } else if (d.muroEstado === null || d.paywalls === null) {
    sinMedir.push(`${ruta} (${d.muroErr || 'sin motivo registrado'})`);
  } else if (d.muroEstado === 'sin-usuario') {
    // El shell no pudo decidir: `useUser` se cayó y ni tapa ni destapa. No es "no hay muro".
    sinMedir.push(`${ruta} (el shell quedó en 'sin-usuario': la lectura del usuario se cayó, así que el muro no llegó a decidir)`);
  } else {
    const esperado = d.muroEsperado;
    afirmar(
      d.muroEstado === esperado,
      `${d.path}: el muro decidió '${d.muroEstado}' y esa ruta es de clase '${d.clase}' bajo plan ${PLAN}, o sea que se esperaba '${esperado}'`,
    );
    // Contra el ESPERADO y no contra `muroEstado`: comparar el render con la decisión observada
    // sale en verde cuando las dos están mal juntas, que es la tautología disfrazada de rigor.
    const debePintar = esperado === 'muro';
    afirmar(
      d.paywalls === (debePintar ? 1 : 0),
      `${d.path}: ${d.paywalls} Paywall pintado(s) y bajo plan ${PLAN} esa ruta de clase '${d.clase}' esperaba ${debePintar ? 1 : 0}`,
    );
    if (debePintar) {
      // El muro REEMPLAZA el contenido, no se le pone encima. Sin esta línea, las otras dos
      // —que preguntan las dos por presencia— salen verdes con la página entera montada debajo.
      afirmar(
        d.paywallSiguientes === 0,
        `${d.path}: el muro se pintó pero quedaron ${d.paywallSiguientes} elemento(s) renderizados DESPUÉS de él; el muro reemplaza el contenido, no se le superpone`,
      );
      // Y el 402 tiene que EXISTIR, no solo estar excusado. `esperadoPorGating` lo perdona; nadie
      // lo exigía, así que sacar `requireLectura` de la API dejaba este barrido MÁS verde — el
      // mismo fallo hacia la calma que el encabezado dice haber cerrado, un piso más abajo.
      if (PLAN === 'free') {
        afirmar(
          d.rawFailed.some((l) => /^402 /.test(l)),
          `${d.path}: bajo free no se observó NINGÚN 402; el muro de UI se pintó pero la API no cobró (¿se cayó requireLectura?) - observado: ${d.rawFailed.join(' | ') || '(nada)'}`,
        );
        // Y solo el del bootstrap: con el contenido montado debajo del muro, los hooks de la
        // página disparan sus propias lecturas gateadas y aparecen más 402. Medido: 1 en 13 de 13.
        afirmar(
          d.rawFailed.length === 1,
          `${d.path}: bajo el muro se observaron ${d.rawFailed.length} respuestas gateadas y se esperaba exactamente la del bootstrap; si son MÁS, la página disparó sus propias lecturas (o sea que su contenido se montó igual) - ${d.rawFailed.join(' | ') || '(nada)'}`,
        );
      }
    }
    muroMedidoPorClase[d.clase]++;
  }

  // El ProGate por-feature solo es AFIRMABLE del lado pro: a un Pro pagado no se le cierra
  // ninguna feature. Del lado free no dice nada —el Paywall reemplaza el contenido entero antes
  // de que las ramas por-feature se evalúen— así que ahí queda como observación.
  if (PLAN === 'pro') {
    if (d.proGates === null) sinMedir.push(`${ruta} (${d.proGateErr || 'no se pudo contar [data-testid="pro-gate"]'})`);
    else afirmar(d.proGates === 0, `${d.path}: ${d.proGates} ProGate cerrado(s) para un Pro pagado - ${d.proGateLabels.join(' | ')}`);
  }
}

// Piso de antivacuidad PROPIO del barrido, ademas del de cerrar(). El generico solo mira que
// haya habido alguna afirmacion: con 12 rutas caidas y 1 sana este harness saldria verde
// diciendo "2 afirmaciones OK". La promesa aca es la COBERTURA de las 13, asi que medir menos
// no es un OK mas chico, es no haber contestado la pregunta.
const esperadasPorClase = { muro: 0, exenta: 0 };
for (const [, , clase] of ROUTES) esperadasPorClase[clase]++;

const inconcluso =
  precondicion
    ? precondicion
    : desajusteDeArbol
    ? desajusteDeArbol
    : esperadasPorClase.muro === 0 || esperadasPorClase.exenta === 0
      ? `la tabla de rutas perdió una de las dos direcciones: ${esperadasPorClase.muro} de muro y ${esperadasPorClase.exenta} exentas. Con una sola clase el barrido no puede afirmar la paridad`
      : visitadas < ROUTES.length
        ? `solo se visitaron ${visitadas} de ${ROUTES.length} rutas en ${PLAN}: ${noVisitadas.join(', ')}`
        : muroMedidoPorClase.muro < esperadasPorClase.muro || muroMedidoPorClase.exenta < esperadasPorClase.exenta
          ? `el muro se midió en ${muroMedidoPorClase.muro}/${esperadasPorClase.muro} rutas de muro y ${muroMedidoPorClase.exenta}/${esperadasPorClase.exenta} exentas: ${sinMedir.join(', ')}`
          : sinMedir.length
            ? `quedaron señales sin medir: ${sinMedir.join(', ')}`
            : null;

cerrar({ nombre: `PARITY-ALLROUTES ${PLAN.toUpperCase()}`, fallas, medidos, inconcluso });
