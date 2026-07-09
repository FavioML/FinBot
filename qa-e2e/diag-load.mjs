// Diagnose the authenticated dashboard data-load time: which requests are slow.
// Same forged-session login as qa-login.mjs, but instruments every network
// request with a wall-clock duration and reports the slowest ones + time-to-data.
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const APP = process.env.NETO_APP_URL || 'https://app.neto.pe';
function loadEnv(p){const e={};for(const l of readFileSync(p,'utf8').split(/\r?\n/)){const m=l.match(/^([A-Z0-9_]+)=(.*)$/);if(m)e[m[1]]=m[2];}return e;}
const env = loadEnv(join(homedir(), '.config', 'neto', 'qa.env'));
const SUPA = env.NETO_QA_URL, ANON = env.NETO_QA_ANON, EMAIL = env.NETO_QA_EMAIL, PASSWORD = env.NETO_QA_PASSWORD;
const ref = new URL(SUPA).hostname.split('.')[0];
const cookieName = `sb-${ref}-auth-token`;

const grant = await fetch(`${SUPA}/auth/v1/token?grant_type=password`, {
  method:'POST', headers:{ apikey:ANON, 'Content-Type':'application/json' },
  body: JSON.stringify({ email:EMAIL, password:PASSWORD }),
});
const session = await grant.json();
const value = 'base64-' + Buffer.from(JSON.stringify(session),'utf8').toString('base64url');
const MAX=3180, domain=new URL(APP).hostname, cookies=[];
if(value.length<=MAX) cookies.push({name:cookieName,value});
else for(let i=0,p=0;p<value.length;i++,p+=MAX) cookies.push({name:`${cookieName}.${i}`,value:value.slice(p,p+MAX)});

const browser = await chromium.launch();
const context = await browser.newContext();
await context.addCookies(cookies.map(c=>({name:c.name,value:c.value,domain,path:'/',httpOnly:false,secure:true,sameSite:'Lax'})));
const page = await context.newPage();

const starts = new Map();
const reqs = [];
page.on('request', (r) => starts.set(r, Date.now()));
const finish = (r) => {
  const s = starts.get(r); if (!s) return;
  const resp = r.response ? null : null;
  reqs.push({ url: r.url(), method: r.method(), ms: Date.now() - s, type: r.resourceType() });
};
page.on('requestfinished', finish);
page.on('requestfailed', (r) => { const s=starts.get(r); if(s) reqs.push({ url:r.url(), method:r.method(), ms:Date.now()-s, failed:true, type:r.resourceType() }); });

const t0 = Date.now();
await page.goto(`${APP}/dashboard`, { waitUntil: 'domcontentloaded' });

// Time-to-data: poll until the score value / real KPI text appears.
let ttData = null;
for (let i=0;i<40;i++){
  const has = await page.evaluate(() => {
    const t = document.querySelector('main')?.innerText || '';
    return /S\/\s*[\d,]+\.\d/.test(t); // a formatted currency amount = real data
  });
  if (has) { ttData = Date.now() - t0; break; }
  await page.waitForTimeout(300);
}

await page.waitForTimeout(1500);

// Only app/api + supabase + railway requests, slowest first.
const interesting = reqs
  .filter(r => /\/api\/|supabase\.co|api\.neto\.pe/.test(r.url))
  .sort((a,b) => b.ms - a.ms)
  .slice(0, 20)
  .map(r => `${String(r.ms).padStart(6)}ms ${r.failed?'FAIL':'    '} ${r.method} ${r.url.replace('https://','').slice(0,90)}`);

console.log('time-to-data (first currency on screen):', ttData ? ttData+'ms' : 'NOT WITHIN 12s');
console.log('slowest app/api + supabase + railway requests:');
console.log(interesting.join('\n'));

await browser.close();
