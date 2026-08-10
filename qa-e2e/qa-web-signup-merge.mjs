// Harness del merge de identidad web-first (migración 046, función merge_and_link).
//
// Verifica a nivel DB (service-role) el corazón del sprint de onboarding web: cuando
// una cuenta nacida en web vincula por reverse-OTP un número que ya tenía su propia
// fila, las dos filas se fusionan en UNA sola de forma atómica, sin duplicar ni perder
// data, sin degradar un Pro, y rechazando los bordes inseguros.
//
// Escenarios:
//   1) Merge feliz: survivor = fila web (auth_id, sin número), loser = fila WhatsApp
//      (número + data + premium + BSUID). Tras el merge: loser borrado, survivor con el
//      número Y el BSUID, TODOS los hijos repunteados (union), plan premium conservado.
//   2) Conflicto auth_id: loser ya ligado a OTRA cuenta Google → 'conflict', 2 filas intactas.
//   3) Conflicto espacio compartido: ambos en el mismo space → 'conflict', 2 filas intactas.
//   5) Esquema vivo vs árbol: las columnas que PostgREST publica para `usuarios` son las que
//      el repo cree que existen, y cada una está fusionada o declarada como no-fusionada.
//
// El escenario 5 es la mitad que el guard hermético no puede dar. `tests/merge-and-link-
// columnas.test.js` compara el árbol consigo mismo, así que una columna creada directamente en
// prod —sin archivo de migración— le es invisible, y ese caso tiene precedente acá (la 059
// documenta un hotfix remoto sin espejo local, drift D4). Acá la lista sale de la DB real.
//
// Requiere la migración 046 aplicada (la función merge_and_link debe existir).
// Se limpia solo (try/finally, filas is_test_user con marcador QA-MERGE).
//
// Uso: node qa-web-signup-merge.mjs
// Service role: SUPABASE_SERVICE_ROLE_KEY del entorno, de ~/.config/neto/qa.env, o de webapp/.env.local.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { clienteGuardado } from './lib/qa-guard.mjs';
import { NO_SE_FUSIONAN, columnasSegunElArbol, mergeVigente } from './lib/usuarios-columnas.mjs';

const TAG = 'QA-MERGE';

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

const qaEnv = loadEnv(join(homedir(), '.config', 'neto', 'qa.env'));
const webEnv = loadEnv(new URL('../webapp/.env.local', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));

const SUPA = qaEnv.NETO_QA_URL || webEnv.NEXT_PUBLIC_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE =
  qaEnv.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  webEnv.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPA || !SERVICE) {
  console.error(`[${TAG}] Falta SUPABASE_URL o SERVICE_ROLE_KEY (qa.env / env / webapp/.env.local).`);
  process.exit(2);
}

const db = clienteGuardado(SUPA, SERVICE, { auth: { persistSession: false } });

let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}`); }
}

// Marcador único por corrida para aislar y limpiar.
const RUN = randomUUID().slice(0, 8);
const numero = () => '519' + String(Math.floor(10000000 + Math.random() * 89999999));

async function crearUsuario({ whatsapp = null, authId = null, plan = 'free', premiumVence = null, bsuid = null }) {
  const { data, error } = await db.from('usuarios').insert({
    whatsapp,
    supabase_auth_id: authId,
    nombre: `QA-MERGE ${RUN}`,
    plan,
    premium_vence: premiumVence,
    bsuid,
    onboarding_completado: true,
    is_test_user: true,
  }).select('id').single();
  if (error) throw new Error('crearUsuario: ' + error.message);
  return data.id;
}

async function seedHijos(usuarioId, marca) {
  await db.from('transacciones').insert([
    { usuario_id: usuarioId, monto: 10, monto_pen: 10, tipo: 'gasto', categoria: 'Otros', comercio: `${marca}-a`, fecha: '2026-07-01' },
    { usuario_id: usuarioId, monto: 20, monto_pen: 20, tipo: 'gasto', categoria: 'Otros', comercio: `${marca}-b`, fecha: '2026-07-02' },
  ]);
  await db.from('categorias_usuario').insert({ usuario_id: usuarioId, nombre: `Cat-${marca}`, emoji: '🧪' });
  await db.from('presupuestos').insert({ usuario_id: usuarioId, categoria: `Otros-${marca}`, monto_limite: 500, mes: 7, anio: 2026 });
}

async function contarTx(usuarioId) {
  const { count } = await db.from('transacciones').select('id', { count: 'exact', head: true }).eq('usuario_id', usuarioId);
  return count || 0;
}
async function existeUsuario(id) {
  const { data } = await db.from('usuarios').select('id').eq('id', id).maybeSingle();
  return !!data;
}
async function borrarUsuario(id) {
  if (id) await db.from('usuarios').delete().eq('id', id);
}

async function escenarioFeliz() {
  console.log(`\n[${TAG}] 1) Merge feliz (web + WhatsApp premium → una fila)`);
  let survivor, loser;
  try {
    const authWeb = randomUUID();
    // El BSUID va en la fila de WhatsApp porque ahí es donde Meta lo deja (migración 065), y
    // esa fila es el LOSER: sin la línea de la 066 el merge lo borra con ella (B13).
    const bsuidWA = `PE.QA${RUN}${Math.floor(Math.random() * 1e6)}`;
    survivor = await crearUsuario({ authId: authWeb, plan: 'free' });
    loser = await crearUsuario({ whatsapp: numero(), plan: 'premium', premiumVence: '2027-01-01', bsuid: bsuidWA });
    await seedHijos(survivor, 'web');   // el web ya registró algo por la app
    await seedHijos(loser, 'wa');       // el WhatsApp tenía su historial

    const txSurvAntes = await contarTx(survivor);
    const txLoserAntes = await contarTx(loser);
    ok(txSurvAntes === 2 && txLoserAntes === 2, `seed: 2 tx c/u (surv=${txSurvAntes}, loser=${txLoserAntes})`);

    const { data: result, error } = await db.rpc('merge_and_link', { p_survivor: survivor, p_loser: loser });
    ok(!error, `rpc sin error${error ? ': ' + error.message : ''}`);
    ok(result === 'linked', `resultado 'linked' (got '${result}')`);

    ok(!(await existeUsuario(loser)), 'loser borrado');
    ok(await existeUsuario(survivor), 'survivor vive');

    const { data: surv } = await db.from('usuarios').select('whatsapp, plan, premium_vence, supabase_auth_id, bsuid').eq('id', survivor).single();
    ok(!!surv.whatsapp, `survivor quedó con número (${surv.whatsapp})`);
    ok(surv.plan === 'premium', 'survivor NO degradado (premium)');
    ok(String(surv.premium_vence).startsWith('2027-01-01'), 'premium_vence conservado');
    ok(surv.supabase_auth_id === authWeb, 'survivor conserva su auth_id');
    // B13: si esto falla, al usuario que active un username dejamos de reconocerlo y no hay
    // camino de vuelta — el BSUID solo lo vuelve a mandar Meta si la persona escribe antes.
    ok(surv.bsuid === bsuidWA, `survivor heredó el BSUID del WhatsApp (${surv.bsuid || 'NULL'})`);

    const txSurvDespues = await contarTx(survivor);
    ok(txSurvDespues === 4, `union de transacciones (4, got ${txSurvDespues})`);
    const { count: catCount } = await db.from('categorias_usuario').select('id', { count: 'exact', head: true }).eq('usuario_id', survivor);
    ok((catCount || 0) === 2, `categorías unidas (2, got ${catCount})`);
  } finally {
    await borrarUsuario(survivor);
    await borrarUsuario(loser);
  }
}

async function escenarioConflictoAuth() {
  console.log(`\n[${TAG}] 2) Conflicto: número ligado a otra cuenta Google`);
  let survivor, loser;
  try {
    survivor = await crearUsuario({ authId: randomUUID() });
    loser = await crearUsuario({ whatsapp: numero(), authId: randomUUID() }); // ya tiene OTRO auth_id
    const { data: result, error } = await db.rpc('merge_and_link', { p_survivor: survivor, p_loser: loser });
    ok(!error, `rpc sin error${error ? ': ' + error.message : ''}`);
    ok(result === 'conflict', `resultado 'conflict' (got '${result}')`);
    ok(await existeUsuario(survivor), 'survivor intacto');
    ok(await existeUsuario(loser), 'loser intacto (no se tocó)');
  } finally {
    await borrarUsuario(survivor);
    await borrarUsuario(loser);
  }
}

async function escenarioConflictoEspacio() {
  console.log(`\n[${TAG}] 3) Conflicto: ambos en el mismo espacio compartido`);
  let survivor, loser, spaceId;
  try {
    survivor = await crearUsuario({ authId: randomUUID() });
    loser = await crearUsuario({ whatsapp: numero() });
    const { data: space, error: eSpace } = await db.from('shared_spaces')
      .insert({ name: `QA-MERGE ${RUN}`, invite_code: `QAM${RUN}`, created_by: survivor }).select('id').single();
    if (eSpace) throw new Error('crear space: ' + eSpace.message);
    spaceId = space.id;
    await db.from('space_members').insert([
      { space_id: spaceId, user_id: survivor },
      { space_id: spaceId, user_id: loser },
    ]);
    const { data: result, error } = await db.rpc('merge_and_link', { p_survivor: survivor, p_loser: loser });
    ok(!error, `rpc sin error${error ? ': ' + error.message : ''}`);
    ok(result === 'conflict', `resultado 'conflict' (got '${result}')`);
    ok(await existeUsuario(survivor) && await existeUsuario(loser), 'ambas filas intactas');
  } finally {
    if (spaceId) await db.from('shared_spaces').delete().eq('id', spaceId);
    await borrarUsuario(survivor);
    await borrarUsuario(loser);
  }
}

async function escenarioColisiones() {
  console.log(`\n[${TAG}] 4) Colisiones de unique (categorías/presupuesto idénticos a ambos lados)`);
  let survivor, loser;
  try {
    survivor = await crearUsuario({ authId: randomUUID() });
    loser = await crearUsuario({ whatsapp: numero() });
    // Mismos nombres a ambos lados: sin dedup, el merge abortaría por unique_violation.
    for (const uid of [survivor, loser]) {
      await db.from('categorias_usuario').insert([
        { usuario_id: uid, nombre: 'Alimentación', emoji: '🍽️' },
        { usuario_id: uid, nombre: 'Transporte', emoji: '🚌' },
      ]);
      await db.from('presupuestos').insert({ usuario_id: uid, categoria: 'Comida', monto_limite: 300, mes: 7, anio: 2026 });
    }
    // Dato único solo del lado WhatsApp: debe migrar igual.
    await db.from('categorias_usuario').insert({ usuario_id: loser, nombre: 'SoloWhatsApp', emoji: '📲' });

    const { data: result, error } = await db.rpc('merge_and_link', { p_survivor: survivor, p_loser: loser });
    ok(!error, `rpc sin error${error ? ': ' + error.message : ''}`);
    ok(result === 'linked', `resultado 'linked' pese a colisiones (got '${result}')`);
    ok(!(await existeUsuario(loser)), 'loser borrado');

    const { count: alim } = await db.from('categorias_usuario').select('id', { count: 'exact', head: true }).eq('usuario_id', survivor).eq('nombre', 'Alimentación');
    ok(alim === 1, `'Alimentación' deduplicada (1, got ${alim})`);
    const { count: solo } = await db.from('categorias_usuario').select('id', { count: 'exact', head: true }).eq('usuario_id', survivor).eq('nombre', 'SoloWhatsApp');
    ok(solo === 1, `categoría única del WhatsApp migró (1, got ${solo})`);
    const { count: pres } = await db.from('presupuestos').select('id', { count: 'exact', head: true }).eq('usuario_id', survivor).eq('categoria', 'Comida').eq('mes', 7).eq('anio', 2026);
    ok(pres === 1, `presupuesto duplicado deduplicado (1, got ${pres})`);
  } finally {
    await borrarUsuario(survivor);
    await borrarUsuario(loser);
  }
}

// El esquema que PostgREST publica. `GET /rest/v1/` devuelve el OpenAPI con las columnas de
// cada tabla, o sea la DB REAL — no lo que el repo cree. Es la única fuente acá que puede
// delatar una columna creada a mano en la consola de Supabase.
async function columnasVivas() {
  const res = await fetch(`${SUPA}/rest/v1/`, {
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` },
  });
  if (!res.ok) throw new Error(`OpenAPI de PostgREST: HTTP ${res.status}`);
  const spec = await res.json();
  const props = spec?.definitions?.usuarios?.properties;
  if (!props || !Object.keys(props).length) throw new Error('el OpenAPI no trae las columnas de `usuarios`');
  return new Set(Object.keys(props).map((c) => c.toLowerCase()));
}

async function escenarioEsquema() {
  console.log(`\n[${TAG}] 5) Esquema vivo de usuarios vs lo que el repo declara`);
  const { archivo, cols: nombradas, bloques } = mergeVigente();
  ok(bloques === 2, `parseada la migración vigente del merge (${archivo}, ${bloques} UPDATE)`);

  let vivas;
  try {
    vivas = await columnasVivas();
  } catch (e) {
    // Sin la lista viva no hay veredicto. Marcarlo como fallo y no como "ok, no pude" es
    // deliberado: un check que se vuelve no-op cuando su fuente no responde es verde por
    // vacuidad, que es justo la clase de guard que esta auditoría vino a arreglar.
    ok(false, `no se pudo leer el esquema vivo: ${e.message}`);
    return;
  }
  ok(vivas.size > 20, `PostgREST publicó ${vivas.size} columnas de usuarios`);

  const arbol = columnasSegunElArbol();
  // Dirección peligrosa: existe en prod y el árbol no la conoce → el guard hermético no la
  // puede clasificar, así que nadie decidió nunca qué hace el merge con ella.
  const soloEnProd = [...vivas].filter((c) => !arbol.has(c)).sort();
  ok(soloEnProd.length === 0,
    soloEnProd.length
      ? `columnas en prod que NO declara ningún archivo: ${soloEnProd.join(', ')} — hace falta ` +
        'la migración que las cree (regla append-only de .claude/rules/database.md); mientras ' +
        'tanto el guard de tests/merge-and-link-columnas.test.js no las ve'
      : 'ninguna columna de prod queda fuera de migrations/');

  // La otra dirección es benigna pero vale nombrarla: el árbol declara algo que prod no tiene
  // (una migración sin aplicar, o una columna borrada a mano).
  const soloEnArbol = [...arbol].filter((c) => !vivas.has(c)).sort();
  ok(soloEnArbol.length === 0,
    soloEnArbol.length
      ? `el árbol declara columnas que prod no tiene: ${soloEnArbol.join(', ')} (¿migración sin aplicar?)`
      : 'toda columna declarada existe en prod');

  // Y el veredicto de siempre, pero contra la lista VIVA en vez de la derivada.
  const sinClasificar = [...vivas].filter((c) => !nombradas.has(c) && !(c in NO_SE_FUSIONAN)).sort();
  ok(sinClasificar.length === 0,
    sinClasificar.length
      ? `columnas vivas que el merge ni fusiona ni declara excluidas: ${sinClasificar.join(', ')}`
      : 'toda columna viva está fusionada o declarada como no-fusionada');
}

(async () => {
  console.log(`[${TAG}] Merge de identidad web-first — run ${RUN}`);
  try {
    await escenarioFeliz();
    await escenarioConflictoAuth();
    await escenarioConflictoEspacio();
    await escenarioColisiones();
    await escenarioEsquema();
  } catch (e) {
    console.error(`[${TAG}] Error fatal:`, e.message);
    fail++;
  }
  console.log(`\n[${TAG}] Resultado: ${pass} ok, ${fail} fallos`);
  process.exit(fail === 0 ? 0 : 1);
})();
