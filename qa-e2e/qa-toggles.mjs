import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
const APP='https://app.neto.pe';
const env={}; for(const l of readFileSync(join(homedir(),'.config','neto','qa.env'),'utf8').split(/\r?\n/)){const m=l.match(/^([A-Z0-9_]+)=(.*)$/);if(m)env[m[1]]=m[2];}
async function forge(P){const SUPA=env[P+'URL']||env.NETO_QA_URL,ANON=env[P+'ANON']||env.NETO_QA_ANON;const g=await fetch(`${SUPA}/auth/v1/token?grant_type=password`,{method:'POST',headers:{apikey:ANON,'Content-Type':'application/json'},body:JSON.stringify({email:env[P+'EMAIL'],password:env[P+'PASSWORD']||env.NETO_QA_PASSWORD})});const s=await g.json();const ref=new URL(SUPA).hostname.split('.')[0];const v='base64-'+Buffer.from(JSON.stringify(s),'utf8').toString('base64url');const MAX=3180,domain=new URL(APP).hostname,ck=[];if(v.length<=MAX)ck.push({name:`sb-${ref}-auth-token`,value:v});else for(let i=0,p=0;p<v.length;i++,p+=MAX)ck.push({name:`sb-${ref}-auth-token.${i}`,value:v.slice(p,p+MAX)});return ck.map(c=>({name:c.name,value:c.value,domain,path:'/',httpOnly:false,secure:true,sameSite:'Lax'}));}
const br=await chromium.launch();
async function run(P,label){
  const ctx=await br.newContext();await ctx.addCookies(await forge(P));const pg=await ctx.newPage();
  await pg.goto(`${APP}/dashboard`,{waitUntil:'domcontentloaded'});await pg.waitForTimeout(1000);
  const api=(path,opts)=>pg.evaluate(async({path,opts})=>{const r=await fetch(path,opts);let b=null;try{b=await r.json();}catch{}return{status:r.status,body:b};},{path,opts:opts||{}});
  const R={plan:label};
  const g0=await api('/api/notifications');R.initial=g0.body;
  // recordatorios round-trip
  await api('/api/notifications',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({recordatorios_activos:false})});
  R.afterSetFalse=(await api('/api/notifications')).body?.recordatorios_activos;
  await api('/api/notifications',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({recordatorios_activos:true})});
  R.afterSetTrue=(await api('/api/notifications')).body?.recordatorios_activos;
  // alertas_transaccion round-trip
  await api('/api/notifications',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({alertas_transaccion:false})});
  R.alertasAfterFalse=(await api('/api/notifications')).body?.alertas_transaccion;
  await api('/api/notifications',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({alertas_transaccion:true})});
  R.alertasAfterTrue=(await api('/api/notifications')).body?.alertas_transaccion;
  // manos_libres server-side gating? (Free UI blocks it; does API?)
  const ml=await api('/api/notifications',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({manos_libres:true})});
  R.manosLibresPutStatus=ml.status;
  R.manosLibresAfter=(await api('/api/notifications')).body?.manos_libres;
  // reset manos_libres
  await api('/api/notifications',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({manos_libres:false})});
  await ctx.close();
  return R;
}
const free=await run('NETO_QA_FREE_','free');
console.log(JSON.stringify(free,null,2));
await br.close();
