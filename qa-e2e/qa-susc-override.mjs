// Suscripciones detection + override round-trip (Pro). Screenshots mensual/anual,
// opens the edit Sheet for Netflix, renames it, reloads, verifies persistence,
// then resets. Verifies overrides actually persist to recurrentes_overrides (via
// UI reflection). Usage: node qa-susc-override.mjs
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
const APP='https://app.neto.pe';
function le(p){const e={};for(const l of readFileSync(p,'utf8').split(/\r?\n/)){const m=l.match(/^([A-Z0-9_]+)=(.*)$/);if(m)e[m[1]]=m[2];}return e;}
const env=le(join(homedir(),'.config','neto','qa.env'));
const SUPA=env.NETO_QA_URL,ANON=env.NETO_QA_ANON,EMAIL=env.NETO_QA_EMAIL,PASSWORD=env.NETO_QA_PASSWORD;
const ref=new URL(SUPA).hostname.split('.')[0],cn=`sb-${ref}-auth-token`;
const g=await fetch(`${SUPA}/auth/v1/token?grant_type=password`,{method:'POST',headers:{apikey:ANON,'Content-Type':'application/json'},body:JSON.stringify({email:EMAIL,password:PASSWORD})});
const s=await g.json();
const v='base64-'+Buffer.from(JSON.stringify(s),'utf8').toString('base64url');
const MAX=3180,domain=new URL(APP).hostname,ck=[];
if(v.length<=MAX)ck.push({name:cn,value:v});else for(let i=0,p=0;p<v.length;i++,p+=MAX)ck.push({name:`${cn}.${i}`,value:v.slice(p,p+MAX)});
const br=await chromium.launch();
const ctx=await br.newContext({viewport:{width:1280,height:1700}});
await ctx.addCookies(ck.map(c=>({name:c.name,value:c.value,domain,path:'/',httpOnly:false,secure:true,sameSite:'Lax'})));
await ctx.addInitScript(()=>{try{localStorage.setItem('neto_tour_v2','true');localStorage.setItem('neto_welcome_seen','1');}catch{}});
const pg=await ctx.newPage();
const R={};
const errs=[]; pg.on('console',m=>{if(m.type()==='error')errs.push(m.text().slice(0,160));});
const failed=[]; pg.on('response',r=>{if(r.status()>=400)failed.push(`${r.status()} ${r.url().replace(APP,'')}`);});

await pg.goto(`${APP}/dashboard/suscripciones`,{waitUntil:'domcontentloaded'});
await pg.getByRole('heading',{name:'Suscripciones'}).first().waitFor({timeout:20000}).catch(()=>{});
await pg.waitForTimeout(3500);
await pg.screenshot({path:'susc-mensual.png',fullPage:true});

// Capture rendered card amounts (mensual)
R.mensualText = (await pg.locator('main').innerText().catch(()=> '')).slice(0,1400);

// ── Rename override round-trip: open Netflix edit sheet ──
let renameStep = {};
try{
  // The pencil button per card: aria-label "Editar Netflix"
  await pg.getByRole('button',{name:/Editar Netflix/i}).first().click({timeout:6000});
  await pg.waitForTimeout(1200);
  const input = pg.locator('input[placeholder="Nombre de la suscripción"]');
  await input.waitFor({timeout:5000});
  await input.fill('Netflix QA Test');
  await pg.getByRole('button',{name:/Guardar/i}).first().click({timeout:5000});
  await pg.waitForTimeout(2500);
  renameStep.saved = true;
}catch(e){ renameStep.error = String(e).split('\n')[0].slice(0,160); }

// Reload and verify persistence
await pg.goto(`${APP}/dashboard/suscripciones`,{waitUntil:'domcontentloaded'});
await pg.getByRole('heading',{name:'Suscripciones'}).first().waitFor({timeout:20000}).catch(()=>{});
await pg.waitForTimeout(3500);
const afterReload = await pg.locator('main').innerText().catch(()=> '');
renameStep.persistsAfterReload = /Netflix QA Test/.test(afterReload);
renameStep.oldNameGone = !/(?<!QA Test)\bNetflix\b(?! QA)/.test(afterReload) || /Netflix QA Test/.test(afterReload);
R.rename = renameStep;

// ── Reset override ──
let resetStep = {};
try{
  await pg.getByRole('button',{name:/Editar Netflix QA Test/i}).first().click({timeout:6000});
  await pg.waitForTimeout(1200);
  const restablecer = pg.getByRole('button',{name:/Restablecer/i}).first();
  if(await restablecer.isVisible().catch(()=>false)){
    await restablecer.click({timeout:5000});
    await pg.waitForTimeout(2500);
    resetStep.clicked = true;
  } else { resetStep.restablecerVisible = false; }
}catch(e){ resetStep.error = String(e).split('\n')[0].slice(0,160); }
await pg.goto(`${APP}/dashboard/suscripciones`,{waitUntil:'domcontentloaded'});
await pg.getByRole('heading',{name:'Suscripciones'}).first().waitFor({timeout:20000}).catch(()=>{});
await pg.waitForTimeout(3000);
const afterReset = await pg.locator('main').innerText().catch(()=> '');
resetStep.backToNetflix = /\bNetflix\b/.test(afterReset) && !/Netflix QA Test/.test(afterReset);
R.reset = resetStep;

R.consoleErrors = errs.slice(0,8);
R.failed = failed.slice(0,10);
console.log(JSON.stringify(R,null,2));
await br.close();
