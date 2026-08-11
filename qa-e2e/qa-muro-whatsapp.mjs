// E2E del MURO **por el canal de WhatsApp**: mensajes reales por el webhook, aserciones
// sobre el texto que de verdad sale hacia el usuario.
//
// El hueco que cierra. El muro se aplica en DOS gates distintos y hasta ahora ningún test
// los ejercitaba por el pipeline:
//   · handlers/webhook.js  — la cascada de comandos `/`, que corre ANTES del NLP y nunca
//     pasa por el dispatch de intents.
//   · handlers/intent-registry.js → `dispatchIntent` — para los intents. Vivía inline en
//     message-processor.js y por eso se evaluaba UNA vez, con la intención del LLM maestro,
//     mientras la continuación multi-intent y los redirects de `registrar_manual`
//     despachaban otra intención por su cuenta (M21). Lo ejercita el bloque «M21» de abajo.
//
// qa-trial-gate.mjs PARECE cubrirlo y no lo hace: llama las funciones sueltas
// (`trial.estaEnMuro(u)`, `requiereLectura('ver_reporte')`, `comandoRequiereLectura('/mes')`)
// y `guardarTransaccion` directo. Nunca manda un mensaje. O sea que si alguien borra el `if`
// de la cascada, qa-trial-gate sigue 100% verde, los tests de vitest siguen verdes, y `/mes`
// entrega gratis el desglose que el muro cobra — justo al cohorte WhatsApp-only, que es el
// que hay que convertir. Es el modo de falla que el CLAUDE.md ya nombra: los ingredientes
// están testeados, la JUNTA no.
//
// Cómo asierta, y por qué así. Un negativo suelto (`!respuesta.includes(X)`) es verde por
// defecto: basta con que X esté mal escrito, que el seed no haya entrado o que la respuesta
// llegue vacía. La contramedida no es elegir un X más raro — es pinchar el MISMO centinela
// con un positivo en la misma corrida:
//
//     FASE PRO   (plan=premium, trial_estado=activo)  →  /mes DEBE traer el centinela
//     FASE MURO  (plan=free,    trial_estado=vencido) →  /mes NO DEBE traerlo
//
// Mismo usuario, misma data, mismo comando, mismo proceso: la única variable es la columna
// que lee estaEnMuro(). Ningún centinela se usa solo del lado negativo.
//
// NO corre ningún cron. `checkTrialExpiry()` es un UPDATE bulk sobre TODOS los usuarios;
// contra la Supabase de producción degradaría gente real y le mandaría avisos. El muro se
// consigue con un UPDATE sobre la fila del throwaway, que deja el mismo estado final.
//
// Envíos a Meta: cero. webhook-harness reemplaza `enviarWhatsapp` en el require-cache antes
// de cargar index.js, así que captura aguas arriba del check de `is_test_user` — que se
// queda igual como red de seguridad.
//
// Exit: 0 todo verde · 1 regresión del muro (gate) · 2 inconcluso (falta env, drift del
// clasificador NLP). Un exit 2 NO es una regresión: mirá qué intents se clasificaron.
//
// ── Verificado por MUTACIÓN (2026-08-03) ─────────────────────────────────────────────
// Un test que nunca se vio fallar no prueba nada. Se corrió en un worktree de HEAD con los
// gates neutralizados de a uno (`false && …`), y el reparto de rojos es lo que demuestra que
// cada aserción está cableada a SU gate y no a otra cosa:
//
//   baseline                      exit 0 · 35/35
//   webhook.js (cascada)          exit 1 · 5 rojos — TODOS de `/`; el bloque NLP verde
//   message-processor (chokepnt)  exit 1 · 7 rojos — TODOS de NLP; los de `/` verdes
//   estaEnMuro() → false          exit 1 · 13 rojos — la unión de los dos (ningún check
//                                 del muro queda verde por vacuidad)
//   estaEnMuro() → true           exit 1 · 4 rojos — los CONTROLES y el trial: detecta el
//                                 SOBRE-bloqueo, que rompe a quien paga y que un harness
//                                 de puros negativos nunca vería
//
// Ningún check se pone rojo en las dos primeras a la vez. Si agregás uno y eso pasa, está
// mirando algo que no es su gate: arreglalo antes de mergear.
//
// Esa matriz encontró un bug EN ESTE HARNESS, y vale contarlo porque se repite fácil: la
// versión original decidía "¿esto era una lectura?" observando si el gate había llamado a
// `requiereLectura`. Con el chokepoint neutralizado esa llamada no ocurre, así que el
// harness reportaba "el NLP clasificó otra cosa" (exit 2, inconcluso) sobre una corrida en
// la que el muro había entregado el total del mes gratis. La banda de tolerancia se tragaba
// justo el bug que existía para detectar. Por eso el intent se lee de `mapToolToIntent`, que
// corre antes del gate: la señal de "acá había algo que gatear" no puede depender del gate.
//
// ⚠️ Si repetís el worktree: BORRÁ las junctions de node_modules ANTES de
// `git worktree remove --force`. El borrado recursivo las atraviesa y vacía el
// node_modules REAL de app/ (pasó; se recuperó con `npm ci`).
//
// Correr:  node qa-e2e/qa-muro-whatsapp.mjs   (desde app/)  → exit 0 si pasa.
//          QA_MURO_NLP=0 saltea el bloque NLP (sin llamadas a OpenAI por clasificación).

import 'dotenv/config';
import { createRequire } from 'module';
import { startWebhookHarness } from './webhook-harness.mjs';
import { permitirUsuarioDePrueba } from './lib/qa-guard.mjs';

const require = createRequire(import.meta.url);

// ── Espías pass-through, ANTES de que el harness cargue index.js ──────────────────────
// webhook.js y message-processor.js DESTRUCTURAN estas funciones al cargar, así que el
// reemplazo tiene que ocurrir antes o capturan la referencia real. No cambian ninguna
// decisión: solo registran. Sirven para triage, nunca como aserción primaria — la
// aserción primaria es siempre el texto que sale al usuario.
const pAcceso = require.resolve('../handlers/intents-acceso.js');
const accesoReal = require(pAcceso);
const evaluados = []; // { tipo:'intent'|'cmd', valor, requiere }
require.cache[pAcceso].exports = {
  ...accesoReal,
  requiereLectura: (i) => {
    const r = accesoReal.requiereLectura(i);
    evaluados.push({ tipo: 'intent', valor: i, requiere: r });
    return r;
  },
  comandoRequiereLectura: (c) => {
    const r = accesoReal.comandoRequiereLectura(c);
    evaluados.push({ tipo: 'cmd', valor: c, requiere: r });
    return r;
  },
};

// De dónde sale el intent que clasificó el NLP, y por qué de ACÁ y no del espía de arriba.
// La primera versión leía el intent de las llamadas a `requiereLectura`, y eso tenía un
// agujero que la matriz de mutación destapó: al neutralizar el chokepoint con `false &&`,
// `requiereLectura` deja de llamarse, el espía queda mudo, y el harness reportaba "el NLP
// clasificó otra cosa" (exit 2, inconcluso) sobre una corrida donde el muro había dejado
// pasar el total del mes. O sea: la banda de tolerancia se tragaba justo el bug que existía
// para detectar. `mapToolToIntent` corre en message-processor.js:343, MUY antes del gate:
// romper el gate no puede cegarlo.
const pTools = require.resolve('../handlers/neto-tools.js');
const toolsReal = require(pTools);
const clasificaciones = []; // intents que el NLP produjo, haya gate o no
require.cache[pTools].exports = {
  ...toolsReal,
  mapToolToIntent: (toolName, args) => {
    const r = toolsReal.mapToolToIntent(toolName, args);
    clasificaciones.push(r.intencion);
    return r;
  },
};

// Los dos gates emiten literalmente el mismo `mensajeMuro()`, así que el texto no dice
// CUÁL respondió. El evento sí: { comando } = cascada, { intencion } = chokepoint.
const pAnalytics = require.resolve('../lib/analytics.js');
const analyticsReal = require(pAnalytics);
const eventos = []; // { ev, props }
require.cache[pAnalytics].exports = {
  ...analyticsReal,
  capture: (id, ev, props) => {
    eventos.push({ ev, props: props || {} });
    return analyticsReal.capture(id, ev, props);
  },
};

// ── Identificadores y centinelas de esta corrida ──────────────────────────────────────
const RUN = Date.now();
const TAG = 'QA-Muro'; // marcador para cazar huérfanos a mano si una corrida se muere
const WA_A = 'qa-muro-a-' + RUN; // el usuario que cruza PRO → MURO
const WA_B = 'qa-muro-b-' + RUN; // el virgen que estrena el trial

// Los centinelas NO pueden compartir substring con nada que el harness escriba por otro
// lado. La primera versión usaba el mismo marcador para el nombre del usuario y para la
// categoría, y como mensajeMuro saluda por el primer nombre, el propio mensaje del muro se
// leía como una fuga. Prefijos dedicados que no aparecen en ningún copy ni en el nombre:
const CENT_CAT = 'Zcat' + String(RUN).slice(-8);
// Centinela de COMERCIO: dos filas con el mismo comercio, porque generarResumenSemanal
// solo imprime "Lugar favorito" cuando se repite (comercioTop[1] >= 2).
const CENT_COM = 'Zcom' + String(RUN).slice(-8);
// Centinela de MONTO: el total del mes. Dos montos altos y sin relación con los números
// del copy del muro (S/10/mes, S/99/año) para que no haya colisión de substring.
const MONTO_1 = 4321.11;
const MONTO_2 = 3210.22;
const CENT_MONTO = (MONTO_1 + MONTO_2).toFixed(2); // "7531.33"

const CENTINELAS = { cat: CENT_CAT, comercio: CENT_COM, monto: CENT_MONTO };
/** Qué centinelas se filtraron en un texto. Vacío = el gate contuvo. */
const fugas = (t) => Object.entries(CENTINELAS).filter(([, v]) => String(t || '').includes(v)).map(([k]) => k);

const results = [];
const check = (name, cond, detail, tipo = 'gate') => {
  results.push({ name, pass: !!cond, detail, tipo });
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail ? '  — ' + detail : ''));
  return !!cond;
};
// Un fallo de infraestructura (falta una env var, el clasificador cambió de opinión) no es
// una regresión del muro: sale por exit 2 para no dar un rojo falso en el canary.
const infra = (name, cond, detail) => check(name, cond, detail, 'infra');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const recorte = (t, n = 90) => String(t || '(vacío)').replace(/\n/g, ' ').slice(0, n);

let h = null;
let userA = null;
let userB = null;

/**
 * La respuesta que Neto le mandó a ESTE número. No usa waitForReply a secas: ese junta
 * todo lo enviado desde el índice sin mirar destinatario, y cualquier excepción del webhook
 * dispara notificarErrorAdmin hacia el número del admin — que entraría al mismo buffer y
 * ensuciaría un negativo con un texto que ni siquiera era para el usuario.
 */
async function respuestaDe(from, desde, timeoutMs = 60000) {
  const t0 = Date.now();
  const mios = () => h.sent.slice(desde).filter((s) => s.to === from);
  while (mios().length === 0 && Date.now() - t0 < timeoutMs) await sleep(200);
  await sleep(500); // gracia: algunos flujos mandan más de un mensaje
  return mios().map((s) => s.msg).join('\n');
}

/** Manda un texto por el webhook real y devuelve lo que salió hacia ese número. */
async function decir(texto, from) {
  const desde = h.sent.length;
  const status = await h.postText(texto, from);
  if (status !== 200) return '(webhook respondió ' + status + ')';
  return await respuestaDe(from, desde);
}

const leer = async (id) => {
  const { data } = await h.supabase.from('usuarios').select('*').eq('id', id).maybeSingle();
  return data;
};

const contarTx = async (id) => {
  const { count } = await h.supabase.from('transacciones')
    .select('id', { count: 'exact', head: true }).eq('usuario_id', id);
  return count;
};

/**
 * El total de gastos del mes, EXACTAMENTE como lo suma el handler de `ver_total_gastado`.
 *
 * Se recalcula contra la DB en cada uso en vez de acumularse en una variable: un centinela
 * que se lleva la cuenta a mano se desincroniza en cuanto alguien agrega un check que
 * registre un gasto en el medio.
 *
 * Y reproduce dos detalles del original en vez de "mejorarlos", porque una divergencia acá
 * no da un rojo honesto: le pone al negativo (`!resp.includes(...)`) una cadena que no
 * puede aparecer nunca, o sea que pasa por VACUIDAD. Los dos, medidos contra
 * `services/transactions.js` → `obtenerGastosMes`:
 *   · NO hay cota superior de fecha (un gasto fechado a futuro dentro del mes cuenta).
 *   · La suma es `monto_pen || monto`, no `monto_pen ?? monto`: un `monto_pen` de 0 cae
 *     al monto crudo.
 */
const totalGastosMes = async (id) => {
  const hoyStr = require('../lib/dates').hoyPeru();
  const { data } = await h.supabase.from('transacciones').select('monto_pen,monto')
    .eq('usuario_id', id).eq('tipo', 'gasto')
    .gte('fecha', hoyStr.slice(0, 8) + '01');
  return (data || []).reduce((s, t) => s + parseFloat(t.monto_pen || t.monto || 0), 0);
};

async function run() {
  // El harness necesita estar arriba antes de requerir nada que dependa de lib/whatsapp:
  // notify-user destructura enviarWhatsapp al cargar, así que si se carga antes del stub
  // se queda con la función real y los envíos dejarían de capturarse.
  h = await startWebhookHarness();
  const trial = require('../lib/trial');
  const { verificarTokenActivacion } = require('../lib/activacion');
  const { hoyPeru, sumarDias } = require('../lib/dates');
  const { INTENTS_LECTURA } = accesoReal;

  // El prefijo del muro se deriva en runtime en vez de hardcodear el emoji: si mañana
  // cambia el copy, esto sigue apuntando al mensaje, no a un literal que quedó viejo.
  const MURO_MARCA = trial.mensajeMuro({ trial_estado: 'vencido', nombre: 'Probe', trial_vence: '2026-01-01' }, 1).split(' ')[0];
  const esMuro = (t) => String(t || '').includes(MURO_MARCA);

  // ── Preflight ───────────────────────────────────────────────────────────────────────
  infra('preflight: ACTIVATION_TOKEN_SECRET configurada',
    !!process.env.ACTIVATION_TOKEN_SECRET, 'sin ella el link del trial no se firma');
  infra('preflight: OPENAI_API_KEY configurada', !!process.env.OPENAI_API_KEY);
  infra('preflight: el prefijo del muro se pudo derivar', !!MURO_MARCA && MURO_MARCA.length <= 4, 'marca=' + MURO_MARCA);

  // ── Seed ────────────────────────────────────────────────────────────────────────────
  const { data: creadoA, error: errA } = await h.supabase.from('usuarios').insert({
    whatsapp: WA_A, nombre: TAG + ' Cruce ' + RUN, plan: 'free',
    onboarding_completado: true, is_test_user: true,
  }).select('id').single();
  if (!check('setup: usuario A sembrado (throwaway, is_test_user)', !errA && creadoA,
    errA ? errA.message : 'wa=' + WA_A)) return;
  userA = creadoA.id;

  const hoy = hoyPeru();
  const filaCent = (monto, n) => ({
    usuario_id: userA, tipo: 'gasto', monto, monto_pen: monto, moneda: 'PEN',
    comercio: CENT_COM, categoria: CENT_CAT, subcategoria: null,
    fecha: hoy, descripcion_original: TAG + ' centinela ' + n,
    confirmado: true, dedup_hash: 'qamuro-' + RUN + '-' + n,
  });
  const { error: errCent } = await h.supabase.from('transacciones')
    .insert([filaCent(MONTO_1, 1), filaCent(MONTO_2, 2)]).select('id');
  check('setup: dos transacciones centinela sembradas', !errCent,
    errCent ? errCent.message : 'cat=' + CENT_CAT + ' com=' + CENT_COM + ' total=' + CENT_MONTO);

  const { data: creadoB, error: errB } = await h.supabase.from('usuarios').insert({
    whatsapp: WA_B, nombre: TAG + ' Virgen ' + RUN, plan: 'free',
    onboarding_completado: true, is_test_user: true,
  }).select('id').single();
  if (!check('setup: usuario B sembrado (virgen, sin trial)', !errB && creadoB,
    errB ? errB.message : 'wa=' + WA_B)) return;
  userB = creadoB.id;
  const uB0 = await leer(userB);
  check('setup: B arranca sin trial y sin cuenta web',
    uB0.trial_estado === null && uB0.plan === 'free' && !uB0.supabase_auth_id,
    'estado=' + uB0.trial_estado + ' plan=' + uB0.plan);

  // ══ FASE PRO ════════════════════════════════════════════════════════════════════════
  // El control que le da valor a TODOS los negativos de la fase muro. Si algo acá falla,
  // los negativos de abajo son verdes por vacuidad y no prueban nada.
  await h.supabase.from('usuarios').update({
    plan: 'premium', trial_estado: 'activo', trial_vence: sumarDias(hoy, 7), premium_vence: null,
  }).eq('id', userA);

  const proMes = await decir('/mes', WA_A);
  const fugasProMes = fugas(proMes);
  check('control: con Pro, /mes ENTREGA el desglose (categoría y total centinela)',
    fugasProMes.includes('cat') && fugasProMes.includes('monto') && !esMuro(proMes),
    'presentes=[' + fugasProMes.join(',') + '] ' + recorte(proMes, 60));

  const proResumen = await decir('/resumen', WA_A);
  check('control: con Pro, /resumen ENTREGA el comercio (pincha el centinela de comercio)',
    fugas(proResumen).includes('comercio') && !esMuro(proResumen),
    'presentes=[' + fugas(proResumen).join(',') + '] ' + recorte(proResumen, 60));

  const proPresup = await decir('/presupuesto', WA_A);
  check('control: con Pro, /presupuesto NO responde el muro', !esMuro(proPresup), recorte(proPresup, 60));

  // ══ FASE MURO ═══════════════════════════════════════════════════════════════════════
  // Mismo usuario, misma data. Lo único que cambia son las dos columnas que lee estaEnMuro().
  await h.supabase.from('usuarios').update({
    plan: 'free', trial_estado: 'vencido', trial_vence: sumarDias(hoy, -1), premium_vence: null,
  }).eq('id', userA);
  const uMuro = await leer(userA);
  check('muro: el usuario A quedó del lado del muro', trial.estaEnMuro(uMuro) === true,
    'plan=' + uMuro.plan + ' estado=' + uMuro.trial_estado);

  // ── Gate A: la cascada de comandos `/` (handlers/webhook.js) ─────────────────────────
  const evAntesMes = eventos.length;
  const muroMes = await decir('/mes', WA_A);
  check('muro: /mes responde el muro, no el desglose',
    esMuro(muroMes) && /prueba/i.test(muroMes) && /no se borra nada/i.test(muroMes) && fugas(muroMes).length === 0,
    'fugas=[' + fugas(muroMes).join(',') + '] ' + recorte(muroMes, 60));

  const evMes = eventos.slice(evAntesMes).filter((e) => e.ev === 'wa_muro_lectura');
  check('muro: /mes corta en la CASCADA, antes del NLP',
    evMes.length === 1 && evMes[0].props.comando === '/mes' && evMes[0].props.intencion === undefined,
    'eventos=' + JSON.stringify(evMes.map((e) => e.props)));

  check('muro: el gate llegó a EVALUAR el comando /mes',
    evaluados.some((e) => e.tipo === 'cmd' && e.valor === '/mes' && e.requiere === true),
    'si esto falla, la rama del gate no se ejecutó');

  const muroResumen = await decir('/resumen', WA_A);
  check('muro: /resumen también está gateado (es la lista, no un comando suelto)',
    esMuro(muroResumen) && fugas(muroResumen).length === 0,
    'fugas=[' + fugas(muroResumen).join(',') + '] ' + recorte(muroResumen, 60));

  const muroPresup = await decir('/presupuesto', WA_A);
  check('muro: /presupuesto también está gateado',
    esMuro(muroPresup) && !/presupuesto/i.test(muroPresup.replace(/Neto Pro/gi, '')),
    recorte(muroPresup, 60));

  // El camino de conversión NO se cierra: gatear la cascada entera taparía justo la puerta
  // por la que entra la plata.
  const muroPremium = await decir('/premium', WA_A);
  check('muro: /premium NO está gateado (el camino de pago sigue abierto)',
    !esMuro(muroPremium) && /S\/10\/mes|Neto Pro|plan/i.test(muroPremium), recorte(muroPremium, 60));

  // ── Gate B: el chokepoint del NLP (handlers/message-processor.js) ────────────────────
  const FRASES = ['cuanto va el mes', 'mandame el reporte de este mes', 'ver mis presupuestos'];
  let llegoAlChokepoint = false;
  const clasificados = [];

  if (process.env.QA_MURO_NLP === '0') {
    infra('NLP: bloque salteado por QA_MURO_NLP=0', true, 'el gate del chokepoint NO se verificó');
  } else {
    for (const frase of FRASES) {
      // El historial entra al prompt del clasificador. Sin limpiarlo, los turnos previos
      // (mensajes del muro) sesgan la clasificación y la vuelven irreproducible.
      await h.supabase.from('conversaciones').delete().eq('usuario_id', userA);
      const clAntes = clasificaciones.length;
      const anAntes = eventos.length;
      const resp = await decir(frase, WA_A);
      // El veredicto se decide con la clasificación REAL del NLP y la lista de acceso de
      // verdad, no con lo que el gate haya preguntado: si el gate está roto no pregunta
      // nada, y eso es precisamente la regresión, no una excusa para no asertar.
      const intents = clasificaciones.slice(clAntes);
      const lectura = intents.find((i) => accesoReal.requiereLectura(i));
      clasificados.push(frase + ' → ' + (intents.join('/') || 'ninguno'));

      if (!lectura) {
        // Drift de verdad: el NLP mandó esta frase por un intent que NO es de lectura, así
        // que el muro no tenía por qué actuar y no hay nada que afirmar sobre el gate.
        infra('NLP drift: «' + frase + '» no se clasificó como lectura', false,
          'clasificó ' + (intents.join('/') || 'nada') + ' · ' + recorte(resp, 50));
        continue;
      }
      llegoAlChokepoint = true;

      check('muro: la consulta NLP «' + frase + '» responde el muro',
        esMuro(resp) && fugas(resp).length === 0,
        'intent=' + lectura + ' fugas=[' + fugas(resp).join(',') + '] ' + recorte(resp, 50));

      const evNlp = eventos.slice(anAntes).filter((e) => e.ev === 'wa_muro_lectura');
      check('muro: «' + frase + '» disparó el CHOKEPOINT (por intent, no por comando)',
        evNlp.length === 1 && INTENTS_LECTURA.has(evNlp[0].props.intencion) && evNlp[0].props.comando === undefined,
        'eventos=' + JSON.stringify(evNlp.map((e) => e.props)));
    }

    // Igualdad COMPLETA contra mensajeMuro, no `includes`. Es lo que atrapa la regresión de
    // la fila parcial: si el select que alimenta el gate perdiera trial_estado, mensajeMuro
    // cambia de rama y le promete 14 días gratis a quien acaba de gastarlos.
    if (llegoAlChokepoint) {
      await h.supabase.from('conversaciones').delete().eq('usuario_id', userA);
      const respExacta = await decir('cuanto va el mes', WA_A);
      const esperado = trial.mensajeMuro(await leer(userA), await contarTx(userA));
      check('muro: la respuesta es EXACTAMENTE mensajeMuro (rama correcta, fila completa)',
        respExacta === esperado,
        respExacta === esperado ? '' : 'salió: ' + recorte(respExacta, 70));
    }

    infra('NLP: al menos una frase llegó al chokepoint como lectura (test no vacuo)',
      llegoAlChokepoint, clasificados.join(' · '));
  }

  // ── Lo que sigue abierto en el muro ─────────────────────────────────────────────────
  // «hola» va ANTES de escribir: el total del mes todavía es exactamente el centinela.
  const muroHola = await decir('hola', WA_A);
  check('muro: «hola» sigue dando el total del mes gratis (excepción deliberada)',
    muroHola.includes(CENT_MONTO) && !esMuro(muroHola),
    'total=' + CENT_MONTO + ' ' + recorte(muroHola, 60));

  const txAntes = await contarTx(userA);
  const montoNuevo = 57.6 + Number(String(RUN).slice(-2)) / 100; // único por corrida: no choca el dedup_hash
  const respGasto = await decir('gasté ' + montoNuevo.toFixed(2) + ' en taxi', WA_A);
  const txDespues = await contarTx(userA);
  // El oráculo es la DB, no el HTTP: una confirmación bonita sobre una fila que no entró
  // sería exactamente el fallo que hay que detectar.
  check('muro: REGISTRAR UN GASTO SIGUE FUNCIONANDO (la promesa que no se negocia)',
    txDespues === txAntes + 1 && !esMuro(respGasto),
    'tx ' + txAntes + '→' + txDespues + ' · ' + recorte(respGasto, 60));

  check('muro: la confirmación deja el total del mes y NADA del desglose',
    /Van \*S\/ ?[\d.,]+\*/.test(respGasto) && !respGasto.includes(CENT_CAT),
    recorte(respGasto, 70));

  const uPostGasto = await leer(userA);
  check('muro: el gasto NO le reabre un trial',
    uPostGasto.plan === 'free' && uPostGasto.trial_estado === 'vencido',
    'plan=' + uPostGasto.plan + ' estado=' + uPostGasto.trial_estado);

  // ── M21: el compuesto escritura + lectura ───────────────────────────────────────────
  // El chokepoint se evaluaba UNA vez, con la intención del LLM maestro, y la continuación
  // multi-intent despachaba OTRO handler después. "gasté N en taxi y cuánto llevo este mes"
  // entregaba la lectura gratis. Es el caso que este harness NO ejercitaba (ledger 10-ago).
  //
  // De los cuatro call-sites de `dispatchIntent`, acá se puede forzar UNO solo: la
  // continuación es determinística (regex sobre el mensaje), mientras que los dos redirects
  // de `registrar_manual` dependen de que el LLM MISCLASIFIQUE una query como register, que
  // no se puede pedir a voluntad. Esos dos los cubre `tests/handlers/muro-dispatch.test.js`,
  // con una mutación por sitio. Escrito acá para que nadie lea este bloque como cobertura
  // de los cuatro.
  if (process.env.QA_MURO_NLP !== '0') {
    await h.supabase.from('conversaciones').delete().eq('usuario_id', userA);
    const montoM21 = 61.4 + Number(String(RUN).slice(-2)) / 100;
    const fraseM21 = 'gasté ' + montoM21.toFixed(2) + ' en taxi y cuánto llevo este mes';

    // La continuación resuelve a `ver_total_gastado`, que imprime "Llevas *S/ X* este mes
    // (N movimientos)" — no la categoría ni el comercio. O sea que los centinelas del resto
    // del archivo NO sirven acá: el oráculo es esa frase con el total exacto, calculado
    // contra la DB. Es distinta del "Van *S/ X*" que la confirmación del gasto deja gratis
    // a propósito, así que no se confunden.
    const marcaLectura = async () => 'Llevas *S/ ' + (await totalGastosMes(userA)).toFixed(2) + '*';

    const txAntesM21 = await contarTx(userA);
    const clAntesM21 = clasificaciones.length;
    const respM21 = await decir(fraseM21, WA_A);
    const txDespuesM21 = await contarTx(userA);
    const intentsM21 = clasificaciones.slice(clAntesM21);
    const lecturaM21 = await marcaLectura();

    // Sin esto el negativo de abajo es verde por vacuidad: si el LLM clasificó la frase
    // entera como una query, la continuación ni existió y no hay nada que afirmar.
    infra('M21: el LLM clasificó el compuesto como ESCRITURA (si no, el caso no se ejercitó)',
      intentsM21.some((i) => i === 'registrar_manual'),
      'clasificó ' + (intentsM21.join('/') || 'nada'));

    check('M21: el compuesto REGISTRA el gasto (escribir no se corta)',
      txDespuesM21 === txAntesM21 + 1,
      'tx ' + txAntesM21 + '→' + txDespuesM21 + ' · ' + recorte(respM21, 60));

    check('M21: y la segunda parte NO entrega la lectura (la continuación pasa por el gate)',
      esMuro(respM21) && !respM21.includes(lecturaM21),
      'buscaba ausente: «' + lecturaM21 + '» · ' + recorte(respM21, 80));

    check('M21: el mensaje del muro sale UNA vez, no pegado a sí mismo',
      (String(respM21).split(MURO_MARCA).length - 1) === 1,
      recorte(respM21, 80));

    // Control positivo sobre el MISMO compuesto y el MISMO centinela: sin esto, "no entregó
    // la lectura" también sería cierto si el pipeline se hubiera roto y devolviera
    // cualquier otra cosa, o si la frase que busco estuviera mal escrita.
    await h.supabase.from('conversaciones').delete().eq('usuario_id', userA);
    await h.supabase.from('usuarios').update({
      plan: 'premium', trial_estado: 'activo', trial_vence: sumarDias(hoy, 7),
    }).eq('id', userA);
    const montoCtrl = 62.4 + Number(String(RUN).slice(-2)) / 100;
    const respCtrl = await decir('gasté ' + montoCtrl.toFixed(2) + ' en taxi y cuánto llevo este mes', WA_A);
    const lecturaCtrl = await marcaLectura();
    check('M21 control: con Pro, esa MISMA continuación sí entrega la lectura',
      !esMuro(respCtrl) && respCtrl.includes(lecturaCtrl),
      'buscaba presente: «' + lecturaCtrl + '» · ' + recorte(respCtrl, 80));

    // Devolver a A al muro: los checks de más abajo asumen ese estado.
    await h.supabase.from('usuarios').update({
      plan: 'free', trial_estado: 'vencido', trial_vence: sumarDias(hoy, -1),
    }).eq('id', userA);
    const uVuelta = await leer(userA);
    infra('M21: el usuario A volvió al muro después del control',
      trial.estaEnMuro(uVuelta) === true, 'plan=' + uVuelta.plan + ' estado=' + uVuelta.trial_estado);
  }

  // ══ TRIAL: el primer gasto de un usuario virgen ═════════════════════════════════════
  const respTrial = await decir('gasté 33.70 en menú', WA_B);
  const uB = await leer(userB);
  check('trial: el primer gasto arranca el trial (estado + plan + vencimiento en DB)',
    uB.trial_estado === 'activo' && uB.plan === 'premium' &&
    String(uB.trial_vence).slice(0, 10) === sumarDias(hoy, trial.TRIAL_DIAS) && uB.premium_vence == null,
    'estado=' + uB.trial_estado + ' plan=' + uB.plan + ' vence=' + uB.trial_vence);

  // Acá está la diferencia con qa-trial-gate, que invoca colaConfirmacionGasto a mano con
  // argumentos elegidos: esto asierta sobre el texto que el pipeline REALMENTE mandó.
  check('trial: el mensaje que SALE anuncia los ' + trial.TRIAL_DIAS + ' días',
    respTrial.includes(trial.TRIAL_DIAS + ' días') && /Neto Pro/i.test(respTrial) && !esMuro(respTrial),
    recorte(respTrial, 80));

  const mLink = respTrial.match(/\/activar\?t=([A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+)/);
  const payload = mLink ? verificarTokenActivacion(mLink[1]) : null;
  check('trial: el link de activación viene FIRMADO y apunta a ESE usuario',
    !!payload && payload.uid === userB,
    mLink ? 'uid=' + (payload && payload.uid) + ' esperado=' + userB : 'no salió ningún link en el mensaje');

  // El bloqueo tiene que ser CONDICIONAL. Un gate que corta siempre rompe a quien paga, y
  // un harness de puros negativos nunca lo vería.
  const trialMes = await decir('/mes', WA_B);
  check('trial: un usuario EN TRIAL no recibe el muro (el bloqueo es condicional)',
    !esMuro(trialMes), recorte(trialMes, 60));

  // ── Higiene de la corrida ───────────────────────────────────────────────────────────
  const ajenos = h.sent.filter((s) => s.to !== WA_A && s.to !== WA_B);
  check('higiene: no salió ninguna notificación de error al admin durante la corrida',
    ajenos.length === 0, ajenos.length ? 'a ' + ajenos.map((s) => s.to).join(',') + ': ' + recorte(ajenos[0].msg, 60) : '');
}

async function cleanup() {
  // Rescate por número, ANTES de decidir que no hay nada que borrar. Si una corrida se muere
  // entre el INSERT y la captura del id, el usuario queda vivo en producción y sin este
  // bloque el check de limpieza daría PASS con "nada que borrar" — un falso verde de la
  // misma familia que el harness entero existe para cazar.
  // La re-lectura por `whatsapp` NO cosecha el id en la barrera (solo `id`/`usuario_id`
  // fijan sujeto), así que el borrado posterior abortaría: hay que registrarlo a mano, y
  // `permitirUsuarioDePrueba` revalida is_test_user contra la DB antes de aceptarlo.
  for (const wa of [WA_A, WA_B]) {
    if ((wa === WA_A && userA) || (wa === WA_B && userB)) continue;
    const { data } = await h.supabase.from('usuarios').select('id').eq('whatsapp', wa).maybeSingle();
    if (!data || !data.id) continue;
    await permitirUsuarioDePrueba(data.id);
    if (wa === WA_A) userA = data.id; else userB = data.id;
    console.log('  (rescate: ' + wa + ' habia quedado huerfano, se borra igual)');
  }

  const ids = [userA, userB].filter(Boolean);
  if (ids.length === 0) { check('limpieza: no quedó usuario throwaway', true, 'nada que borrar'); return; }
  // Hijos primero. `conversaciones` va incluido porque este harness sí las genera (cada
  // turno del webhook escribe una) — qa-trial-gate no las borra porque no las produce.
  for (const t of ['transacciones', 'conversaciones', 'notificaciones', 'categorias_usuario',
    'presupuestos', 'pagos', 'notification_deliveries']) {
    await h.supabase.from(t).delete().in('usuario_id', ids);
  }
  const { error } = await h.supabase.from('usuarios').delete().in('id', ids);
  const { data: siguen } = await h.supabase.from('usuarios').select('id').in('id', ids);
  check('limpieza: se borraron los throwaway y todo lo suyo',
    !error && (!siguen || siguen.length === 0),
    error ? error.message : ids.length + ' borrados');
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

// Un gate roto manda sobre cualquier problema de infra: si el muro dejó pasar una lectura,
// es exit 1 aunque además falte una env var.
if (gateRotos.length > 0 || fatal) process.exit(1);
if (fallidos.length > 0) process.exit(2);
process.exit(0);
