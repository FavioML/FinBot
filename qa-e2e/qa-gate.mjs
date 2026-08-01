import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Verificación visual del gating de planes en app.neto.pe, con sesión real.
//
//   node qa-e2e/qa-gate.mjs pro    → un Pro (o alguien en trial) ve todo abierto
//   node qa-e2e/qa-gate.mjs free   → un usuario en el MURO ve el paywall
//
// El modo `free` cambió de premisa con el trial de 14 días. Antes existía un plan
// gratuito permanente con dashboard y teasers de Pro, así que el harness comprobaba
// que se vieran esos teasers (candado del calendario, corona del CSV). Ese estado ya
// NO EXISTE: `free` pasó a ser el muro en el que cae quien terminó su prueba sin
// pagar. Dejar las aserciones viejas habría sido peor que borrarlas — habrían pasado
// en verde para siempre buscando textos que ya nadie renderiza.
//
// Lo que se comprueba ahora en `free`:
//   · el contenido del dashboard es el paywall, no la data;
//   · el chrome (sidebar/nav) SIGUE ahí — el muro tiene que leerse como "esto está
//     detrás del pago", no como "esto desapareció";
//   · el total del mes se ve (es el único número que sobrevive del lado gratis);
//   · /dashboard/pro sigue abierto — taparlo sería cerrar la puerta de pagar.
const APP = 'https://app.neto.pe';
const PLAN = (process.argv[2] || 'pro').toLowerCase();
const P = PLAN === 'free' ? 'NETO_QA_FREE_' : 'NETO_QA_';
function le(p){const e={};for(const l of readFileSync(p,'utf8').split(/\r?\n/)){const m=l.match(/^([A-Z0-9_]+)=(.*)$/);if(m)e[m[1]]=m[2];}return e;}
const env = le(join(homedir(), '.config', 'neto', 'qa.env'));
const SUPA = env[P+'URL']||env.NETO_QA_URL, ANON = env[P+'ANON']||env.NETO_QA_ANON, EMAIL = env[P+'EMAIL'], PASSWORD = env[P+'PASSWORD']||env.NETO_QA_PASSWORD;
const ref = new URL(SUPA).hostname.split('.')[0], cn = `sb-${ref}-auth-token`;
const g = await fetch(`${SUPA}/auth/v1/token?grant_type=password`,{method:'POST',headers:{apikey:ANON,'Content-Type':'application/json'},body:JSON.stringify({email:EMAIL,password:PASSWORD})});
const s = await g.json();
const v = 'base64-'+Buffer.from(JSON.stringify(s),'utf8').toString('base64url');
const MAX = 3180, domain = new URL(APP).hostname, ck = [];
if(v.length<=MAX)ck.push({name:cn,value:v});else for(let i=0,p=0;p<v.length;i++,p+=MAX)ck.push({name:`${cn}.${i}`,value:v.slice(p,p+MAX)});
const br = await chromium.launch(); const ctx = await br.newContext({viewport:{width:1280,height:1400}});
await ctx.addCookies(ck.map(c=>({name:c.name,value:c.value,domain,path:'/',httpOnly:false,secure:true,sameSite:'Lax'})));
await ctx.addInitScript(()=>{try{localStorage.setItem('neto_tour_v2','true');localStorage.setItem('neto_welcome_seen','1');}catch{}});
const pg = await ctx.newPage();
await pg.goto(`${APP}/dashboard`,{waitUntil:'domcontentloaded'});
await pg.getByText(/S\/\s*[\d.,]+/).first().waitFor({timeout:20000}).catch(()=>{});
await pg.waitForTimeout(3500);

const visible = (re) => pg.getByText(re).first().isVisible().catch(() => false);
const R = { plan: PLAN };

if (PLAN === 'free') {
  R.paywallVisible = await visible(/Neto Pro (terminó|esperándote)|prueba de Neto Pro/);
  R.totalMesVisible = await visible(/Van este mes/);
  R.dataOculta = !(await visible(/Gastos por categoría|Tendencia/));
  // El chrome tiene que sobrevivir al muro.
  R.chromeIntacto = await pg.locator('nav, aside').first().isVisible().catch(() => false);
  // La puerta de pagar sigue abierta. Se lee el texto del <main> en vez de usar
  // getByText: ahí `.first()` puede caer en un nodo oculto y reportar un falso
  // negativo sobre la única pantalla que el usuario en el muro NECESITA ver.
  await pg.goto(`${APP}/dashboard/pro`, { waitUntil: 'domcontentloaded' });
  await pg.getByText(/ELIGE TU PLAN/i).first().waitFor({ timeout: 20000 }).catch(() => {});
  const textoPro = await pg.locator('main').innerText().catch(() => '');
  R.proAccesible = /ELIGE TU PLAN/i.test(textoPro) && /S\/\s*10/.test(textoPro)
    && !/prueba de Neto Pro terminó/.test(textoPro);
  R.ok = R.paywallVisible && R.totalMesVisible && R.dataOculta && R.chromeIntacto && R.proAccesible;
} else {
  const texto = await pg.locator('main').innerText().catch(() => '');
  R.sinPaywall = !/prueba de Neto Pro (terminó|esperándote)/.test(texto);
  R.dashboardVivo = /Buenos días|Buenas tardes|Buenas noches|Total|Agosto|Enero/i.test(texto);
  // Informativos, NO parte de `ok`: los widgets de calendario/CSV solo se pintan si el
  // usuario tiene transacciones del mes en curso, así que el día 1 de cada mes dan false
  // sin que nada esté roto. Atarlos al veredicto haría que el harness se ponga rojo por
  // calendario, que es la forma más rápida de que se le deje de hacer caso.
  R.calendarGateVisible = await visible('Calendario financiero');
  R.csvCrown = await visible('CSV');
  R.sinTxEsteMes = /Sin transacciones este mes/i.test(texto);
  R.ok = R.sinPaywall && R.dashboardVivo;
}

console.log(JSON.stringify(R, null, 2));
await br.close();
process.exit(R.ok ? 0 : 1);
