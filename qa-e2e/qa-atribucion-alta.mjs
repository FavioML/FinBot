// E2E del ESLABÓN: ¿una alta por WhatsApp queda con el canal que la trajo?
//
// Es la mitad de producción de la Acción 1 del audit de SEO del 2026-09-09. La otra mitad —que el
// salto neto.pe → wa.me conserve el UTM— la verifica `landing/scripts/verify-atribucion.mjs` en un
// navegador real. Las dos por separado no sirven de nada: la landing puede inyectar `[hero|ig]`
// perfecto y el backend tirarlo (que es lo que venía pasando, medido: 0 de 48 altas de agosto con
// canal), o el backend puede parsear impecable una etiqueta que nadie le manda.
//
// POR QUÉ NO ALCANZA `tests/lib/atribucion.test.js`. Ese test corre contra un doble de Supabase, o
// sea que no puede ver lo único que sólo existe en producción: que las columnas estén (migración
// 084), que el CHECK de largo no rechace lo que el parser produce, y que el UPDATE llegue a pasar
// por RLS con la service key. Un test unitario verde sobre una columna que no existe es el caso
// exacto que este archivo cubre.
//
// Corre EN PROCESO (el Express real, webhooks firmados, Supabase real), así que valida el código
// del working tree — **no** el deploy. La frescura del deploy es otro check (`backend-deploy-fresh`
// + `/version`), y contra producción este mismo invariante se comprueba por efecto, leyendo
// `usuarios.origen` de las altas nuevas.
//
// ESCRIBE (crea y muta usuarios), así que es MANUAL post-deploy y NO va al canary: el canary sólo
// lleva lo que se rompe sin un commit. Usuarios throwaway con `is_test_user: true` y un `whatsapp`
// único por corrida, borrados al final — cero envíos a Meta, cero contacto con usuarios reales.
//
// Correr:  node qa-e2e/qa-atribucion-alta.mjs   (desde app/)  → exit 0 si pasa.

import { startWebhookHarness } from './webhook-harness.mjs';

const RUN = Date.now();
const WA_CON = 'qa-atr-con-' + RUN;       // CTA con origen
const WA_SIN = 'qa-atr-sin-' + RUN;       // CTA de un link viejo, sin origen
const WA_VET = 'qa-atr-vet-' + RUN;       // usuario con el alta ya cerrada
const WA_NADA = 'qa-atr-nada-' + RUN;     // primer mensaje que no es un CTA
const TODOS = [WA_CON, WA_SIN, WA_VET, WA_NADA];

const results = [];
const check = (name, cond, detail) => {
  results.push({ name, pass: !!cond, detail });
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail ? '  — ' + detail : ''));
  return !!cond;
};

const creados = [];

const leer = async (h, wa) => {
  const { data } = await h.supabase.from('usuarios')
    .select('id, origen, origen_cta, onboarding_completado').eq('whatsapp', wa).maybeSingle();
  return data;
};

async function sembrar(h, wa, extra = {}) {
  const { data } = await h.supabase.from('usuarios').insert({
    whatsapp: wa, is_test_user: true, onboarding_paso: 0, onboarding_completado: false,
    nombre: null, plan: 'free', ...extra,
  }).select('id').single();
  if (data) creados.push(data.id);
  return data;
}

async function mandar(h, texto, wa) {
  const before = h.sent.length;
  await h.postText(texto, wa);
  await h.waitForReply(before);
}

async function run(h) {
  // ── 1. El camino que importa: CTA con origen sobre un alta abierta ──────────────────────────
  await sembrar(h, WA_CON);
  await mandar(h, 'Hola Neto, quiero empezar [hero|ig] 👋', WA_CON);
  const uCon = await leer(h, WA_CON);
  check('un CTA con origen deja el canal Y el botón en la fila',
    uCon?.origen === 'ig' && uCon?.origen_cta === 'hero',
    'origen=' + uCon?.origen + ' cta=' + uCon?.origen_cta);

  // Y el origen no se mueve con el segundo mensaje del alta: primer toque, no último. Acá se
  // ejercita de verdad la carrera que el `.is('origen', null)` del UPDATE cierra, porque esta
  // segunda llamada RE-LEE la fila de la base (no reusa el objeto en memoria).
  await mandar(h, 'Hola Neto, quiero empezar [pricing-pro|tiktok] 👋', WA_CON);
  const uCon2 = await leer(h, WA_CON);
  check('un segundo CTA NO pisa el primer toque',
    uCon2?.origen === 'ig' && uCon2?.origen_cta === 'hero',
    'origen=' + uCon2?.origen + ' cta=' + uCon2?.origen_cta);

  // ── 2. Link viejo: sin `|origen`, queda 'directo' y NO null ─────────────────────────────────
  // Hay links con `[hero]` publicados en captions y en el blog. NULL significa "alta anterior a la
  // medición"; esta alta SÍ se midió y el link no decía de dónde. Son dos cosas distintas.
  await sembrar(h, WA_SIN);
  await mandar(h, 'Hola Neto, quiero empezar [hero] 👋', WA_SIN);
  const uSin = await leer(h, WA_SIN);
  check('un link viejo sin origen queda "directo", con su posición',
    uSin?.origen === 'directo' && uSin?.origen_cta === 'hero',
    'origen=' + uSin?.origen + ' cta=' + uSin?.origen_cta);

  // ── 3. La guarda que protege la serie histórica ─────────────────────────────────────────────
  // Las 100+ filas que ya existen tienen origen NULL. Si un veterano que hoy hace clic en un CTA
  // se reetiquetara, el número de "altas con origen" quedaría contaminado con fechas de hoy justo
  // cuando se empieza a leer. Por eso la condición es el alta ABIERTA, no sólo el origen vacío.
  await sembrar(h, WA_VET, { onboarding_completado: true, nombre: 'Veterano QA' });
  await mandar(h, 'Hola Neto, quiero empezar [hero|ig] 👋', WA_VET);
  const uVet = await leer(h, WA_VET);
  check('un alta YA CERRADA no se reetiqueta',
    uVet?.origen === null && uVet?.origen_cta === null,
    'origen=' + uVet?.origen + ' cta=' + uVet?.origen_cta);

  // ── 4. Control negativo: sin etiqueta no se inventa nada ────────────────────────────────────
  // Sin esto, los tres checks de arriba serían compatibles con un código que escribe 'directo' en
  // toda alta nueva. Es la diferencia entre medir el parser y medir que algo escribió.
  await sembrar(h, WA_NADA);
  await mandar(h, 'hola', WA_NADA);
  const uNada = await leer(h, WA_NADA);
  check('un primer mensaje que no es un CTA no inventa origen',
    uNada?.origen === null && uNada?.origen_cta === null,
    'origen=' + uNada?.origen + ' cta=' + uNada?.origen_cta);

  // ── 5. El CHECK de largo de la 084 acepta lo que el parser produce ──────────────────────────
  // El parser topa en 24/40 chars y la columna en 40. Si alguien bajara el CHECK, el UPDATE
  // fallaría en silencio del lado de Postgres y la atribución se perdería sin que nada se rompa.
  const largo = 'b'.repeat(40);
  const { error: errLargo } = await h.supabase.from('usuarios')
    .update({ origen: largo, origen_cta: 'a'.repeat(24) }).eq('id', creados[0]);
  check('la columna acepta el valor más largo que el parser puede producir', !errLargo,
    errLargo ? errLargo.message : '40 chars de origen + 24 de posición');
}

async function cleanup(h) {
  for (const wa of TODOS) {
    const u = await leer(h, wa);
    if (u?.id && !creados.includes(u.id)) creados.push(u.id);
  }
  for (const id of creados) {
    await h.supabase.from('transacciones').delete().eq('usuario_id', id);
    await h.supabase.from('conversaciones').delete().eq('usuario_id', id);
    await h.supabase.from('categorias_usuario').delete().eq('usuario_id', id);
    await h.supabase.from('usuarios').delete().eq('id', id);
  }
  const restantes = [];
  for (const wa of TODOS) if (await leer(h, wa)) restantes.push(wa);
  check('se borraron los usuarios throwaway', restantes.length === 0,
    restantes.length ? 'quedaron: ' + restantes.join(', ') : creados.length + ' borrados');
}

const h = await startWebhookHarness();
let fatal = null;
try { await run(h); } catch (e) { fatal = e; console.log('FAIL excepción — ' + e.message); }
try { await cleanup(h); } catch (e) { console.log('FAIL limpieza — ' + e.message); fatal = fatal || e; }
await h.close();

const fallidos = results.filter((r) => !r.pass);
console.log('\n=== ' + (results.length - fallidos.length) + '/' + results.length + ' checks OK ===');
if (fatal) console.log(fatal.stack);
process.exit(fallidos.length === 0 && !fatal ? 0 : 1);
