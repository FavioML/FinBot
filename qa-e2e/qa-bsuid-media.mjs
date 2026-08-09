// E2E del registro SILENCIOSO por foto: un usuario que activó un username de WhatsApp manda
// una captura de Yape. Meta no manda su número, así que no hay a dónde responderle — pero lo
// reconocemos por su BSUID y el gasto se le anota igual.
//
// Es el hermano de qa-e2e-registro-gasto-foto.mjs (mismo fixture, mismo Vision real) con la
// diferencia que importa: acá el pipeline entra por el bloque `if (!from)` de webhook.js, y
// el éxito incluye que NO se le haya respondido nada. Ese silencio se asevera: si algún día
// alguien mete un `enviarWhatsapp` en ese camino, se cae acá.
//
// Qué ejercita:
//   webhook firmado sin `from`, con `from_user_id` → buscarUsuarioPorBsuid → services/
//   registro-silencioso.js → media-intake (2 fetch a graph STUBEADOS) → Vision REAL →
//   guardarTransaccion → fila en `transacciones`, cero mensajes salientes.
//
// Tres casos. El B y el C son los que le dan valor al A:
//   A. BSUID conocido      → se registra el gasto, sin responder
//   B. BSUID desconocido    → no se registra nada y NI SIQUIERA se llama a Vision (si no,
//                             cualquiera podría quemarnos GPT-4o mandando fotos)
//   C. wamid repetido       → Meta retransmite cada 30s; la segunda no vuelve a llamar a Vision
//
// El AUDIO no está cubierto acá: haría falta un fixture de voz real y una llamada a Whisper.
// Su camino es idéntico al del texto una vez transcrito, y está cubierto en
// tests/handlers/webhook-bsuid-media.test.js. Es un hueco conocido, no un olvido.
//
// Self-cleaning: siembra su propio usuario efímero y lo borra al final, pase o falle.
// Cuesta 1 llamada Vision (GPT-4o) y escribe una fila, así que es manual post-deploy, NO canary.
//
// Correr:  node qa-e2e/qa-bsuid-media.mjs   (desde app/)  → exit 0 si pasa.

import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import { startWebhookHarness } from './webhook-harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

// Ground-truth del fixture (el mismo de qa-e2e-registro-gasto-foto.mjs).
const FIXTURE = path.join(here, 'fixtures', 'yape-gasto.png');
const MONTO = 23.45;

const sufijo = crypto.randomBytes(6).toString('hex');
const BSUID_CONOCIDO = 'PE.qa' + sufijo;
const BSUID_DESCONOCIDO = 'PE.nadie' + sufijo;
const WHATSAPP_QA = '519' + Math.floor(10000000 + Math.random() * 89999999);

const results = [];
const check = (name, cond, detail) => {
  results.push({ name, pass: !!cond, detail });
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail ? '  — ' + detail : ''));
  return !!cond;
};

// Espía sobre Vision. Es lo que hace deterministas los casos B y C: preguntar "¿se registró
// algo?" contra la DB no distingue "no registró" de "registró en otro lado", y encima obliga
// a esperar el timeout completo. Contar llamadas responde exactamente lo que se quiere saber.
function espiarVision(h) {
  const real = h.openai.chat.completions.create.bind(h.openai.chat.completions);
  const espia = { llamadas: 0 };
  h.openai.chat.completions.create = async (...args) => { espia.llamadas++; return real(...args); };
  return espia;
}

async function txsDe(h, usuarioId) {
  const { data, error } = await h.supabase.from('transacciones')
    .select('id, monto, tipo, categoria, fecha').eq('usuario_id', usuarioId);
  if (error) throw new Error('query transacciones: ' + error.message);
  return data || [];
}

// El webhook responde 200 y procesa async, y acá NO hay respuesta al usuario que esperar
// (ese es el punto): el único observable es la fila en la DB.
async function esperarTx(h, usuarioId, timeoutMs = 60000) {
  const t0 = Date.now();
  for (;;) {
    const filas = await txsDe(h, usuarioId);
    if (filas.length > 0) return filas;
    if (Date.now() - t0 > timeoutMs) return [];
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function run(h, vision) {
  // ── Sembrar el usuario que "activó username": tiene BSUID aprendido de antes ──
  const { data: usuario, error: errIns } = await h.supabase.from('usuarios').insert({
    whatsapp: WHATSAPP_QA, nombre: 'QA BSUID media', bsuid: BSUID_CONOCIDO,
    onboarding_completado: true, onboarding_paso: 0, is_test_user: true,
  }).select('id').single();
  if (errIns) throw new Error('sembrando usuario: ' + errIns.message);
  console.log('usuario efímero: ' + usuario.id + '  bsuid=' + BSUID_CONOCIDO);

  try {
    // ── A. BSUID conocido ────────────────────────────────────────────────────────
    const enviadosAntes = h.sent.length;
    const statusA = await h.postImageSinFrom(FIXTURE, BSUID_CONOCIDO);
    check('el webhook acepta la imagen sin `from`', statusA === 200, 'status=' + statusA);

    const filas = await esperarTx(h, usuario.id);
    check('se registró el gasto de la captura', filas.length === 1,
      filas.length + ' filas (esperaba 1)');
    if (filas[0]) {
      check('con el monto exacto del fixture', Number(filas[0].monto) === MONTO,
        'monto=' + filas[0].monto);
      check('como gasto', filas[0].tipo === 'gasto', 'tipo=' + filas[0].tipo);
    }
    check('Vision se llamó una sola vez', vision.llamadas === 1, 'llamadas=' + vision.llamadas);

    // El silencio ES el comportamiento, no la ausencia de comportamiento. La espera no es
    // decorativa: la fila aparece apenas guarda `guardarTransaccion`, y un `enviarWhatsapp`
    // metido DESPUÉS de esa línea no se vería si se asevera en el mismo instante.
    await new Promise((r) => setTimeout(r, 3000));
    check('NO se le respondió nada (no hay a dónde)', h.sent.length === enviadosAntes,
      h.sent.length - enviadosAntes + ' mensajes salientes: ' +
        h.sent.slice(enviadosAntes).map((s) => s.msg.slice(0, 40)).join(' | '));

    // ── C. Retransmisión del mismo wamid ─────────────────────────────────────────
    // Se hace ANTES del control negativo para reusar el envelope de A todavía fresco en la
    // cache de wamids (TTL 5 min).
    const bodyRepetido = {
      entry: [{ changes: [{ value: {
        messages: [{ id: 'qa-bsuid-repetido-' + sufijo, from_user_id: BSUID_CONOCIDO, type: 'image', image: { id: 'x', mime_type: 'image/png' } }],
        contacts: [{ user_id: BSUID_CONOCIDO }],
      } }] }],
    };
    await h.post(bodyRepetido);
    await new Promise((r) => setTimeout(r, 12000));   // dejar que la 1ra termine (baja + Vision)
    const visionTrasPrimera = vision.llamadas;
    await h.post(bodyRepetido);
    await new Promise((r) => setTimeout(r, 5000));
    check('una retransmisión del mismo wamid no vuelve a llamar a Vision',
      vision.llamadas === visionTrasPrimera,
      'antes=' + visionTrasPrimera + ' después=' + vision.llamadas);

    // ── B. Control negativo: BSUID que no conocemos ──────────────────────────────
    // El conteo de filas se toma ACÁ, no al final de A: la primera mitad del caso C es un
    // mensaje legítimo y puede haber agregado su propia fila. Comparar contra el conteo
    // viejo haría que este check fallara culpando al desconocido por algo que no hizo.
    const visionAntesB = vision.llamadas;
    const filasAntesB = await txsDe(h, usuario.id);
    const statusB = await h.postImageSinFrom(FIXTURE, BSUID_DESCONOCIDO);
    check('el webhook acepta la imagen del desconocido', statusB === 200, 'status=' + statusB);
    await new Promise((r) => setTimeout(r, 8000));
    check('a un BSUID desconocido no se le corre Vision', vision.llamadas === visionAntesB,
      'llamadas nuevas=' + (vision.llamadas - visionAntesB));

    const filasFinales = await txsDe(h, usuario.id);
    check('el desconocido no le agregó transacciones a nadie conocido',
      filasFinales.length === filasAntesB.length,
      'antes=' + filasAntesB.length + ' después=' + filasFinales.length);
  } finally {
    await h.supabase.from('transacciones').delete().eq('usuario_id', usuario.id);
    const { error: errDel } = await h.supabase.from('usuarios').delete().eq('id', usuario.id);
    const { data: quedó } = await h.supabase.from('usuarios').select('id').eq('id', usuario.id);
    check('se limpió el usuario efímero y sus transacciones',
      !errDel && (!quedó || quedó.length === 0),
      errDel ? errDel.message : 'id=' + usuario.id + ' borrado');
  }
}

const h = await startWebhookHarness();
const vision = espiarVision(h);
let fatal = null;
try { await run(h, vision); } catch (e) { fatal = e; console.log('FAIL excepción — ' + e.message); }
await h.close();

const fallidos = results.filter((r) => !r.pass);
console.log('\n=== ' + (results.length - fallidos.length) + '/' + results.length + ' checks OK ===');
if (fatal) console.log(fatal.stack);
process.exit(fallidos.length === 0 && !fatal ? 0 : 1);
