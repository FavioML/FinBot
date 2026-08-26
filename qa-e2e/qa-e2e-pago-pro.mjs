// E2E del flujo PRO (pago de suscripción por Yape), punta a punta, por el webhook
// real contra la Supabase real. Hermano de qa-e2e-registro-gasto-foto.mjs: ambos
// mandan una captura por el branch `type === 'image'` con Vision REAL, pero este
// ejercita el camino PRO (usuario esperando comprobante), no el registro de gasto.
//
// Qué ejercita (todo el pipeline, con Vision REAL):
//   webhook firmado (HMAC) → limiter → webhook.js (branch `type === 'image'`)
//   → 2 fetch a graph.facebook.com STUBEADOS (metadata → {url}, luego bytes del
//     fixture) — ver postImage en webhook-harness.mjs
//   → GPT-4o Vision REAL parsea la captura de Yape
//   → esperaComprobante(usuario) === true (por onboarding_paso === 2)
//   → esPagoNeto(parsed) === true (comercio "Favio Mendoza" + monto S/10 mensual)
//   → procesarComprobantePro → registrarSolicitudPro:
//        · sube el comprobante al bucket privado `comprobantes`
//        · inserta 1 fila en `pagos` (estado pendiente, origen whatsapp)
//        · marca usuarios.pago_pendiente / estado_pago / esperando_comprobante
//        · notifica al admin — por TELEGRAM, que es el canal que `notificarAdmin` intenta
//          primero y que el harness stubea; el fallback WhatsApp NO se ejercita acá
//   → confirmación "📸 Comprobante recibido" capturada.
//   Además el branch registra el gasto de suscripción (webhook.js, DESPUÉS de que
//   procesarComprobantePro ya mandó la confirmación) → 1 fila en `transacciones` (posible
//   upsert en `reglas_comercio`): se limpia también. Con el fixture de acá ese gasto NO
//   arranca ningún trial (el usuario ya lo gastó), y eso es a propósito: ver la nota del seed.
//
// Fixture: qa-e2e/fixtures/yape-pro.png — Yape "¡Yapeaste!" S/ 10.00 a "Favio
// Mendoza", motivo "Neto Pro". Ground-truth: tipo=gasto, monto=10, comercio Favio
// → esPagoNeto()=true (mensual). Regenerar: node qa-e2e/fixtures/render-yape-pro.mjs
//
// Veredicto BINARIO y sin falso positivo: no confía solo en el texto — verifica el
// EFECTO real (fila en `pagos` con estado/monto/origen esperados + objeto en Storage).
//
// Aislamiento total: usuario THROWAWAY con whatsapp/email únicos por corrida,
// is_test_user=true, onboarding_paso=2 (esperando comprobante). Autolimpieza COMPLETA
// y en orden (Storage → pagos → transacciones → reglas_comercio → conversaciones →
// usuario). Cuesta 1 llamada Vision (GPT-4o) + escribe pagos/Storage → manual
// post-deploy, NO canary.
//
// Correr:  node qa-e2e/qa-e2e-pago-pro.mjs   (desde app/)  → exit 0 si pasa.

import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

// Sin TELEGRAM_ADMIN_CHAT_ID, notificarSolicitudAdminPro saltea el envío de la FOTO con
// botones inline y cae al aviso de TEXTO (notificarAdmin → enviarTelegram, stubeado).
//
// El delete NO es decorativo, y su motivo no es el que decía acá: el harness stubea
// `enviarTelegram` pero **no** `enviarTelegramFotoConBotones` (el spread de `...tgReal`
// conserva la real). Con las dos variables puestas, este harness le manda al celular de
// Favio una foto de Yape de verdad en cada corrida.
//
// Ojo con el orden: los `import` de ESM se evalúan ANTES que estas líneas, y
// webhook-harness.mjs hace `import 'dotenv/config'`. O sea que esto pisa lo que el .env
// haya cargado, que es exactamente lo que se quiere.
delete process.env.TELEGRAM_ADMIN_CHAT_ID;
delete process.env.TELEGRAM_BOT_TOKEN;

import { startWebhookHarness } from './webhook-harness.mjs';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, '..');

// OJO: NO requerir lib/pro-payment.js ni lib/admin-notify.js ANTES de arrancar el
// harness. Ambos hacen `const { enviarWhatsapp } = require('./whatsapp')` y capturan
// la función por destructuring AL CARGARSE. El harness stubea enviarWhatsapp
// reemplazando require.cache[whatsapp].exports; si estos módulos se cargan antes del
// swap, quedan bindeados a la enviarWhatsapp REAL y sus envíos (confirmación al
// usuario + notificación admin) NO se capturan en h.sent (se van a Meta real / skip).
// Se resuelven DESPUÉS de startWebhookHarness(), cuando el stub ya está en el cache
// y el primer load (vía webhook.js) bindeó el stub. esperaComprobante/ADMIN_NUMBER
// son puros (no tocan whatsapp), así que el veredicto no cambia por esto.
let esperaComprobante, ADMIN_NUMBER, esProPagado;

const RUN = Date.now();
const WA = 'qa-pro-' + RUN;
const EMAIL = 'qa-pro-' + RUN + '@neto-test.local';
const NOMBRE = 'Pro Prueba';

// Ground-truth del fixture yape-pro.png.
const FIXTURE = path.join(here, 'fixtures', 'yape-pro.png');
const MONTO = 10;              // S/ 10 mensual
const TIPO_PLAN = 'mensual';

const results = [];
const check = (name, cond, detail) => {
  results.push({ name, pass: !!cond, detail });
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail ? '  — ' + detail : ''));
  return !!cond;
};

let userId = null;

// El request no termina cuando llega la confirmacion: `procesarComprobantePro` emite el
// "Comprobante recibido" y RECIEN DESPUES webhook.js llama a `guardarTransaccion`. Sin esperar,
// los checks del final leen una fila a medio escribir y su color lo decide el scheduler.
//
// Se espera la ULTIMA escritura del branch, que es la fila de `transacciones`: despues de ella
// `guardarTransaccion` solo llama a `iniciarTrialSiCorresponde`, que con este fixture es no-op
// (el trial ya esta vencido). Cota generosa a proposito: cruzarla es una FALLA declarada (sale
// rojo, con su check propio), no un sleep mudo que despues afirme sobre cualquier cosa.
const ESPERA_COLA_MS = 20000;
async function esperarColaDelRequest() {
  const t0 = Date.now();
  while (Date.now() - t0 < ESPERA_COLA_MS) {
    const { data, error } = await h.supabase.from('transacciones')
      .select('id').eq('usuario_id', userId).limit(1);
    // supabase-js NO lanza: sin leer `error`, un fallo de red se veria igual que "todavia no
    // esta" y esta espera se convertiria en un sleep de 20s que despues afirma sobre nada.
    if (error) throw new Error('esperando la cola del request: ' + error.message);
    if ((data || []).length) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function run(h) {
  // ── Sembrar el usuario throwaway (en el muro, con la ventana de comprobante abierta) ──
  //
  // EL FIXTURE ES ALGUIEN QUE YA GASTÓ SU PRUEBA, y no un usuario recién nacido. Las dos
  // razones son la misma:
  //
  //   · **Realismo.** Nadie manda una captura de Yape mientras tiene Pro gratis. Quien paga es
  //     el que chocó contra el muro: `plan='free'` con `trial_estado='vencido'`.
  //   · **Poder de detección**, que es lo que lo hace obligatorio. Con un usuario nuevo, el
  //     gasto de suscripción le arranca su trial legítimo y la fila termina en
  //     `plan='premium', trial_estado='activo'` — o sea EXACTAMENTE el mismo estado que dejaría
  //     una mutación que entregue Pro al recibir la captura. Medido: con el fixture nuevo puesto
  //     a `plan='premium', trial_estado='activo'` desde `reclamarSolicitudPro`, el harness salía
  //     **16/16 en verde**. Un estado final indistinguible del legítimo no se puede afirmar.
  //     Con el trial ya vencido, `iniciarTrialSiCorresponde` es no-op (su CAS exige
  //     `trial_estado IS NULL`), así que CUALQUIER premium después de la captura es el defecto.
  //
  // Y de yapa saca la última carrera: en este fixture nada de la cola escribe `plan`.
  //
  // Y llega por la puerta que usa esa población: `esperando_comprobante` + la ventana de 48h
  // que abre `solicitarComprobante`, NO por `onboarding_paso === 2`. Las dos ramas viven en
  // `esperaComprobante` y la de paso 2 es la del alta inicial — o sea que sembrar paso 2 y
  // trial vencido a la vez era una quimera: un usuario que nunca existe. De yapa, esta rama
  // hace que el check de `esperando_comprobante=false` mida un cambio real (true → false) en
  // vez de una columna que ya nacía en false.
  const AYER = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const { data: creado, error: insErr } = await h.supabase.from('usuarios').insert({
    whatsapp: WA, email: EMAIL, nombre: NOMBRE, is_test_user: true,
    onboarding_paso: 0, onboarding_completado: true, plan: 'free',
    trial_estado: 'vencido', trial_vence: AYER,
    esperando_comprobante: true, comprobante_solicitado_at: new Date().toISOString(),
  }).select('id, onboarding_paso, esperando_comprobante, comprobante_solicitado_at').single();
  if (!check('se sembró el usuario throwaway: en el muro, con la ventana de comprobante abierta',
    !insErr && !!creado, insErr ? insErr.message : 'id=' + creado?.id)) return;
  userId = creado.id;

  // Precondición: el predicado REAL confirma que este usuario enruta al camino Pro, y por la
  // rama que se quiso sembrar. Se afirma que NO entra por `onboarding_paso === 2`, porque esa
  // rama cortocircuita el predicado y dejaría el fixture verde sin ejercitar la ventana.
  check('precondición: esperaComprobante()=true por la ventana de 48h, no por el alta',
    esperaComprobante(creado) === true && creado.onboarding_paso !== 2,
    'paso=' + creado.onboarding_paso + ' esperando=' + creado.esperando_comprobante
    + ' solicitado_at=' + creado.comprobante_solicitado_at);

  // ── Enviar la captura de Yape por el webhook real ────────────────────────────
  const before = h.sent.length;
  const tgBefore = h.telegrams.length;
  const status = await h.postImage(FIXTURE, WA);
  check('el webhook acepta la imagen firmada', status === 200, 'status=' + status);

  const reply = (await h.waitForReply(before)).trim();
  console.log('\n--- mensajes emitidos ---\n' + h.sent.slice(before).map((s) => '[→ ' + s.to + '] ' + s.msg.replace(/\n/g, ' ⏎ ')).join('\n') + '\n');
  check('NETO emitió al menos una respuesta', h.sent.length > before, (h.sent.length - before) + ' mensajes');

  // ── Aserción TEXTO: confirmación de comprobante en verificación al usuario ────
  const alUsuario = h.sent.slice(before).filter((s) => s.to === WA).map((s) => s.msg).join('\n');
  check('el usuario recibió "Comprobante recibido / en verificación"',
    /comprobante recibido/i.test(alUsuario) && /verificando/i.test(alUsuario),
    alUsuario.slice(0, 70).replace(/\n/g, ' '));

  // ── Aserción NOTIFICACIÓN ADMIN ───────────────────────────────────
  // Este check estuvo ROJO PERMANENTE y no era del producto: miraba el canal EQUIVOCADO.
  // `notificarAdmin` intenta Telegram PRIMERO y solo cae a WhatsApp si Telegram no acepta. El
  // 13-ago-2026 el harness sumó un stub de `enviarTelegram` que **devuelve true**, así que desde
  // ese día el fallback dejó de ser alcanzable por construcción y el aviso pasa a `h.telegrams`.
  // O sea que el rojo permanente no era una molestia cosmética: durante meses NADIE verificó
  // que al admin le llegara el comprobante, que es lo único que dispara la aprobación del pago.
  //
  // Se afirma sobre los DOS canales y el detalle NOMBRA por cuál salió: la prioridad la decide
  // `admin-notify.js` y tiene sus tests, pero un cambio de canal silencioso se ve acá igual.
  const alAdminWa = h.sent.slice(before).filter((s) => s.to === ADMIN_NUMBER).map((s) => s.msg);
  const alAdminTg = h.telegrams.slice(tgBefore);
  const canal = alAdminTg.length ? 'telegram'
    : (alAdminWa.length ? 'whatsapp(' + ADMIN_NUMBER + ')' : 'NINGUNO');
  const alAdmin = alAdminTg.concat(alAdminWa).join('\n');
  check('salió la notificación al admin (comprobante Pro)',
    /comprobante de pago pro/i.test(alAdmin) && alAdmin.includes(TIPO_PLAN),
    'canal=' + canal + ' ' + alAdmin.slice(0, 60).replace(/\n/g, ' '));

  // ── Aserción EFECTO 1: fila en `pagos` (lo que blinda contra falso positivo) ──
  const { data: pagos, error: pErr } = await h.supabase.from('pagos')
    .select('id, usuario_id, monto, monto_detectado, moneda, tipo_plan, metodo_pago, estado, origen, comprobante_url')
    .eq('usuario_id', userId).order('created_at', { ascending: false });
  if (pErr) throw new Error('query pagos: ' + pErr.message);
  check('se insertó exactamente 1 fila en `pagos` para el throwaway',
    (pagos || []).length === 1, (pagos || []).length + ' filas (esperaba 1)');
  const pago = (pagos || [])[0];
  if (pago) {
    check('la fila de `pagos` quedó pendiente, origen whatsapp, plan/monto correctos',
      pago.estado === 'pendiente' && pago.origen === 'whatsapp' &&
      pago.tipo_plan === TIPO_PLAN && Number(pago.monto) === MONTO &&
      Number(pago.monto_detectado) === MONTO && pago.moneda === 'PEN' && pago.metodo_pago === 'Yape',
      'estado=' + pago.estado + ' origen=' + pago.origen + ' plan=' + pago.tipo_plan +
      ' monto=' + pago.monto + ' det=' + pago.monto_detectado + ' metodo=' + pago.metodo_pago);
    check('la fila trae comprobante_url (path de Storage)',
      !!pago.comprobante_url && pago.comprobante_url.startsWith(userId + '/'),
      'comprobante_url=' + pago.comprobante_url);
  }

  // ── Aserción EFECTO 2: el objeto existe en el bucket privado `comprobantes` ───
  if (pago && pago.comprobante_url) {
    const { data: blob, error: dlErr } = await h.supabase.storage
      .from('comprobantes').download(pago.comprobante_url);
    const size = blob ? (blob.size || (await blob.arrayBuffer()).byteLength) : 0;
    check('el comprobante está subido a Storage (bucket comprobantes)',
      !dlErr && size > 0, dlErr ? dlErr.message : 'size=' + size + ' bytes');
  }

  // ── Aserción EFECTO 3: flags del usuario tras la solicitud ───────────────────
  //
  // ANTES DE LEER, esperar a que el request TERMINE. `waitForReply` vuelve con la
  // confirmación, y la confirmación se emite DENTRO de `procesarComprobantePro` — o sea que
  // cuando el harness sigue, a webhook.js todavía le queda su `guardarTransaccion` (el gasto
  // de suscripción). Leer `usuarios` acá era una CARRERA contra esa escritura, y ése es el
  // origen real de la segunda roja "permanente": el 26-ago-2026 dos corridas separadas por
  // 3 minutos, sin ningún cambio de código en el medio, dieron `plan=free` y `plan=premium`.
  // Las dos dejaron su fila en `transacciones` (verificado en `borrados_auditoria`), o sea
  // que el trial arranca SIEMPRE y lo único que variaba era quién ganaba la carrera.
  const colaLista = await esperarColaDelRequest();
  check('el request terminó su cola (se registró el gasto de suscripción)', colaLista,
    colaLista ? 'fila en transacciones' : 'no llegó en ' + (ESPERA_COLA_MS / 1000) + 's');

  // Se lee DOS veces y se exige que coincidan. Dos motivos, y los dos salieron de revisiones:
  //
  //   · **La cola no termina en la fila de `transacciones`.** Después del insert,
  //     `guardarTransaccion` llama igual a `iniciarTrialSiCorresponde`, que emite un UPDATE
  //     sobre `usuarios`. Con este fixture es no-op (su CAS exige `trial_estado IS NULL` y acá
  //     dice 'vencido') — pero eso vale para el código CORRECTO, y este harness existe para el
  //     incorrecto: una mutación que escriba el plan en esa cola es justo lo que hay que ver.
  //     Esperar la fila y leer una sola vez dejaba ~1 RTT de carrera contra esa escritura.
  //   · Una lectura estable es una afirmación; una sola lectura durante una escritura no lo es.
  //
  // Y se lee el `error`: supabase-js NO lanza, así que sin esto una caída de red deja `uAfter`
  // en undefined, las seis condiciones de abajo dan false y el harness sale ROJO acusando al
  // producto de entregar Pro cuando lo único que pasó es que no se pudo preguntar.
  const COLS = 'pago_pendiente, estado_pago, esperando_comprobante, plan, trial_estado, premium_desde, premium_vence';
  const leerUsuario = async () => {
    const { data, error } = await h.supabase.from('usuarios').select(COLS).eq('id', userId).single();
    if (error) throw new Error('leyendo el estado final del usuario: ' + error.message);
    return data;
  };
  let uAfter = await leerUsuario();
  let estable = false;
  for (let i = 0; i < 8 && !estable; i++) {
    await new Promise((r) => setTimeout(r, 250));
    const otra = await leerUsuario();
    estable = JSON.stringify(otra) === JSON.stringify(uAfter);
    uAfter = otra;
  }
  check('la fila del usuario dejó de moverse (nada escribe después del request)', estable,
    estable ? 'dos lecturas iguales' : 'seguía cambiando: ' + JSON.stringify(uAfter));
  check('usuario marcado pago_pendiente/estado_pago pendiente y esperando_comprobante=false',
    uAfter?.pago_pendiente === true && uAfter?.estado_pago === 'pendiente' &&
    uAfter?.esperando_comprobante === false,
    'pago_pendiente=' + uAfter?.pago_pendiente + ' estado_pago=' + uAfter?.estado_pago +
    ' esperando=' + uAfter?.esperando_comprobante);

  // La afirmación pasa a ser la que SE SOSTIENE, no la que ganaba por llegar temprano.
  // `plan === 'free'` era falsa de fondo: ese gasto arranca los 14 días y durante el trial
  // `plan` vale `'premium'` a propósito (ver CLAUDE.md — `plan==='premium'` ya NO significa
  // "paga").
  //
  // PERO `esProPagado(uAfter) === false` A SECAS ES DEMASIADO DÉBIL, y ése fue el hallazgo de
  // la revisión adversarial: ese predicado es `plan==='premium' && trial_estado!=='activo'`,
  // así que su negación la satisface CUALQUIER fila con `trial_estado='activo'`. Una mutación
  // que entregara Pro disfrazado de trial —`plan='premium', trial_estado='activo'` al recibir
  // la captura— pasaba VERDE con la aserción nueva y salía ROJA con la vieja, y `plan='premium'`
  // es justo lo que abre los ~40 gates que miran esa columna. El check habría dejado de poder
  // ver "subir cualquier imagen que parezca un Yape entrega Pro".
  //
  // Por eso se afirma el estado ESPERADO ENTERO en vez de una negación. Lo que separa el trial
  // legítimo de una concesión disfrazada son las dos columnas de la suscripción:
  // `iniciarTrialSiCorresponde` escribe `premium_vence: null` como invariante declarado
  // (migración 052) y no toca `premium_desde`; `activarPro` escribe las dos.
  // Con el fixture de arriba —trial ya vencido— la fila NO puede volverse premium por ninguna
  // vía legítima en este request, así que se afirma el estado ESPERADO y no una negación.
  //
  // Las TRES columnas de la condición son las tres por las que se podría entregar Pro, y cada
  // una aporta algo distinto: `plan` es lo que miran los ~40 gates, `trial_estado` distingue
  // una concesión disfrazada de prueba, y `premium_desde`/`premium_vence` son las dos fechas
  // que sólo escribe `activarPro` (`iniciarTrialSiCorresponde` deja `premium_vence` en null
  // por invariante de la migración 052).
  //
  // `esProPagado()` quedó FUERA de la condición y sólo se imprime, y es deliberado: dado
  // `plan === 'free'` en el mismo `&&`, `esProPagado === false` es una tautología —el predicado
  // es `plan==='premium' && …`— o sea cero poder de detección disfrazado de rigor. `estado_pago`
  // tampoco va acá: ya lo afirma el check de arriba, y su default en la base ES 'pendiente'.
  const proPagado = esProPagado(uAfter);
  check('el pago NO activó nada: sigue en el muro y pendiente hasta que alguien apruebe',
    uAfter?.plan === 'free'
    && uAfter?.trial_estado === 'vencido'
    && uAfter?.premium_vence === null
    && uAfter?.premium_desde === null,
    'plan=' + uAfter?.plan + ' trial_estado=' + uAfter?.trial_estado +
    ' estado_pago=' + uAfter?.estado_pago + ' esProPagado=' + proPagado +
    ' premium_desde=' + uAfter?.premium_desde + ' premium_vence=' + uAfter?.premium_vence);
}

async function cleanup(h) {
  if (!userId) {
    const { data } = await h.supabase.from('usuarios').select('id').eq('whatsapp', WA).maybeSingle();
    userId = data?.id || null;
  }
  if (!userId) { check('limpieza: no quedó usuario throwaway', true, 'nada que borrar'); return; }

  // Orden cuidadoso: primero el objeto de Storage (leyendo su path de `pagos`), luego
  // las filas dependientes, y al final el usuario.
  const { data: pagos } = await h.supabase.from('pagos')
    .select('id, comprobante_url').eq('usuario_id', userId);
  const paths = (pagos || []).map((p) => p.comprobante_url).filter(Boolean);
  if (paths.length) {
    const { error: rmErr } = await h.supabase.storage.from('comprobantes').remove(paths);
    check('se borró el objeto de Storage', !rmErr, rmErr ? rmErr.message : paths.join(', '));
  }
  const { error: delPagos } = await h.supabase.from('pagos').delete().eq('usuario_id', userId);
  check('se borraron las filas de `pagos`', !delPagos, delPagos ? delPagos.message : 'ok');

  await h.supabase.from('transacciones').delete().eq('usuario_id', userId);
  await h.supabase.from('reglas_comercio').delete().eq('usuario_id', userId);
  await h.supabase.from('conversaciones').delete().eq('usuario_id', userId);
  const { error: delErr } = await h.supabase.from('usuarios').delete().eq('id', userId);
  const { data: gone } = await h.supabase.from('usuarios').select('id').eq('id', userId).maybeSingle();
  check('se borró el usuario throwaway y sus dependencias',
    !delErr && !gone, delErr ? delErr.message : 'id=' + userId + ' borrado');
}

const h = await startWebhookHarness();
// Requerir DESPUÉS del harness: pro-payment/admin-notify ya se cargaron durante el
// boot (index → webhook → pro-payment) con el stub de whatsapp en el cache, así que
// este require devuelve esa misma instancia stubeada.
({ esperaComprobante } = require(path.join(appRoot, 'lib/pro-payment.js')));
// El predicado de "¿PAGA?" se importa, no se reimplementa: `plan==='premium'` es cierto
// durante el trial, asi que la copia ingenua da el veredicto al reves.
({ esProPagado } = require(path.join(appRoot, 'lib/trial.js')));
({ ADMIN_NUMBER } = require(path.join(appRoot, 'lib/config.js')));
let fatal = null;
try { await run(h); } catch (e) { fatal = e; console.log('FAIL excepción — ' + e.message); }
try { await cleanup(h); } catch (e) { console.log('FAIL limpieza — ' + e.message); fatal = fatal || e; }
await h.close();

const fallidos = results.filter((r) => !r.pass);
console.log('\n=== ' + (results.length - fallidos.length) + '/' + results.length + ' checks OK ===');
if (fatal) console.log(fatal.stack);
process.exit(fallidos.length === 0 && !fatal ? 0 : 1);
