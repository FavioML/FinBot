// Deep correctness checks (verify EFFECT on data, not HTTP) for transacciones filters.
// `node qa-filter-effect.mjs pro|free`.
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { cerrar } from './lib/veredicto.mjs';

const APP = process.env.NETO_APP_URL || 'https://app.neto.pe';
const PLAN = (process.argv[2] || 'pro').toLowerCase();
const P = PLAN === 'free' ? 'NETO_QA_FREE_' : 'NETO_QA_';
function loadEnv(p){const e={};for(const l of readFileSync(p,'utf8').split(/\r?\n/)){const m=l.match(/^([A-Z0-9_]+)=(.*)$/);if(m)e[m[1]]=m[2];}return e;}
const env = loadEnv(join(homedir(), '.config', 'neto', 'qa.env'));
const SUPA=env[P+'URL']||env.NETO_QA_URL, ANON=env[P+'ANON']||env.NETO_QA_ANON, EMAIL=env[P+'EMAIL'], PASSWORD=env[P+'PASSWORD']||env.NETO_QA_PASSWORD;
const ref=new URL(SUPA).hostname.split('.')[0], cookieName=`sb-${ref}-auth-token`;
const grant=await fetch(`${SUPA}/auth/v1/token?grant_type=password`,{method:'POST',headers:{apikey:ANON,'Content-Type':'application/json'},body:JSON.stringify({email:EMAIL,password:PASSWORD})});
if(!grant.ok){console.error('grant failed',grant.status);process.exit(2);}
const session=await grant.json();
const value='base64-'+Buffer.from(JSON.stringify(session),'utf8').toString('base64url');
const MAX=3180, domain=new URL(APP).hostname, cookies=[];
if(value.length<=MAX)cookies.push({name:cookieName,value});else for(let i=0,p=0;p<value.length;i++,p+=MAX)cookies.push({name:`${cookieName}.${i}`,value:value.slice(p,p+MAX)});
const toAdd=cookies.map(c=>({name:c.name,value:c.value,domain,path:'/',httpOnly:false,secure:true,sameSite:'Lax'}));

const browser=await chromium.launch();
const context=await browser.newContext({viewport:{width:1280,height:900}});
await context.addCookies(toAdd);
await context.addInitScript(()=>{try{localStorage.setItem('neto_tour_v2','true');localStorage.setItem('neto_welcome_seen','1');}catch{}});
const page=await context.newPage();
const R={};

// Read table cell texts by column index across all rows, in-page.
function readCol(idx){
  return page.evaluate((i)=>{
    const out=[];
    document.querySelectorAll('table tbody tr').forEach(tr=>{
      const tds=tr.querySelectorAll('td');
      out.push(tds[i]?tds[i].innerText.trim():'');
    });
    return out;
  }, idx);
}

await page.goto(`${APP}/dashboard/transacciones`,{waitUntil:'domcontentloaded'});
await page.getByText('Transacciones').first().waitFor({timeout:15000}).catch(()=>{});
await page.locator('table tbody tr').first().waitFor({timeout:20000}).catch(()=>{});
await page.waitForTimeout(1500);

// --- Método filter effect (col 5) ---
const methodTrigger = page.locator('button[role="combobox"]').filter({ hasText: /métodos|Todos los mét/ }).first();
R.methodTriggerFound = await methodTrigger.isVisible().catch(()=>false);
if (R.methodTriggerFound) {
  await methodTrigger.click().catch(()=>{});
  await page.waitForTimeout(500);
  const opts = page.locator('[role="option"]');
  const n = await opts.count();
  if (n > 1) {
    const chosen = (await opts.nth(1).innerText()).trim();
    R.chosenMethod = chosen;
    await opts.nth(1).click().catch(()=>{});
    await page.waitForTimeout(900);
    const methods = await readCol(5);
    R.rowsAfterMethodFilter = methods.length;
    R.allRowsMatchMethod = methods.every(m => m.toLowerCase().includes(chosen.toLowerCase()));
    R.sampleMethods = methods.slice(0,5);
  } else { R.chosenMethod = 'ONLY_ALL_OPTION'; }
}

await page.goto(`${APP}/dashboard/transacciones`,{waitUntil:'domcontentloaded'});
await page.locator('table tbody tr').first().waitFor({timeout:20000}).catch(()=>{});
await page.waitForTimeout(1200);

// --- Ingresos type filter effect (col 6 sign) ---
const ingresosTab = page.getByRole('tab', { name: /^Ingresos$/ }).first();
if (await ingresosTab.isVisible().catch(()=>false)) {
  await ingresosTab.click().catch(()=>{});
  await page.waitForTimeout(900);
  const amts = await readCol(6);
  R.ingresoRows = amts.length;
  R.allIngresosPositive = amts.length === 0 || amts.every(s => s.startsWith('+'));
  R.sampleIngresos = amts.slice(0,4);
}

// --- Sort by monto (col 6) ascending then descending ---
await page.getByRole('tab', { name: /^Todos$/ }).first().click().catch(()=>{});
await page.waitForTimeout(700);
const montoHeader = page.getByRole('button', { name: /Monto/ }).first();
if (await montoHeader.isVisible().catch(()=>false)) {
  await montoHeader.click().catch(()=>{});
  await page.waitForTimeout(700);
  const raw1 = await readCol(6);
  const a1 = raw1.map(s=>parseFloat(s.replace(/[^\d.]/g,''))||0);
  R.montoSortedAsc = a1.every((v,i)=> i===0 || a1[i-1] <= v + 0.001);
  await montoHeader.click().catch(()=>{});
  await page.waitForTimeout(700);
  const raw2 = await readCol(6);
  const a2 = raw2.map(s=>parseFloat(s.replace(/[^\d.]/g,''))||0);
  R.montoSortedDesc = a2.every((v,i)=> i===0 || a2[i-1] >= v - 0.001);
}

console.log(`\n==== FILTER-EFFECT ${PLAN.toUpperCase()} ====`);
console.log(JSON.stringify(R,null,2));

// ── Veredicto ───────────────────────────────────────────────────────────────
// Este archivo existe para verificar el EFECTO sobre los datos, no que la API devuelva 200,
// y ya calculaba los tres booleanos que lo dicen. Solo que salía 0 pase lo que pase.
//
// Cada afirmación se evalúa SOLO si su filtro trajo filas: con cero filas, "todas las filas
// coinciden" y "está ordenado" son verdad por vacío, o sea que el verde no diría nada. Es el
// mismo pase vacuo que se encontró hoy en qa-cat-dedup con una sola categoría.
const fallas = [];
let medidos = 0;
const afirmar = (ok, msg) => { medidos++; if (!ok) fallas.push(msg); };

if (R.rowsAfterMethodFilter > 0) {
  afirmar(R.allRowsMatchMethod === true,
    `el filtro por método "${R.chosenMethod}" NO filtró: quedaron filas de otros métodos (${(R.sampleMethods||[]).join(', ')})`);
}
if (R.ingresoRows > 0) {
  afirmar(R.allIngresosPositive === true,
    `la pestaña Ingresos muestra montos que no son ingresos (${(R.sampleIngresos||[]).join(', ')})`);
}
if (R.montoSortedAsc !== undefined) {
  afirmar(R.montoSortedAsc === true, 'ordenar por Monto ascendente NO ordena');
  afirmar(R.montoSortedDesc === true, 'ordenar por Monto descendente NO ordena');
}

const inconcluso = medidos === 0
  ? `ningún filtro trajo filas para el plan ${PLAN} (methodTriggerFound=${R.methodTriggerFound}, ` +
    `rowsAfterMethodFilter=${R.rowsAfterMethodFilter}, ingresoRows=${R.ingresoRows}). ` +
    'Sin filas, "todo coincide" y "todo está ordenado" son ciertos por vacío: sembrá transacciones y volvé'
  : null;

cerrar({ nombre: `FILTER-EFFECT ${PLAN.toUpperCase()}`, fallas, medidos, inconcluso });
await browser.close();
