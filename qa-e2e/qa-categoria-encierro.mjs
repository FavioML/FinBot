// E2E del hallazgo B26: el árbol de categorías del usuario NO puede encerrar al clasificador.
//
// Reproduce el escenario exacto visto en prod el 10-ago-2026. Un usuario cuyo árbol propio son
// solo `Alimentación` y `Finanzas` escribió `"Gasté S/. 10.5 taxi"` y Neto lo guardó en
// **Finanzas > Sin_categoria**, porque `detectarCategoriaIA` le mandaba al modelo SOLO esas dos
// categorías y `Transporte` no existía como opción. El ciclo se sellaba solo: el parser proponía
// Transporte, el clasificador lo pisaba, y como Finanzas ya existía el árbol no crecía nunca.
//
// Qué ejercita, por el pipeline REAL (webhook firmado → NLP con OpenAI de verdad → intent
// registrar_manual → parser + clasificador → guardarTransaccion):
//   1. La fila queda en `Transporte`, no en la menos mala del árbol chico.
//   2. `Transporte` aparece en el árbol del usuario — sin eso el gasto se clasifica bien pero
//      la categoría no existe para `/categorias` ni para el selector de presupuestos.
//   3. CONTROL NEGATIVO: el usuario SIN árbol propio no recibe filas nuevas de categoría. Es la
//      rama que protege el menú de onboarding de `/categorias` (webhook.js:626 y :773 ramifican
//      por el `null` de `obtenerCategoriasUsuario`).
//
// Contra el código VIEJO el primer check falla: es la corrida de control que hace que este
// harness signifique algo. Vale la pena hacerla con `git stash` la primera vez.
//
// Usuarios throwaway con `is_test_user` (cero envíos a Meta), borrados al final incluidos sus
// hijos. Cuesta ~3 llamadas a gpt-4o-mini por usuario.
//
// Correr:  node qa-e2e/qa-categoria-encierro.mjs   (desde app/)  → exit 0 si pasa.

import { startWebhookHarness } from './webhook-harness.mjs';

const RUN = Math.random().toString(36).slice(2, 8);
const TAG = 'QA-B26';
const WA_ENCERRADO = 'qa-b26-enc-' + RUN;
const WA_SIN_ARBOL = 'qa-b26-vac-' + RUN;
// Monto único por corrida: dedup_hash fresco y ancla para encontrar la fila que creó este run.
const MONTO = 10 + Math.floor(Math.random() * 90) / 100;
const MSG = `Gasté S/. ${MONTO.toFixed(2)} taxi`;

let userEnc = null;
let userVac = null;

const results = [];
const check = (name, cond, detail) => {
  results.push({ name, pass: !!cond, detail });
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail ? '  — ' + detail : ''));
  return !!cond;
};

async function sembrarUsuario(h, whatsapp, nombre) {
  const { data, error } = await h.supabase.from('usuarios').insert({
    whatsapp, nombre, plan: 'premium', trial_estado: 'activo',
    onboarding_completado: true, is_test_user: true,
  }).select('id').single();
  if (error || !data) throw new Error('seed usuario: ' + (error && error.message));
  return data.id;
}

async function arbolDe(h, usuarioId) {
  const { data } = await h.supabase.from('categorias_usuario')
    .select('nombre, padre_id, activa').eq('usuario_id', usuarioId).eq('activa', true);
  return (data || []).filter(c => !c.padre_id).map(c => c.nombre).sort();
}

async function run(h) {
  // ── Seed: el árbol EXACTO del usuario real que disparó el hallazgo ──────────────────
  userEnc = await sembrarUsuario(h, WA_ENCERRADO, TAG + ' encerrado ' + RUN);
  const { error: errCats } = await h.supabase.from('categorias_usuario').insert([
    { usuario_id: userEnc, nombre: 'Alimentación', emoji: '🍽️', activa: true },
    { usuario_id: userEnc, nombre: 'Finanzas', emoji: '💰', activa: true },
  ]);
  if (!check('setup: árbol de 2 raíces sembrado, SIN Transporte', !errCats,
    errCats ? errCats.message : 'Alimentación + Finanzas')) return;

  const arbol0 = await arbolDe(h, userEnc);
  if (!check('setup: el árbol de partida no tiene Transporte',
    arbol0.length === 2 && !arbol0.includes('Transporte'), arbol0.join(', '))) return;

  // ── El mensaje que en prod cayó en Finanzas ─────────────────────────────────────────
  const before = h.sent.length;
  const status = await h.postText(MSG, WA_ENCERRADO);
  check('el webhook acepta el mensaje firmado', status === 200, 'status=' + status);
  const reply = (await h.waitForReply(before)).trim();
  console.log('\n--- respuesta al usuario ---\n' + reply + '\n');

  const { data: filas } = await h.supabase.from('transacciones')
    .select('id, categoria, subcategoria, monto').eq('usuario_id', userEnc).eq('monto', MONTO);
  const fila = (filas || [])[0];
  if (!check('se registró la transacción', !!fila, (filas || []).length + ' filas')) return;

  // ⚠️ EL CHECK DEL HALLAZGO. Contra el código viejo esto da Finanzas.
  check('la categoría NO quedó encerrada en el árbol chico: es Transporte',
    fila.categoria === 'Transporte',
    'categoria=' + fila.categoria + ' > ' + fila.subcategoria);

  // ── El árbol tiene que haber CRECIDO ────────────────────────────────────────────────
  const arbol1 = await arbolDe(h, userEnc);
  check('Transporte quedó en el árbol del usuario (visible en /categorias y presupuestos)',
    arbol1.includes('Transporte'), arbol1.join(', '));
  check('y no se duplicó ninguna de las que ya tenía',
    new Set(arbol1).size === arbol1.length && arbol1.filter(n => n === 'Alimentación').length === 1,
    arbol1.length + ' raíces');

  // ── Control negativo: el usuario SIN árbol no debe estrenar uno ─────────────────────
  userVac = await sembrarUsuario(h, WA_SIN_ARBOL, TAG + ' sin arbol ' + RUN);
  const vac0 = await arbolDe(h, userVac);
  if (!check('setup: el usuario de control arranca sin árbol propio', vac0.length === 0,
    vac0.join(', '))) return;

  const before2 = h.sent.length;
  await h.postText(MSG, WA_SIN_ARBOL);
  await h.waitForReply(before2);

  const vac1 = await arbolDe(h, userVac);
  // Si esto se rompe, `/categorias` deja de mostrar el menú de onboarding y muestra una lista
  // de un solo ítem: la regresión que la rama `sin-arbol` de asegurarCategoriaUsuario evita.
  check('al usuario sin árbol NO se le creó ninguna categoría',
    vac1.length === 0, vac1.length ? 'aparecieron: ' + vac1.join(', ') : 'sigue sin árbol');

  const { data: filasVac } = await h.supabase.from('transacciones')
    .select('categoria').eq('usuario_id', userVac).eq('monto', MONTO);
  check('y su gasto igual se clasificó bien (ya recibía las canónicas)',
    (filasVac || [])[0] && filasVac[0].categoria === 'Transporte',
    'categoria=' + ((filasVac || [])[0] || {}).categoria);
}

async function limpiar(h) {
  const ids = [userEnc, userVac].filter(Boolean);
  if (ids.length === 0) return check('limpieza: nada que borrar', true);
  for (const t of ['transacciones', 'conversaciones', 'notificaciones', 'categorias_usuario',
    'presupuestos', 'notification_deliveries']) {
    await h.supabase.from(t).delete().in('usuario_id', ids);
  }
  const { error } = await h.supabase.from('usuarios').delete().in('id', ids);
  const { data: siguen } = await h.supabase.from('usuarios').select('id').in('id', ids);
  check('limpieza: se borraron los throwaway y todo lo suyo',
    !error && (!siguen || siguen.length === 0),
    error ? error.message : ids.length + ' borrados');
}

const h = await startWebhookHarness();
let fatal = null;
try { await run(h); } catch (e) { fatal = e; console.log('FAIL excepción — ' + e.message); }
try { await limpiar(h); } catch (e) { console.log('FAIL limpieza — ' + e.message); }
await h.close();

const ok = results.filter(r => r.pass).length;
console.log(`\n=== ${ok}/${results.length} checks OK ===`);
if (fatal || ok !== results.length) process.exit(1);
