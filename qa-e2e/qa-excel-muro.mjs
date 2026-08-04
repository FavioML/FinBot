// E2E de los residuales del bot de la ola 3 (M9 y M10) **por el pipeline real**: mensajes
// que entran por el webhook firmado, aserciones sobre el texto que de verdad sale.
//
// El hueco que cierra. Los tests de vitest de M9/M10 son unitarios (llaman al handler con
// una fila armada a mano) y estáticos (greps sobre el fuente). Ninguno ejercita la junta:
// el NLP clasificando la frase, el dispatch encontrando el handler, y —sobre todo— la rama
// `message.type === 'document'` de webhook.js, que no pasa por ningún intent y que es donde
// el revisor adversarial encontró que M9 seguía vivo después del fix.
//
// Los tres caminos que se cruzan acá y que un unitario no puede tocar:
//   1. "quiero subir mi excel" → NLP → cargar_excel → ¿tutorial o pitch?
//   2. un DOCUMENTO que no es Excel (un PDF, el caso típico: el estado de cuenta) →
//      ¿"descarga la plantilla" o el pitch? El chequeo de formato reparte el link de la
//      plantilla, así que mientras corría antes del gate el bug seguía completo.
//   3. "mi cuenta" → estado_cuenta → ¿"Plan: Free" (derogado) o lo que el usuario tiene?
//
// Cómo asierta. Mismo esquema que qa-muro-whatsapp: cada centinela se pincha en POSITIVO y
// en NEGATIVO en la misma corrida, sobre el mismo usuario y la misma data. Lo único que
// cambia entre las dos fases son las dos columnas que lee el gate.
//
//     FASE PRO   (plan=premium, trial_estado=activo)  →  DEBE aparecer la plantilla
//     FASE MURO  (plan=free,    trial_estado=vencido) →  NO debe aparecer, y sí el pitch
//
// Un negativo suelto sería verde por vacuidad: bastaría con que la respuesta llegue vacía,
// que el seed no haya entrado, o que el literal esté mal escrito. El positivo de la fase
// PRO es lo que le da valor a todo lo de abajo.
//
// Envíos a Meta: cero (webhook-harness stubbea enviarWhatsapp aguas arriba). Descargas de
// media: cero — para el usuario del muro el gate corta ANTES del fetch a graph.facebook.com,
// y eso es justamente uno de los invariantes que se comprueban.
//
// NO corre ningún cron. El estado se consigue con un UPDATE sobre la fila del throwaway.
//
// Exit: 0 todo verde · 1 regresión (el gate o el copy) · 2 inconcluso (falta env, o el
// clasificador NLP mandó la frase a otro intent — eso NO es una regresión del gate).
//
// Correr:  node qa-e2e/qa-excel-muro.mjs   (desde app/)
//          QA_EXCEL_NLP=0 saltea las frases en lenguaje natural (sin gasto de OpenAI);
//          el camino del DOCUMENTO, que es el que encontró el bug, corre igual.
//
// ── Verificado por MUTACIÓN (2026-08-04) ─────────────────────────────────────────────
// Un harness que nunca se vio fallar no prueba nada. Se corrió con cada gate neutralizado
// de a uno, y el reparto de rojos es lo que demuestra que cada aserción está cableada a SU
// gate y no a otra cosa:
//
//   baseline                              exit 0 · 20/20
//   gate del intent (moderacion.js)       exit 1 · 1 rojo  — solo el de `cargar_excel`;
//                                         los tres del documento quedaron verdes
//   orden en webhook.js (formato antes    exit 1 · 2 rojos — ambos de la rama del PDF; el
//   del gate, o sea M9 revivido)          del intent verde, y el del .xlsx TAMBIÉN verde,
//                                         porque un Excel sí pasa el chequeo de formato y
//                                         llega al gate: el bug solo alcanza a los formatos
//                                         no soportados, que es exactamente lo que lo hacía
//                                         difícil de ver
//
// Ningún check se pone rojo en las dos a la vez. Si agregás uno y eso pasa, está mirando
// algo que no es su gate.

import 'dotenv/config';
import { createRequire } from 'module';
import { startWebhookHarness } from './webhook-harness.mjs';
import { permitirUsuarioDePrueba } from './lib/qa-guard.mjs';

const require = createRequire(import.meta.url);

// Espía pass-through del clasificador, ANTES de que el harness cargue index.js. Igual que
// en qa-muro-whatsapp: `mapToolToIntent` corre mucho antes del gate, así que romper el gate
// no puede cegarlo. Sirve para distinguir "el gate falló" de "el NLP mandó la frase a otro
// intent" — lo primero es exit 1, lo segundo exit 2.
const pTools = require.resolve('../handlers/neto-tools.js');
const toolsReal = require(pTools);
const clasificaciones = [];
require.cache[pTools].exports = {
  ...toolsReal,
  mapToolToIntent: (toolName, args) => {
    const r = toolsReal.mapToolToIntent(toolName, args);
    clasificaciones.push(r.intencion);
    return r;
  },
};

// Centinela de que el gate corta antes de hablar con Meta. Si el flujo llegara a la
// descarga, este contador subiría — y con un mediaId inventado además reventaría.
let fetchesAMeta = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, opts) => {
  const url = typeof input === 'string' ? input : (input && input.url) || String(input);
  if (url.includes('graph.facebook.com')) fetchesAMeta++;
  return realFetch(input, opts);
};

const RUN = Date.now();
const TAG = 'QA-Excel';
const WA = 'qa-excel-' + RUN;

// El literal que solo aparece en el TUTORIAL de importación. Es el centinela: presente en
// la fase PRO, ausente en la fase MURO.
const CENT_TUTORIAL = 'plantilla_gastos.xlsx';

const results = [];
const check = (name, cond, detail, tipo = 'gate') => {
  results.push({ name, pass: !!cond, detail, tipo });
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail ? '  — ' + detail : ''));
  return !!cond;
};
const infra = (name, cond, detail) => check(name, cond, detail, 'infra');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const recorte = (t, n = 90) => String(t || '(vacío)').replace(/\n/g, ' ').slice(0, n);

let h = null;
let userId = null;

/** Lo que Neto le mandó a ESTE número (no waitForReply a secas: el admin usa el mismo buffer). */
async function respuestaDe(from, desde, timeoutMs = 60000) {
  const t0 = Date.now();
  const mios = () => h.sent.slice(desde).filter((s) => s.to === from);
  while (mios().length === 0 && Date.now() - t0 < timeoutMs) await sleep(200);
  await sleep(500);
  return mios().map((s) => s.msg).join('\n');
}

async function decir(texto) {
  const desde = h.sent.length;
  const status = await h.postText(texto, WA);
  if (status !== 200) return '(webhook respondió ' + status + ')';
  return await respuestaDe(WA, desde);
}

/**
 * Manda un DOCUMENTO por el webhook real. El envelope se arma a mano porque el harness solo
 * expone helpers de texto e imagen; `post` acepta cualquier cuerpo firmado.
 *
 * El mediaId es inventado a propósito: si el gate corta antes de la descarga —que es el
 * invariante— nunca se usa. Si alguien vuelve a poner el gate después, el flujo intentará
 * bajarlo de Meta y el contador `fetchesAMeta` lo delata.
 */
async function mandarDocumento({ filename, mime }) {
  const desde = h.sent.length;
  const body = {
    entry: [{ changes: [{ value: { messages: [{
      from: WA, id: 'qa-doc-' + RUN + '-' + Math.random().toString(36).slice(2),
      type: 'document', document: { id: 'media-inexistente-' + RUN, filename, mime_type: mime },
    }] } }] }],
  };
  const status = await h.post(body);
  if (status !== 200) return '(webhook respondió ' + status + ')';
  return await respuestaDe(WA, desde);
}

const leer = async () => {
  const { data } = await h.supabase.from('usuarios').select('*').eq('id', userId).maybeSingle();
  return data;
};

async function run() {
  h = await startWebhookHarness();
  const trial = require('../lib/trial');
  const { hoyPeru, sumarDias } = require('../lib/dates');

  // El pitch se deriva en runtime, no se hardcodea: si mañana cambia el copy, esto sigue
  // apuntando al MENSAJE y no a un literal que quedó viejo.
  const marcaPitch = trial.mensajeCargaMasivaPro({ id: 'x', plan: 'free' }).split('\n')[0];
  infra('preflight: el encabezado del pitch se pudo derivar', !!marcaPitch && marcaPitch.length > 10, marcaPitch);
  infra('preflight: OPENAI_API_KEY configurada', !!process.env.OPENAI_API_KEY);
  const esPitch = (t) => String(t || '').includes(marcaPitch);

  // ── Seed ────────────────────────────────────────────────────────────────────────────
  const { data: creado, error: errU } = await h.supabase.from('usuarios').insert({
    whatsapp: WA, nombre: TAG + ' ' + RUN, plan: 'free',
    onboarding_completado: true, is_test_user: true,
  }).select('id').single();
  if (!check('setup: usuario throwaway sembrado (is_test_user)', !errU && creado,
    errU ? errU.message : 'wa=' + WA)) return;
  userId = creado.id;

  const hoy = hoyPeru();

  // ══ FASE PRO ════════════════════════════════════════════════════════════════════════
  // Los controles que le dan valor a los negativos de abajo.
  await h.supabase.from('usuarios').update({
    plan: 'premium', trial_estado: 'activo', trial_vence: sumarDias(hoy, 7), premium_vence: null,
  }).eq('id', userId);

  const fetchesAntesPro = fetchesAMeta;
  const proDoc = await mandarDocumento({ filename: 'estado-cuenta.pdf', mime: 'application/pdf' });
  check('control: con Pro, un PDF recibe la ayuda de FORMATO (y el link de la plantilla)',
    proDoc.includes(CENT_TUTORIAL) && /Acepto archivos Excel/i.test(proDoc) && !esPitch(proDoc),
    recorte(proDoc, 70));
  check('control: un formato no soportado no gasta una descarga de Meta',
    fetchesAMeta === fetchesAntesPro, 'fetches=' + (fetchesAMeta - fetchesAntesPro));

  // `estado_cuenta` y `cargar_excel` NO tienen comando `/`: solo se llega por NLP, así que
  // las dos frases viven en el bloque condicional. `decirIntent` devuelve null cuando el
  // clasificador mandó la frase a otro lado — eso es exit 2 (inconcluso), no una regresión.
  const decirIntent = async (frase, intentEsperado, fase) => {
    if (process.env.QA_EXCEL_NLP === '0') return null;
    // El historial entra al prompt del clasificador: sin limpiarlo, los turnos previos
    // sesgan la clasificación y la vuelven irreproducible.
    await h.supabase.from('conversaciones').delete().eq('usuario_id', userId);
    const clAntes = clasificaciones.length;
    const resp = await decir(frase);
    const clasif = clasificaciones.slice(clAntes);
    if (!clasif.includes(intentEsperado)) {
      infra('NLP: "' + frase + '" no se clasificó como ' + intentEsperado + ' (' + fase + ')',
        false, 'clasificó=' + JSON.stringify(clasif));
      return null;
    }
    return resp;
  };

  if (process.env.QA_EXCEL_NLP === '0') {
    infra('NLP: bloque de frases salteado por QA_EXCEL_NLP=0', true,
      'los caminos de intent NO se verificaron; el del DOCUMENTO sí');
  }

  const proCuenta = await decirIntent('cómo va mi cuenta', 'estado_cuenta', 'PRO');
  if (proCuenta !== null) {
    check('control: con Pro (prueba), estado_cuenta dice que está PROBANDO',
      proCuenta.includes('Pro (prueba)') && !proCuenta.includes('Plan: *Free*'),
      recorte(proCuenta, 70));
  }

  const proExcel = await decirIntent('quiero cargar mis gastos con un excel', 'cargar_excel', 'PRO');
  if (proExcel !== null) {
    check('control: con Pro, cargar_excel ENTREGA el instructivo',
      proExcel.includes(CENT_TUTORIAL) && !esPitch(proExcel), recorte(proExcel, 70));
  }

  // ══ FASE MURO ═══════════════════════════════════════════════════════════════════════
  // Mismo usuario, misma data. Solo cambian las dos columnas del gate.
  await h.supabase.from('usuarios').update({
    plan: 'free', trial_estado: 'vencido', trial_vence: sumarDias(hoy, -1), premium_vence: null,
  }).eq('id', userId);
  const uMuro = await leer();
  check('muro: el usuario quedó del lado del muro', trial.estaEnMuro(uMuro) === true,
    'plan=' + uMuro.plan + ' estado=' + uMuro.trial_estado);

  // ── M9, rama del documento: el bug que el revisor adversarial encontró ───────────────
  // El chequeo de formato reparte el link de la plantilla. Mientras corrió ANTES del gate,
  // al del muro que mandaba su estado de cuenta en PDF se le decía "descarga la plantilla",
  // la llenaba a mano, la enviaba, y RECIÉN ahí se le cobraba.
  const fetchesAntesMuro = fetchesAMeta;
  const muroPdf = await mandarDocumento({ filename: 'estado-cuenta.pdf', mime: 'application/pdf' });
  check('muro: un PDF recibe el pitch, NO "descarga la plantilla"',
    esPitch(muroPdf) && !muroPdf.includes(CENT_TUTORIAL),
    recorte(muroPdf, 70));

  const muroXlsx = await mandarDocumento({
    filename: 'gastos.xlsx',
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  check('muro: un Excel de verdad también recibe el pitch',
    esPitch(muroXlsx) && !muroXlsx.includes(CENT_TUTORIAL), recorte(muroXlsx, 70));

  check('muro: ningún documento bloqueado gastó una descarga de Meta',
    fetchesAMeta === fetchesAntesMuro, 'fetches=' + (fetchesAMeta - fetchesAntesMuro));

  // El "no" no puede leerse como "Neto dejó de funcionar", y no puede empujar a "ver plan"
  // (ese comando arma la espera de comprobante: 48h donde una foto que no parece el pago se
  // rechaza SIN registrar el gasto, o sea que rompe la escritura que el propio mensaje
  // acaba de prometer).
  check('muro: el pitch deja en pie la promesa de que anotar sigue gratis',
    /no tiene límite ni costo/i.test(muroPdf), recorte(muroPdf, 70));
  check('muro: el pitch NO empuja a "ver plan" (eso abriría la espera de comprobante)',
    !/ver plan/i.test(muroPdf), recorte(muroPdf, 70));

  // ── M10: estado_cuenta ──────────────────────────────────────────────────────────────
  const muroCuenta = await decirIntent('cómo va mi cuenta', 'estado_cuenta', 'MURO');
  if (muroCuenta !== null) {
    check('muro: estado_cuenta ya no dice "Plan: Free" (plan derogado)',
      !muroCuenta.includes('Plan: *Free*'), recorte(muroCuenta, 70));
    check('muro: estado_cuenta nombra lo que el usuario conserva',
      muroCuenta.includes('Gratis (solo registro)'), recorte(muroCuenta, 70));
    check('muro: a quien ya gastó su prueba no se le ofrece otra',
      !/se activa con tu primer gasto/i.test(muroCuenta), recorte(muroCuenta, 70));
  }

  // ── M9, rama del intent ─────────────────────────────────────────────────────────────
  const muroExcel = await decirIntent('quiero cargar mis gastos con un excel', 'cargar_excel', 'MURO');
  if (muroExcel !== null) {
    check('muro: cargar_excel responde el pitch, NO el instructivo',
      esPitch(muroExcel) && !muroExcel.includes(CENT_TUTORIAL), recorte(muroExcel, 70));
    // Antivacuidad del centinela: si el tutorial no apareció en NINGUNA fase, el negativo
    // de arriba no probó nada. El del documento sirve igual como positivo del literal.
    check('antivacuidad: el instructivo SÍ apareció con Pro (por intent o por documento)',
      (proExcel !== null && proExcel.includes(CENT_TUTORIAL)) || proDoc.includes(CENT_TUTORIAL),
      'intent=' + (proExcel !== null) + ' doc=' + proDoc.includes(CENT_TUTORIAL));
  }

  // ── Control de sobre-bloqueo: el que estrena su prueba ──────────────────────────────
  // Un harness de puros negativos no ve el fallo simétrico: cerrarle la importación a quien
  // sí tiene derecho. Se vuelve a abrir el trial y el mismo PDF tiene que volver a la ayuda
  // de formato.
  await h.supabase.from('usuarios').update({
    plan: 'premium', trial_estado: 'activo', trial_vence: sumarDias(hoy, 7),
  }).eq('id', userId);
  const reabierto = await mandarDocumento({ filename: 'estado-cuenta.pdf', mime: 'application/pdf' });
  check('sobre-bloqueo: al volver al trial, el PDF vuelve a recibir la ayuda de formato',
    reabierto.includes(CENT_TUTORIAL) && !esPitch(reabierto), recorte(reabierto, 70));
}

async function cleanup() {
  if (!userId) {
    const { data } = await h.supabase.from('usuarios').select('id').eq('whatsapp', WA).maybeSingle();
    if (!data || !data.id) { check('limpieza: no quedó usuario throwaway', true, 'nada que borrar'); return; }
    await permitirUsuarioDePrueba(data.id);
    userId = data.id;
    console.log('  (rescate: ' + WA + ' había quedado huérfano, se borra igual)');
  }
  for (const t of ['transacciones', 'conversaciones', 'notificaciones', 'categorias_usuario',
    'presupuestos', 'pagos', 'notification_deliveries']) {
    await h.supabase.from(t).delete().eq('usuario_id', userId);
  }
  const { error } = await h.supabase.from('usuarios').delete().eq('id', userId);
  const { data: sigue } = await h.supabase.from('usuarios').select('id').eq('id', userId);
  check('limpieza: se borró el throwaway y todo lo suyo',
    !error && (!sigue || sigue.length === 0), error ? error.message : userId);
}

let fatal = null;
try { await run(); } catch (e) { fatal = e; console.log('FAIL excepción — ' + e.message); }
try { if (h) await cleanup(); } catch (e) { console.log('FAIL limpieza — ' + e.message); fatal = fatal || e; }
if (h) await h.close();

const fallidos = results.filter((r) => !r.pass);
const gateRotos = fallidos.filter((r) => r.tipo === 'gate');
console.log('\n=== ' + (results.length - fallidos.length) + '/' + results.length + ' checks OK ===');
if (fallidos.length) console.log('Fallaron: ' + fallidos.map((r) => r.name).join(' | '));
if (fatal) console.log(fatal.stack);

if (gateRotos.length > 0 || fatal) process.exit(1);
if (fallidos.length > 0) process.exit(2);
process.exit(0);
