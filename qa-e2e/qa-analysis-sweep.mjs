// Adversarial E2E sweep of Neto's analysis flows on app.neto.pe (PROD).
// Routes: /dashboard/score, /dashboard/reportes, /dashboard/suscripciones, /dashboard/alertas
// Runs for pro|free. Forges the @supabase/ssr cookie (no magic link), neutralizes
// onboarding overlays via addInitScript, captures console + 4xx/5xx, intercepts
// /api/score and /api/alerts JSON to check plan gating (no factor leak for Free).
//
// Usage: node qa-analysis-sweep.mjs pro|free
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { cerrar } from './lib/veredicto.mjs';

const APP = 'https://app.neto.pe';
const PLAN = (process.argv[2] || 'pro').toLowerCase();
const P = PLAN === 'free' ? 'NETO_QA_FREE_' : 'NETO_QA_';
function le(p){const e={};for(const l of readFileSync(p,'utf8').split(/\r?\n/)){const m=l.match(/^([A-Z0-9_]+)=(.*)$/);if(m)e[m[1]]=m[2];}return e;}
const env = le(join(homedir(),'.config','neto','qa.env'));
const SUPA = env[P+'URL']||env.NETO_QA_URL, ANON = env[P+'ANON']||env.NETO_QA_ANON, EMAIL = env[P+'EMAIL'], PASSWORD = env[P+'PASSWORD']||env.NETO_QA_PASSWORD;
const ref = new URL(SUPA).hostname.split('.')[0], cn = `sb-${ref}-auth-token`;

const g = await fetch(`${SUPA}/auth/v1/token?grant_type=password`,{method:'POST',headers:{apikey:ANON,'Content-Type':'application/json'},body:JSON.stringify({email:EMAIL,password:PASSWORD})});
if(!g.ok){console.error('grant failed',g.status,await g.text());process.exit(2);}
const s = await g.json();
const v = 'base64-'+Buffer.from(JSON.stringify(s),'utf8').toString('base64url');
const MAX=3180, domain=new URL(APP).hostname, ck=[];
if(v.length<=MAX)ck.push({name:cn,value:v});else for(let i=0,p=0;p<v.length;i++,p+=MAX)ck.push({name:`${cn}.${i}`,value:v.slice(p,p+MAX)});

const br = await chromium.launch();
const ctx = await br.newContext({viewport:{width:1280,height:1600},acceptDownloads:true});
await ctx.addCookies(ck.map(c=>({name:c.name,value:c.value,domain,path:'/',httpOnly:false,secure:true,sameSite:'Lax'})));
await ctx.addInitScript(()=>{try{localStorage.setItem('neto_tour_v2','true');localStorage.setItem('neto_welcome_seen','1');}catch{}});

const pg = await ctx.newPage();
const consoleErrors = [], failed = [], apiJson = {};
pg.on('console', m=>{ if(m.type()==='error') consoleErrors.push(m.text().slice(0,200)); });
pg.on('response', async r=>{
  const u=r.url(), st=r.status();
  if(st>=400) failed.push(`${st} ${u.replace(APP,'')}`);
  try{
    if(u.includes('/api/score')||u.includes('/api/alerts')){
      const key=u.includes('/api/score')?(u.includes('history')?'score_history':'score'):'alerts';
      const ct=r.headers()['content-type']||'';
      if(ct.includes('json')) apiJson[key]={status:st, body: await r.json().catch(()=>null)};
    }
  }catch{}
});

const R = { plan: PLAN, routes: {} };
async function txt(){ return await pg.locator('main').innerText().catch(()=> ''); }
async function waitCurrency(t=15000){ await pg.getByText(/S\/\s*[\d.,]+/).first().waitFor({timeout:t}).catch(()=>{}); }

// ── SCORE ──
await pg.goto(`${APP}/dashboard/score`,{waitUntil:'domcontentloaded'});
await pg.getByRole('heading',{name:'Neto Score'}).first().waitFor({timeout:20000}).catch(()=>{});
await pg.waitForTimeout(3500);
{
  const t = await txt();
  const score = apiJson.score_history?.body?.score ?? apiJson.score?.body?.score ?? null;
  const factorsInBody = !!(apiJson.score_history?.body?.factors || apiJson.score?.body?.factors);
  // count visible factor rows with numeric value (breakdown) — Pro shows real, Free shows blur+lock
  const lockVisible = await pg.getByText('Desbloquea con Pro').first().isVisible().catch(()=>false);
  const tipsGateVisible = await pg.getByText('Tips personalizados').first().isVisible().catch(()=>false);
  R.routes.score = {
    heading: /Neto Score/.test(t),
    apiScore: score,
    factorsInApiBody: factorsInBody,
    breakdownLockVisible: lockVisible,
    hasEvolucion: /Evoluci/.test(t),
    hasTips: /Tips personalizados/.test(t),
    emptyState: /Aún no tienes un Neto Score/.test(t),
    len: t.length,
  };
}

// ── REPORTES ──
await pg.goto(`${APP}/dashboard/reportes`,{waitUntil:'domcontentloaded'});
await pg.waitForTimeout(4000);
await waitCurrency(8000);
{
  const t = await txt();
  const gateVisible = /Reportes PDF/.test(t) && /Ver planes|Desbloquea|Pro/.test(t);
  const pdfBtn = await pg.getByRole('button',{name:/PDF/}).first().isVisible().catch(()=>false);
  R.routes.reportes = {
    proGateFullPage: gateVisible && !pdfBtn,
    pdfButtonVisible: pdfBtn,
    hasIngresos: /Ingresos/.test(t),
    hasScoreFinanciero: /Score Financiero/.test(t),
    len: t.length,
  };
  // Try PDF download only if button present (Pro)
  if(pdfBtn){
    try{
      const dl = ctx.waitForEvent('download',{timeout:25000});
      await pg.getByRole('button',{name:/PDF/}).first().click();
      const d = await dl;
      R.routes.reportes.pdfDownloaded = true;
      R.routes.reportes.pdfFilename = d.suggestedFilename();
    }catch(e){
      R.routes.reportes.pdfDownloaded = false;
      R.routes.reportes.pdfError = String(e).split('\n')[0].slice(0,120);
    }
  }
}

// ── SUSCRIPCIONES ──
await pg.goto(`${APP}/dashboard/suscripciones`,{waitUntil:'domcontentloaded'});
await pg.getByRole('heading',{name:'Suscripciones'}).first().waitFor({timeout:20000}).catch(()=>{});
await pg.waitForTimeout(3500);
{
  const t = await txt();
  R.routes.suscripciones = {
    heading: /Suscripciones/.test(t),
    hasNetflix: /Netflix/.test(t),
    hasSpotify: /Spotify/.test(t),
    hasChatGPT: /ChatGPT/.test(t),
    hasApple: /APPLE\.COM|Apple/.test(t),
    emptyState: /Sin pagos de suscripciones/.test(t),
    len: t.length,
  };
  // switch to Anual view to check projection KPI + family savings
  const anualBtn = pg.getByRole('button',{name:'Anual'}).first();
  if(await anualBtn.isVisible().catch(()=>false)){
    await anualBtn.click();
    await pg.waitForTimeout(1500);
    const t2 = await txt();
    R.routes.suscripciones.anualHasPromedio = /Promedio mensual/.test(t2);
    R.routes.suscripciones.anualHasAhorro = /Ahorro posible/.test(t2);
  }
}

// ── ALERTAS ──
await pg.goto(`${APP}/dashboard/alertas`,{waitUntil:'domcontentloaded'});
await pg.getByRole('heading',{name:'Detector de Fugas'}).first().waitFor({timeout:20000}).catch(()=>{});
await pg.waitForTimeout(3000);
{
  const t = await txt();
  const alertsBody = apiJson.alerts?.body;
  // Count rendered alert cards (each has borderLeft 3px solid). Robust DOM count.
  const cardCount = await pg.locator('div.glass-card[style*="border-left"]').count().catch(()=>-1);
  R.routes.alertas = {
    heading: /Detector de Fugas/.test(t),
    apiIsPro: alertsBody?.isPro ?? null,
    apiAlertCount: alertsBody?.alerts?.length ?? null,
    apiTypes: alertsBody?.alerts?.map(a=>a.type) ?? null,
    renderedCardCount: cardCount,
    showsSpike: /Incremento inusual/i.test(t),
    showsAnt: /Gastos hormiga/i.test(t),
    showsRecurring: /Patrón recurrente/i.test(t),
    showsProjection: /Proyección de exceso/i.test(t),
    showsPonerLimite: /Poner l[íi]mite/i.test(t),
    projectionGate: /Proyecciones de exceso/i.test(t),
    proBanner: /Más protección con Pro/i.test(t),
    emptyState: /Todo bien por ahora/i.test(t),
    len: t.length,
  };
  await pg.screenshot({path:`sweep-alertas-${PLAN}.png`,fullPage:true}).catch(()=>{});
}

R.consoleErrorCount = consoleErrors.length;
R.consoleErrors = consoleErrors.slice(0,10);
R.failed4xx5xx = failed.slice(0,15);
R.apiJson = {
  score_factors_present: !!(apiJson.score?.body?.factors),
  score_history_factors_present: !!(apiJson.score_history?.body?.factors),
  score_history_len: apiJson.score_history?.body?.history?.length ?? null,
  alerts_status: apiJson.alerts?.status ?? null,
  score_status: apiJson.score?.status ?? apiJson.score_history?.status ?? null,
};

console.log(JSON.stringify(R,null,2));

// ── Veredicto ───────────────────────────────────────────────────────────────
// Lo que este barrido puede afirmar de verdad es que las cuatro rutas de análisis RENDERIZAN
// sin romperse. El gating por plan tiene su propio harness en el canary (`gating-score`,
// `gating-export`), así que acá no se duplica.
//
// El 4xx/5xx se filtra por plan a propósito: con el usuario en el muro, un 402 (o el 403 de
// una ruta Pro) es el gate FUNCIONANDO. Contarlo como falla pondría este barrido en rojo
// permanente justo en el plan donde más importa que ande, y un harness que grita por lo que
// no es se termina ignorando.
const fallas = [];
let medidos = 0;
const afirmar = (ok, msg) => { medidos++; if (!ok) fallas.push(msg); };

// El muro produce 402 y el navegador lo registra en DOS lados: la respuesta y una línea de
// consola "Failed to load resource ... 402". Filtrar solo la primera dejaba este barrido en
// rojo permanente en `free` — medido el 09-ago: 4 errores de consola que eran el gate
// funcionando. El patrón es angosto: excusa el log automático de un recurso que no cargó,
// nunca un error de JS.
// Angosto en DOS formas porque las dos listas tienen formato distinto: la de consola trae
// "Failed to load resource: ... status of 402" y la de respuestas "402 /api/x". Un `\b402\b`
// suelto habría excusado cualquier error de JS que mencionara ese número.
const esperadoPorGating = (l) => PLAN === 'free' &&
  (/Failed to load resource.*\b(402|403)\b/.test(l) || /^\s*(402|403)\s/.test(l));
const rotas = (R.failed4xx5xx || []).filter((f) => !esperadoPorGating(f));
const consolaReal = (R.consoleErrors || []).filter((l) => !esperadoPorGating(l));

for (const [ruta, datos] of Object.entries(R.routes || {})) {
  // `len` es el largo del texto renderizado. Cero = la página no pintó nada, que es lo único
  // que este barrido puede afirmar sobre cada ruta sin meterse con el gating.
  if (typeof datos.len === 'number') {
    afirmar(datos.len > 0, `/dashboard/${ruta} renderizó una página VACÍA (len=0)`);
  }
}
afirmar(consolaReal.length === 0,
  `${consolaReal.length} errores de consola no explicados por el gating: ${consolaReal.slice(0,3).join(' | ')}`);
afirmar(rotas.length === 0,
  `${rotas.length} respuestas 4xx/5xx no explicadas por el gating: ${rotas.slice(0,3).join(' | ')}`);

const inconcluso = Object.keys(R.routes || {}).length === 0
  ? 'no se visitó ninguna ruta: el barrido no llegó a empezar'
  : null;

cerrar({ nombre: `ANALYSIS-SWEEP ${PLAN.toUpperCase()}`, fallas, medidos, inconcluso });
await br.close();
