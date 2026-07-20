import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
const APP='https://app.neto.pe';
const env={}; for(const l of readFileSync(join(homedir(),'.config','neto','qa.env'),'utf8').split(/\r?\n/)){const m=l.match(/^([A-Z0-9_]+)=(.*)$/);if(m)env[m[1]]=m[2];}
async function forge(P){const SUPA=env[P+'URL']||env.NETO_QA_URL,ANON=env[P+'ANON']||env.NETO_QA_ANON;const g=await fetch(`${SUPA}/auth/v1/token?grant_type=password`,{method:'POST',headers:{apikey:ANON,'Content-Type':'application/json'},body:JSON.stringify({email:env[P+'EMAIL'],password:env[P+'PASSWORD']||env.NETO_QA_PASSWORD})});const s=await g.json();const ref=new URL(SUPA).hostname.split('.')[0];const v='base64-'+Buffer.from(JSON.stringify(s),'utf8').toString('base64url');const MAX=3180,domain=new URL(APP).hostname,ck=[];if(v.length<=MAX)ck.push({name:`sb-${ref}-auth-token`,value:v});else for(let i=0,p=0;p<v.length;i++,p+=MAX)ck.push({name:`sb-${ref}-auth-token.${i}`,value:v.slice(p,p+MAX)});return ck.map(c=>({name:c.name,value:c.value,domain,path:'/',httpOnly:false,secure:true,sameSite:'Lax'}));}
const br=await chromium.launch();
async function ctxFor(P){const ctx=await br.newContext();await ctx.addCookies(await forge(P));const pg=await ctx.newPage();await pg.goto(`${APP}/dashboard`,{waitUntil:'domcontentloaded'});await pg.waitForTimeout(800);const api=(path,opts)=>pg.evaluate(async({path,opts})=>{const r=await fetch(path,opts);let b=null;try{b=await r.json();}catch{}return{status:r.status,body:b};},{path,opts:opts||{}});return{ctx,api};}
const J=(o)=>({method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(o)});
const pro=await ctxFor('NETO_QA_'); const free=await ctxFor('NETO_QA_FREE_');
const R={};
const sp=await pro.api('/api/spaces',J({name:'QA_HOSTPAYS',type:'custom'}));const spId=sp.body?.id;
const det0=await pro.api(`/api/spaces/${spId}`);const code=det0.body?.space?.invite_code;
await free.api('/api/spaces/join',J({code}));
// Free member queries the Pro-owned space
const freeView=await free.api(`/api/spaces/${spId}`);
R.freeSeesSpace_status=freeView.status;
R.freeSeesIsPro_expectTrue=freeView.body?.isPro; // host pays: owner is Pro => member sees Pro tier
// Free member can also use the Pro feature on the Pro space (edit rule)
const freeRule=await free.api(`/api/spaces/${spId}/split-rules`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({rules:[{id:'r1',category:'Salud',splits:{[env.NETO_QA_USUARIO_ID]:50,[env.NETO_QA_FREE_USUARIO_ID]:50}}]})});
R.freeCanEditRuleOnProSpace_expect200=freeRule.status;
R.cleanup=(await pro.api(`/api/spaces/${spId}`,{method:'DELETE'})).status;
console.log(JSON.stringify(R,null,2));
await br.close();
