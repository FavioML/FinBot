// El cascade de un rename/borrado de categoría alcanza a TODAS las tablas declaradas,
// medido por el endpoint REAL de app.neto.pe (no por una llamada directa a la función).
//
// EL DEFECTO QUE VIENE A CERRAR (2026-08-12, clase `consumidor-no-actualizado`).
// `/api/categories` reetiquetaba tres tablas —`transacciones`, `presupuestos`,
// `reglas_comercio`— y el esquema tiene más. Renombrar una categoría raíz dejaba los
// gastos compartidos y las alertas del detector de fugas apuntando al nombre viejo:
// sin error, sin log, sin nada que el usuario pudiera ver más allá de que esas filas
// dejaban de agrupar con el resto. Y en `spending_alerts` no era cosmético: `category`
// es la clave de dedup de /api/alerts y el argumento del botón "ponle un límite", que
// crea un presupuesto con ese nombre.
//
// POR QUÉ HACE FALTA ADEMÁS DE LOS OTROS DOS GUARDS. Son tres preguntas distintas:
//   · `webapp/src/lib/category-cascade.test.ts` — ¿el código hace lo que la
//     declaración dice? Hermético, con un cliente falso. No toca la DB.
//   · `qa-e2e/qa-categorias-cascade-schema.mjs` — ¿la declaración describe la DB?
//     Lee el esquema vivo. No ejecuta una sola línea del cascade.
//   · ESTE — ¿el UPDATE realmente pega en Postgres? Es el único que ve un `ilike` mal
//     escapado, un nombre de columna que no existe en esa tabla, una policy que
//     bloquea, o un `owner` equivocado. Los dos de arriba pasan en verde con todo eso.
//
// AISLAMIENTO: siembra sus propias filas marcadas QA-CASC bajo el usuario QA, y las
// borra en el `finally`. Toda escritura pasa por la barrera de qa-guard.
//
// Uso: node qa-categorias-cascade-e2e.mjs
// Creds: ~/.config/neto/qa.env. Exit 0 = todo PASS · 1 = alguna falló · 2 = setup.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { clienteGuardado, permitirFila } from './lib/qa-guard.mjs';

const APP = process.env.NETO_APP_URL || 'https://app.neto.pe';
const TAG = 'QA-CASC';

function loadEnv(path) {
  const env = {};
  try {
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* opcional */ }
  return env;
}

const env = loadEnv(join(homedir(), '.config', 'neto', 'qa.env'));
const webEnv = loadEnv(new URL('../webapp/.env.local', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));

const SUPA = env.NETO_QA_URL || webEnv.NEXT_PUBLIC_SUPABASE_URL;
const ANON = env.NETO_QA_ANON;
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || webEnv.SUPABASE_SERVICE_ROLE_KEY;
const USER = { email: env.NETO_QA_EMAIL, password: env.NETO_QA_PASSWORD, uid: env.NETO_QA_USUARIO_ID };

if (!SUPA || !ANON || !USER.email || !USER.password || !USER.uid || !SERVICE) {
  console.error(`[${TAG}] Faltan creds en ~/.config/neto/qa.env (NETO_QA_* + SUPABASE_SERVICE_ROLE_KEY).`);
  process.exit(2);
}

const db = clienteGuardado(SUPA, SERVICE);
const cookieName = `sb-${new URL(SUPA).hostname.split('.')[0]}-auth-token`;

async function login() {
  const grant = await fetch(`${SUPA}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: USER.email, password: USER.password }),
  });
  if (!grant.ok) throw new Error(`password grant: HTTP ${grant.status}`);
  const value = 'base64-' + Buffer.from(JSON.stringify(await grant.json()), 'utf8').toString('base64url');
  const MAX = 3180;
  if (value.length <= MAX) return `${cookieName}=${value}`;
  const pairs = [];
  for (let i = 0, p = 0; p < value.length; i++, p += MAX) pairs.push(`${cookieName}.${i}=${value.slice(p, p + MAX)}`);
  return pairs.join('; ');
}

async function api(cookie, method, path, body) {
  const r = await fetch(`${APP}${path}`, {
    method,
    headers: { Cookie: cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  const text = await r.text().catch(() => '');
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* no-json */ }
  return { status: r.status, json, text };
}

let pass = 0, fail = 0;
function ok(cond, label, detalle) {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${detalle ? ` — ${detalle}` : ''}`); }
}

const VIEJO = `${TAG} Vieja`;
const NUEVO = `${TAG} Nueva`;
const SUB_VIEJA = `${TAG} SubVieja`;
const SUB_NUEVA = `${TAG} SubNueva`;
const sembradas = { transacciones: [], presupuestos: [], reglas_comercio: [], gastos_compartidos: [], spending_alerts: [] };

/** Siembra UNA fila por tabla del cascade, todas con la categoría vieja. */
async function sembrar() {
  const ins = async (tabla, fila) => {
    const { data, error } = await db.from(tabla).insert(fila).select('id').single();
    if (error) throw new Error(`sembrar ${tabla}: ${error.message}`);
    permitirFila(data.id);
    sembradas[tabla].push(data.id);
    return data.id;
  };
  await ins('transacciones', {
    usuario_id: USER.uid, tipo: 'gasto', monto: 1.23, monto_pen: 1.23, moneda: 'PEN',
    comercio: `${TAG} comercio`, categoria: VIEJO, subcategoria: SUB_VIEJA,
    fecha: new Date().toISOString().slice(0, 10), confirmado: false,
  });
  await ins('presupuestos', {
    usuario_id: USER.uid, categoria: VIEJO, subcategoria: SUB_VIEJA, monto_limite: 100,
    mes: new Date().getMonth() + 1, anio: new Date().getFullYear(),
  });
  await ins('reglas_comercio', {
    usuario_id: USER.uid, comercio_pattern: `${TAG.toLowerCase()} pattern`,
    categoria: VIEJO, subcategoria: SUB_VIEJA,
  });
  await ins('gastos_compartidos', {
    creador_id: USER.uid, descripcion: `${TAG} split`, monto_total: 10, moneda: 'PEN',
    categoria: VIEJO, fecha: new Date().toISOString().slice(0, 10),
  });
  await ins('spending_alerts', {
    user_id: USER.uid, type: 'spike', category: VIEJO, amount: 10, comparison_amount: 5,
    message: `${TAG} alerta sembrada`,
  });
}

/** Lee la columna de categoría de cada fila sembrada. */
async function leerCategorias() {
  const out = {};
  for (const [tabla, ids] of Object.entries(sembradas)) {
    if (!ids.length) continue;
    const col = tabla === 'gastos_compartidos' ? 'categoria' : tabla === 'spending_alerts' ? 'category' : 'categoria';
    const sub = ['transacciones', 'presupuestos', 'reglas_comercio'].includes(tabla) ? ', subcategoria' : '';
    const { data, error } = await db.from(tabla).select(`id, ${col}${sub}`).in('id', ids);
    if (error) throw new Error(`leer ${tabla}: ${error.message}`);
    out[tabla] = data.map((r) => ({ cat: r[col], sub: r.subcategoria ?? null }));
  }
  return out;
}

async function limpiar() {
  for (const [tabla, ids] of Object.entries(sembradas)) {
    if (ids.length) await db.from(tabla).delete().in('id', ids);
  }
  const { data } = await db.from('categorias_usuario').select('id, padre_id')
    .eq('usuario_id', USER.uid).ilike('nombre', `${TAG}%`);
  // Las subs antes que las raíces, por el FK padre_id.
  for (const c of (data || []).filter((c) => c.padre_id)) await db.from('categorias_usuario').delete().eq('id', c.id);
  for (const c of (data || []).filter((c) => !c.padre_id)) await db.from('categorias_usuario').delete().eq('id', c.id);
}

const cookie = await login();
await limpiar(); // por si una corrida previa se cayó a la mitad

try {
  console.log(`[${TAG}] 1) Renombrar una categoría RAÍZ`);
  const root = await api(cookie, 'POST', '/api/categories', { nombre: VIEJO });
  if (root.status !== 201 || !root.json?.id) {
    console.error(`  no se pudo crear la raíz de prueba: HTTP ${root.status} ${root.text.slice(0, 200)}`);
    process.exitCode = 2;
  } else {
    const rootId = root.json.id;
    const sub = await api(cookie, 'POST', '/api/categories', { nombre: SUB_VIEJA, padreId: rootId });
    ok(sub.status === 201, 'sub de prueba creada', `HTTP ${sub.status}`);
    await sembrar();

    const antes = await leerCategorias();
    // Anti-vacuidad: si la siembra no dejó las filas con el nombre viejo, el PASS de
    // abajo no significaría nada (todo diría "no es el nombre viejo" desde el arranque).
    ok(
      Object.values(antes).every((filas) => filas.every((f) => f.cat === VIEJO)),
      `las 5 filas sembradas arrancan con "${VIEJO}"`,
      JSON.stringify(antes)
    );

    const put = await api(cookie, 'PUT', '/api/categories', { id: rootId, nombre: NUEVO });
    ok(put.status === 200, 'PUT rename -> 200', `HTTP ${put.status} ${put.text.slice(0, 150)}`);

    const despues = await leerCategorias();
    for (const [tabla, filas] of Object.entries(despues)) {
      ok(
        filas.every((f) => f.cat === NUEVO),
        `${tabla}: el rename llegó (${VIEJO} → ${NUEVO})`,
        `quedó ${JSON.stringify(filas.map((f) => f.cat))}`
      );
    }

    console.log(`\n[${TAG}] 2) Renombrar una SUBcategoría`);
    const subId = (sub.json && sub.json.id) || null;
    if (subId) {
      const putSub = await api(cookie, 'PUT', '/api/categories', { id: subId, nombre: SUB_NUEVA });
      ok(putSub.status === 200, 'PUT rename de sub -> 200', `HTTP ${putSub.status}`);
      const d2 = await leerCategorias();
      for (const tabla of ['transacciones', 'presupuestos', 'reglas_comercio']) {
        ok(
          // Case-insensitive a propósito, y NO por prolijidad: prod normaliza
          // `transacciones.subcategoria` a "Primera-mayúscula resto-minúscula" — medido
          // el 12-ago-2026 con un insert de control (escribís 'QA MixedSub', leés
          // 'Qa mixedsub'), y no hay migración que lo declare. `categoria` no se toca.
          // Afirmar igualdad exacta acá dejaría este harness rojo para siempre por algo
          // que no es el cascade. El centinela sufre lo mismo y es un bug aparte
          // (499 de 2233 filas guardan 'Sin_categoria'); está reportado por separado.
          d2[tabla].every((f) => (f.sub || '').toLowerCase() === SUB_NUEVA.toLowerCase()),
          `${tabla}: el rename de sub llegó (${SUB_VIEJA} → ${SUB_NUEVA})`,
          `quedó ${JSON.stringify(d2[tabla].map((f) => f.sub))}`
        );
      }
    }

    console.log(`\n[${TAG}] 3) Borrar la categoría RAÍZ`);
    const del = await api(cookie, 'DELETE', `/api/categories?id=${rootId}`);
    ok(del.status === 200, 'DELETE -> 200', `HTTP ${del.status}`);
    const d3 = await leerCategorias();
    // La política declarada, tabla por tabla: la plata se DESETIQUETA (nunca se borra),
    // y lo que apuntando a una categoría inexistente sería peor que nada, se va.
    ok(d3.transacciones?.length === 1 && d3.transacciones[0].cat === null,
      'transacciones: la fila SIGUE viva y suelta la categoría (no se borra plata)',
      JSON.stringify(d3.transacciones));
    ok((d3.transacciones?.[0]?.sub || '').toLowerCase() === 'sin_categoria',
      'transacciones: queda con el centinela que enciende "Por revisar"',
      `quedó ${JSON.stringify(d3.transacciones?.[0]?.sub)} (ojo: prod lo guarda como 'Sin_categoria')`);
    ok(d3.gastos_compartidos?.length === 1 && d3.gastos_compartidos[0].cat === null,
      'gastos_compartidos: la fila sigue viva y suelta la categoría',
      JSON.stringify(d3.gastos_compartidos));
    for (const tabla of ['presupuestos', 'reglas_comercio', 'spending_alerts']) {
      ok((d3[tabla] || []).length === 0,
        `${tabla}: la fila se borró (apuntar a una categoría inexistente es peor que nada)`,
        `quedaron ${(d3[tabla] || []).length}`);
    }
  }
  console.log(`\n[${TAG}] 4) Una categoría llamada "*" no puede barrer todo`);
  // El agujero medido el 12-ago-2026: PostgREST traduce `*` a `%` en `ilike`, del lado
  // del SERVIDOR, así que ningún escape del cliente lo salva. Con las políticas `delete`
  // de CASCADE_REFS eso es un DELETE sin `where` sobre presupuestos, reglas y alertas
  // del usuario. Este es el único de los tres guards que lo prueba contra Postgres de
  // verdad: el hermético afirma sobre el patrón, no sobre lo que Postgres hace con él.
  //
  // El control es lo que le da sentido: se siembra una fila CON `*` y otra SIN, y se
  // exige que el borrado se lleve la primera y deje viva la segunda.
  const CTRL = `${TAG} Testigo`;
  const { data: testigo, error: eT } = await db.from('spending_alerts').insert({
    user_id: USER.uid, type: 'spike', category: CTRL, amount: 1, comparison_amount: 1,
    message: `${TAG} testigo`,
  }).select('id').single();
  if (eT) {
    ok(false, 'no se pudo sembrar el testigo', eT.message);
  } else {
    permitirFila(testigo.id);
    sembradas.spending_alerts.push(testigo.id);
    // El MISMO agujero, un paso ANTES del cascade: el POST busca la fila existente con
    // el mismo filtro. Se crea primero una raíz normal y ACTIVA, y después la del `*`.
    // Con `ilike`, el segundo POST encuentra a la primera y responde 409 DUPLICATE (o,
    // si estuviera inactiva, la reactiva y la RENOMBRA a `*` — un hijack que devuelve
    // 200 con el nombre pedido, o sea invisible si uno solo mira el nombre; por eso la
    // aserción es sobre el testigo, que es lo que no puede fingirse).
    const alpha = await api(cookie, 'POST', '/api/categories', { nombre: `${TAG} Alpha` });
    ok(alpha.status === 201, 'raíz testigo creada', `HTTP ${alpha.status}`);
    const estrella = await api(cookie, 'POST', '/api/categories', { nombre: `${TAG} *` });
    ok(
      estrella.status === 201,
      'crear la categoría "*" NO choca contra la testigo (el `*` no es comodín)',
      `HTTP ${estrella.status} ${JSON.stringify(estrella.json)}`
    );
    const { data: alphaVive } = await db.from('categorias_usuario')
      .select('nombre').eq('id', alpha.json?.id ?? '00000000-0000-0000-0000-000000000000').maybeSingle();
    ok(alphaVive?.nombre === `${TAG} Alpha`, 'la raíz testigo conserva su nombre (no la renombró el "*")',
      JSON.stringify(alphaVive));

    if (!estrella.json?.id) {
      ok(false, `no se pudo crear la categoría con "*" (HTTP ${estrella.status}): ¿cambió cleanName?`);
    } else {
      const { data: conEstrella } = await db.from('spending_alerts').insert({
        user_id: USER.uid, type: 'spike', category: `${TAG} *`, amount: 1, comparison_amount: 1,
        message: `${TAG} estrella`,
      }).select('id').single();
      if (conEstrella) { permitirFila(conEstrella.id); sembradas.spending_alerts.push(conEstrella.id); }

      const delE = await api(cookie, 'DELETE', `/api/categories?id=${estrella.json.id}`);
      ok(delE.status === 200, 'DELETE de la categoría "*" -> 200', `HTTP ${delE.status}`);

      const { data: quedan } = await db.from('spending_alerts')
        .select('id, category').in('id', sembradas.spending_alerts);
      const nombres = (quedan || []).map((r) => r.category);
      ok(nombres.includes(CTRL), 'el testigo SOBREVIVE: el "*" no se comió las demás alertas', JSON.stringify(nombres));
      ok(!nombres.includes(`${TAG} *`), 'la alerta de la categoría "*" sí se borró', JSON.stringify(nombres));
    }
  }
} finally {
  await limpiar();
}

console.log(`\n[${TAG}] ${pass} PASS · ${fail} FAIL`);
if (fail) process.exitCode = 1;
