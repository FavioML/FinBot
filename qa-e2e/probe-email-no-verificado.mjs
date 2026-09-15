/**
 * probe-email-no-verificado.mjs — ¿queda algún correo que nadie probó en `usuarios`?
 *
 * Solo lectura (GET). Mismo predicado que `migrations/086_email_no_verificado.sql`: una fila con
 * `email` cuenta como PROBADA si ese correo es el de su usuario de auth (su sesión de Google o del
 * magic link) o el de su propio `gmail_cuentas`. Cualquier otra es un correo dictado por WhatsApp
 * en el alta viejo (paso 101, retirado el 31-jul-2026) que nadie verificó.
 *
 * Por qué importa aunque el canal ya no les escriba (`correoVerificado`, lib/email.js): esas
 * direcciones ocupan el índice único de `lower(email)` —la dueña real de una dirección mal tipeada
 * no puede tenerla en su fila— y son lo único que `merge_and_link` o el fallback del OTP podían
 * pasarle a una fila web.
 *
 * Exit 0 = ninguna. Exit 1 = hay alguna (se listan enmascaradas). Exit 2 = no se pudo medir.
 * Las cuentas de prueba y las lápidas no cuentan.
 *
 * No es un harness del canary: esto sólo cambia con un commit que vuelva a escribir un correo
 * sin probar, y ahí lo que tiene que ponerse rojo son los tests (ver qa-e2e/README.md).
 *
 * Uso: node qa-e2e/probe-email-no-verificado.mjs
 */
import fs from 'node:fs';

const RAILWAY = { P: 'e2aac0f3-c2ee-4347-892c-b36d8c76929e', S: '1085b433-8f29-4487-9ce7-3a66b64ef244', E: '1600a753-bc8c-492c-aca7-27fdac946747' };

function envLocal(clave) {
  if (process.env[clave]) return process.env[clave];
  try {
    const txt = fs.readFileSync(new URL('../.env', import.meta.url), 'utf8');
    return txt.split('\n').find((l) => l.startsWith(clave + '='))?.split('=').slice(1).join('=').trim();
  } catch { return null; }
}

function salir(codigo, msg) {
  console.log(msg);
  process.exit(codigo);
}

async function credenciales() {
  const token = envLocal('RAILWAY_API_TOKEN');
  if (!token) salir(2, 'NO SE PUDO MEDIR: falta RAILWAY_API_TOKEN en app/.env');
  const q = `query{variables(projectId:"${RAILWAY.P}",environmentId:"${RAILWAY.E}",serviceId:"${RAILWAY.S}")}`;
  const r = await fetch('https://backboard.railway.com/graphql/v2', {
    method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ query: q }),
  });
  const j = await r.json().catch(() => ({}));
  const v = j && j.data && j.data.variables;
  if (!v || !v.SUPABASE_URL || !v.SUPABASE_KEY) salir(2, 'NO SE PUDO MEDIR: Railway no devolvió SUPABASE_URL/SUPABASE_KEY');
  return v;
}

const vars = await credenciales();
const raiz = vars.SUPABASE_URL.replace(/\/$/, '');
const h = { apikey: vars.SUPABASE_KEY, Authorization: 'Bearer ' + vars.SUPABASE_KEY };

/** Pagina de a 1000: PostgREST corta ahí sin avisar, y un conteo sobre una lista capada satura. */
async function todas(tabla, query) {
  const out = [];
  for (let off = 0; ; off += 1000) {
    const r = await fetch(`${raiz}/rest/v1/${tabla}?${query}&order=id.asc&limit=1000&offset=${off}`, { headers: h });
    if (!r.ok) salir(2, `NO SE PUDO MEDIR: select ${tabla} ${r.status} ${(await r.text()).slice(0, 200)}`);
    const j = await r.json();
    out.push(...j);
    if (j.length < 1000) return out;
  }
}

async function usuariosDeAuth() {
  const out = [];
  for (let p = 1; ; p++) {
    const r = await fetch(`${raiz}/auth/v1/admin/users?page=${p}&per_page=1000`, { headers: h });
    if (!r.ok) salir(2, `NO SE PUDO MEDIR: auth admin ${r.status}`);
    const j = await r.json();
    const lote = j.users || [];
    out.push(...lote);
    if (lote.length < 1000) return out;
  }
}

const filas = await todas('usuarios', 'select=id,email,supabase_auth_id&email=not.is.null&cuenta_borrada_at=is.null&is_test_user=not.is.true');
const auth = new Map((await usuariosDeAuth()).map((a) => [a.id, (a.email || '').toLowerCase()]));
const gmail = await todas('gmail_cuentas', 'select=id,usuario_id,email&email=not.is.null');
const gmailDe = new Map();
for (const g of gmail) {
  if (!gmailDe.has(g.usuario_id)) gmailDe.set(g.usuario_id, new Set());
  gmailDe.get(g.usuario_id).add(g.email.toLowerCase());
}

// Antivacuidad: sin filas con correo, "cero sin probar" no prueba nada.
if (filas.length === 0) salir(2, 'NO SE PUDO MEDIR: ninguna fila viva con correo (¿query rota?)');

const probadaPorAuth = (u) => !!u.supabase_auth_id && auth.get(u.supabase_auth_id) === u.email.toLowerCase();
const probadaPorGmail = (u) => !!gmailDe.get(u.id) && gmailDe.get(u.id).has(u.email.toLowerCase());
const sinProbar = filas.filter((u) => !probadaPorAuth(u) && !probadaPorGmail(u));
const enmascarar = (e) => e.replace(/^(.).*?@(.).*$/, '$1***@$2***');

console.log(`filas vivas con correo: ${filas.length} · probadas por auth: ${filas.filter(probadaPorAuth).length} · por Gmail (sin auth): ${filas.filter((u) => !probadaPorAuth(u) && probadaPorGmail(u)).length}`);
if (sinProbar.length === 0) salir(0, 'OK: ningún correo sin probar');
for (const u of sinProbar) {
  console.log(`  ${u.id.slice(0, 8)}  ${enmascarar(u.email)}  web=${!!u.supabase_auth_id}`);
}
salir(1, `ROJO: ${sinProbar.length} correo(s) sin probar`);
