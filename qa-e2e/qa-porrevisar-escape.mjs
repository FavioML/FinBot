// Verifies the current (period-scoped) "Por revisar" design: main badge shows the
// period count, and the "+N en otros meses · ver todas" escape hatch expands to the
// global backlog (incl. prior months). Assumes the qa-por-revisar seed rows exist.
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
const br=await chromium.launch();const ctx=await br.newContext({viewport:{width:1280,height:900}});
await ctx.addCookies(ck.map(c=>({name:c.name,value:c.value,domain,path:'/',httpOnly:false,secure:true,sameSite:'Lax'})));
await ctx.addInitScript(()=>{try{localStorage.setItem('neto_tour_v2','true');localStorage.setItem('neto_welcome_seen','1');}catch{}});
const pg=await ctx.newPage();
const R={};
await pg.goto(`${APP}/dashboard/transacciones`,{waitUntil:'domcontentloaded'});
await pg.locator('table tbody tr').first().waitFor({timeout:30000}).catch(()=>{});
await pg.waitForTimeout(1500);
const rows=()=>pg.locator('table tbody tr').count();

// Escape hatch present?
const hatch = pg.getByText(/en otros meses/i).first();
R.escapeHatchVisible = await hatch.isVisible().catch(()=>false);
R.escapeHatchText = R.escapeHatchVisible ? (await hatch.innerText()).trim() : null;
if (R.escapeHatchVisible) {
  await hatch.click().catch(()=>{});
  await pg.waitForTimeout(1200);
  R.rowsGlobal = await rows();
  // The prior-month seed row must now be visible
  R.pastRowVisible = await pg.getByText('QA REVISAR PASADO').first().isVisible().catch(()=>false);
  // Banner should now indicate global scope
  R.globalBannerText = await pg.getByText(/por revisar/i).first().innerText().catch(()=>'');
}
console.log(JSON.stringify(R,null,2));
await br.close();
