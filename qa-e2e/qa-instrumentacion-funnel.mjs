// E2E de la INSTRUMENTACIÓN del funnel (commit de 2026-07-31 + migración 050).
//
// El barrido de churn se topó con que las fugas más grandes no eran medibles:
//   1) El alta hace short-circuit antes de message-processor, el único punto que
//      guardaba el turno del usuario → de los 21 que se trabaron en el onboarding no
//      quedaba ni una línea de lo que escribieron.
//   2) `notification_deliveries.estado='sent'` solo significaba "Meta aceptó el POST".
//      Los callbacks de status (delivered/read/failed) llegan SIN `value.messages`, así
//      que el webhook los descartaba en su early return.
//
// Este harness verifica ambas cosas punta a punta contra el webhook real y la Supabase
// real, sin tocar Meta. Usuario throwaway con is_test_user=true, self-cleaning.
//
// Correr:  node qa-e2e/qa-instrumentacion-funnel.mjs   (desde app/)  → exit 0 si pasa.

import { startWebhookHarness } from './webhook-harness.mjs';

const RUN = Date.now();
const WA = 'qa-instr-' + RUN;
const EMAIL = 'qa-instr-' + RUN + '@neto-test.local';
const NOMBRE = 'Ana Instrumento';
const EMAIL_MALO = 'esto no es un correo';
const WAMID = 'wamid.QA-INSTR-' + RUN;

const results = [];
const check = (name, cond, detail) => {
  results.push({ name, pass: !!cond, detail });
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail ? '  — ' + detail : ''));
  return !!cond;
};

let userId = null;
let deliveryId = null;

async function paso(h, texto) {
  const before = h.sent.length;
  await h.postText(texto, WA);
  await h.waitForReply(before);
}

async function turnos(h) {
  const { data } = await h.supabase.from('conversaciones')
    .select('rol, mensaje, created_at').eq('usuario_id', userId).order('created_at', { ascending: true });
  return data || [];
}

// El webhook responde 200 y procesa async: hay que esperar al efecto en DB, no al HTTP.
async function esperar(fn, timeoutMs = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const r = await fn();
    if (r) return r;
    await new Promise((res) => setTimeout(res, 250));
  }
  return null;
}

// Envelope de status de Meta: mismo `field: 'messages'` que un mensaje entrante, pero
// con `statuses` en vez de `messages`. Esta es justo la forma que antes se descartaba.
function statusEnvelope(wamid, status) {
  return {
    object: 'whatsapp_business_account',
    entry: [{
      id: 'qa-entry',
      changes: [{
        field: 'messages',
        value: {
          messaging_product: 'whatsapp',
          metadata: { display_phone_number: '51933014505', phone_number_id: 'qa-phone' },
          statuses: [{
            id: wamid,
            status,
            timestamp: String(Math.floor(Date.now() / 1000)),
            recipient_id: '51999999999',
          }],
        },
      }],
    }],
  };
}

async function run(h) {
  const { data: creado, error: insErr } = await h.supabase.from('usuarios').insert({
    whatsapp: WA, is_test_user: true,
    onboarding_paso: 0, onboarding_completado: false, nombre: null, plan: 'free',
  }).select('id').single();
  if (!check('se sembró el usuario throwaway', !insErr && !!creado, insErr ? insErr.message : 'id=' + creado?.id)) return;
  userId = creado.id;

  // ── Pieza 1: el turno del usuario durante el alta queda guardado ─────────────
  await paso(h, 'hola');
  await paso(h, NOMBRE);
  await paso(h, EMAIL_MALO); // rechazo del validador: la fuga probada del paso 101
  await paso(h, EMAIL);

  // waitForReply vuelve cuando el bot ENVÍA; los guardarMensaje corren después, así
  // que hay que esperar a que el historial se asiente antes de asertar sobre él.
  const conv = (await esperar(async () => {
    const c = await turnos(h);
    return c.filter((x) => x.rol === 'neto').length >= 4 && c.filter((x) => x.rol === 'usuario').length >= 4 ? c : null;
  })) || (await turnos(h));
  const delUsuario = conv.filter((c) => c.rol === 'usuario').map((c) => c.mensaje);
  const delBot = conv.filter((c) => c.rol === 'neto');

  check('se guardan los turnos del USUARIO durante el alta (antes: ninguno)',
    delUsuario.length >= 4, 'turnos usuario=' + delUsuario.length);
  check('quedó el nombre que escribió', delUsuario.includes(NOMBRE), NOMBRE);
  check('quedó el email VÁLIDO que escribió', delUsuario.includes(EMAIL), EMAIL);
  check('quedó el intento FALLIDO de email (la fuga que no se podía diagnosticar)',
    delUsuario.includes(EMAIL_MALO), EMAIL_MALO);
  check('se siguen guardando las respuestas del bot', delBot.length >= 4, 'turnos neto=' + delBot.length);

  // Dentro de un mismo turno el orden sí es determinista (dos awaits secuenciales).
  // Entre turnos no lo es: el harness puede postear el siguiente antes de que el
  // guardado del anterior termine, así que no se asierta sobre el orden global.
  const iNombre = conv.findIndex((c) => c.rol === 'usuario' && c.mensaje === NOMBRE);
  const iRespuesta = conv.findIndex((c) => c.rol === 'neto' && /mucho gusto/i.test(c.mensaje));
  check('dentro del turno, el mensaje del usuario se guarda antes que la respuesta',
    iNombre >= 0 && iRespuesta > iNombre, 'idx usuario=' + iNombre + ' idx bot=' + iRespuesta);

  // ── Pieza 3: los callbacks de status de Meta marcan la entrega real ──────────
  const { data: deliv, error: dErr } = await h.supabase.from('notification_deliveries')
    .insert({ usuario_id: userId, tipo: 'qa_instrumentacion', canal: 'whatsapp', estado: 'sent', wamid: WAMID })
    .select('id, delivered_at, read_at').single();
  if (!check('se registró una entrega con wamid (columna nueva de la migr. 050)',
    !dErr && !!deliv && deliv.delivered_at === null, dErr ? dErr.message : 'id=' + deliv?.id)) return;
  deliveryId = deliv.id;

  const st1 = await h.post(statusEnvelope(WAMID, 'delivered'));
  check('el webhook acepta un callback de status', st1 === 200, 'status=' + st1);

  const entregado = await esperar(async () => {
    const { data } = await h.supabase.from('notification_deliveries').select('delivered_at').eq('id', deliveryId).single();
    return data?.delivered_at ? data : null;
  });
  check('status=delivered marca delivered_at (antes se descartaba en silencio)',
    !!entregado, entregado ? entregado.delivered_at : 'siguió en null tras 8s');

  await h.post(statusEnvelope(WAMID, 'read'));
  const leido = await esperar(async () => {
    const { data } = await h.supabase.from('notification_deliveries').select('read_at').eq('id', deliveryId).single();
    return data?.read_at ? data : null;
  });
  check('status=read marca read_at', !!leido, leido ? leido.read_at : 'siguió en null tras 8s');

  // Un status de un mensaje conversacional (sin fila en deliveries) no debe romper nada.
  const stHuerfano = await h.post(statusEnvelope('wamid.NO-EXISTE-' + RUN, 'delivered'));
  check('un status sin fila asociada es un no-op, no un error', stHuerfano === 200, 'status=' + stHuerfano);
}

async function cleanup(h) {
  if (deliveryId) await h.supabase.from('notification_deliveries').delete().eq('id', deliveryId);
  if (!userId) { check('limpieza: nada que borrar', true, ''); return; }
  await h.supabase.from('conversaciones').delete().eq('usuario_id', userId);
  const { error } = await h.supabase.from('usuarios').delete().eq('id', userId);
  const { data: gone } = await h.supabase.from('usuarios').select('id').eq('id', userId).maybeSingle();
  check('se borró el usuario throwaway, sus conversaciones y la entrega QA',
    !error && !gone, error ? error.message : 'id=' + userId + ' borrado');
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
