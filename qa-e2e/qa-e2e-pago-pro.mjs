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
//        · notifica al admin (sin Telegram env local → fallback WhatsApp, capturado)
//   → confirmación "📸 Comprobante recibido" capturada.
//   Además el branch registra el gasto de suscripción (guardarTransaccion) → 1 fila
//   en `transacciones` (posible upsert en `reglas_comercio`): se limpia también.
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

// Sin Telegram env → notificarSolicitudAdminPro cae a notificarAdmin → enviarWhatsapp
// (stubeado). Lo forzamos por si el .env local trajera las claves: así NO se dispara
// un Telegram real al admin y la notificación queda capturable en h.sent.
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
let esperaComprobante, ADMIN_NUMBER;

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

async function run(h) {
  // ── Sembrar el usuario throwaway (esperando comprobante: onboarding_paso 2) ────
  const { data: creado, error: insErr } = await h.supabase.from('usuarios').insert({
    whatsapp: WA, email: EMAIL, nombre: NOMBRE, is_test_user: true,
    onboarding_paso: 2, onboarding_completado: false, plan: 'free',
  }).select('id, onboarding_paso, esperando_comprobante, comprobante_solicitado_at').single();
  if (!check('se sembró el usuario throwaway en onboarding_paso 2',
    !insErr && !!creado, insErr ? insErr.message : 'id=' + creado?.id)) return;
  userId = creado.id;

  // Precondición: el predicado REAL confirma que este usuario enruta al camino Pro.
  check('precondición: esperaComprobante()=true (camino Pro)',
    esperaComprobante(creado) === true,
    'onboarding_paso=' + creado.onboarding_paso);

  // ── Enviar la captura de Yape por el webhook real ────────────────────────────
  const before = h.sent.length;
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

  // ── Aserción NOTIFICACIÓN ADMIN: fallback WhatsApp al ADMIN_NUMBER ───────────
  const alAdmin = h.sent.slice(before).filter((s) => s.to === ADMIN_NUMBER).map((s) => s.msg).join('\n');
  check('salió la notificación al admin (comprobante Pro)',
    /comprobante de pago pro/i.test(alAdmin) && alAdmin.includes(TIPO_PLAN),
    'to=' + ADMIN_NUMBER + ' ' + alAdmin.slice(0, 60).replace(/\n/g, ' '));

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
  const { data: uAfter } = await h.supabase.from('usuarios')
    .select('pago_pendiente, estado_pago, esperando_comprobante, plan')
    .eq('id', userId).single();
  check('usuario marcado pago_pendiente/estado_pago pendiente y esperando_comprobante=false',
    uAfter?.pago_pendiente === true && uAfter?.estado_pago === 'pendiente' &&
    uAfter?.esperando_comprobante === false,
    'pago_pendiente=' + uAfter?.pago_pendiente + ' estado_pago=' + uAfter?.estado_pago +
    ' esperando=' + uAfter?.esperando_comprobante);
  check('el plan sigue en Free (Pro NO se activa hasta aprobar)',
    uAfter?.plan === 'free', 'plan=' + uAfter?.plan);
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
({ ADMIN_NUMBER } = require(path.join(appRoot, 'lib/config.js')));
let fatal = null;
try { await run(h); } catch (e) { fatal = e; console.log('FAIL excepción — ' + e.message); }
try { await cleanup(h); } catch (e) { console.log('FAIL limpieza — ' + e.message); fatal = fatal || e; }
await h.close();

const fallidos = results.filter((r) => !r.pass);
console.log('\n=== ' + (results.length - fallidos.length) + '/' + results.length + ' checks OK ===');
if (fatal) console.log(fatal.stack);
process.exit(fallidos.length === 0 && !fatal ? 0 : 1);
