// Verifies the dashboard category donut no longer splits the same category by
// casing (e.g. "Transporte" and "transporte" must collapse into one legend row).
// Reads the donut legend labels off the live page. node qa-cat-dedup.mjs
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
const br=await chromium.launch();const ctx=await br.newContext({viewport:{width:1280,height:1200}});
await ctx.addCookies(ck.map(c=>({name:c.name,value:c.value,domain,path:'/',httpOnly:false,secure:true,sameSite:'Lax'})));
await ctx.addInitScript(()=>{try{localStorage.setItem('neto_tour_v2','true');localStorage.setItem('neto_welcome_seen','1');}catch{}});
const pg=await ctx.newPage();
await pg.goto(`${APP}/dashboard`,{waitUntil:'domcontentloaded'});
await pg.getByText('Gastos por Categoria').first().waitFor({timeout:25000}).catch(()=>{});
await pg.waitForTimeout(2500);
// Read the legend rows inside the "Gastos por Categoria" card.
const labels = await pg.evaluate(() => {
  const h = Array.from(document.querySelectorAll('h3')).find(x => /Gastos por Categoria/i.test(x.textContent||''));
  if (!h) return null;
  const card = h.closest('div');
  const out = [];
  card.querySelectorAll('span.truncate').forEach(s => { const t=(s.textContent||'').trim(); if(t) out.push(t); });
  return out;
});
const R = { labels };
if (labels) {
  // Strip emoji, keep category word(s), lowercase → find case-collisions.
  const norm = labels.map(l => l.replace(/[^\p{L}\s]/gu,'').trim().toLowerCase()).filter(Boolean);
  const seen = new Map();
  const dups = [];
  for (const n of norm) { if (seen.has(n)) dups.push(n); else seen.set(n, true); }
  R.normalized = norm;
  R.caseDuplicates = dups;
  R.noDuplicates = dups.length === 0;
}
console.log(JSON.stringify(R,null,2));
await br.close();
