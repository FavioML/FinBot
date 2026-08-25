import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import path from 'path';

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]):/, '$1:'), '../..');

// Regresion de lib/pro-payment.js: escrituras y avisos que dependian de una lectura
// que puede fallar sin lanzar. Ver docs/SESION-escrituras-sobre-lectura-fallida.md.
//
// Los tres que costaban plata:
//  - reclamarPagoPendiente devolvia null con el SELECT roto, y routes/admin.js respondia
//    { ok: true, already: true, "El pago ya estaba procesado" }: el usuario pagaba, el
//    admin veia exito y Pro no se activaba nunca.
//  - registrarPagoAprobado insertaba una fila aprobada nueva si no podia leer el pendiente
//    (`pagos` no tiene unique que lo frene): revenue inflado + pendiente huerfano.
//  - activarPro mandaba "¡Pago confirmado!" aunque el UPDATE del plan hubiera fallado.

let router;
let ops = [];
function makeChain(table, op) {
  const q = { table, op, payload: null, methods: [] };
  const chain = {};
  for (const m of ['eq', 'neq', 'gte', 'lte', 'lt', 'gt', 'ilike', 'limit', 'order', 'not', 'in', 'or']) {
    chain[m] = (...a) => { q.methods.push([m, ...a]); return chain; };
  }
  // `.select()` DESPUES de un insert/update no es una lectura: es la clausula RETURNING de esa
  // escritura. Se registra en `q.returning` para que un router pueda devolver filas solo cuando
  // se pidieron — sin eso, quitarle el `.select('id')` a una escritura no cambia nada en el mock
  // y la mutacion sobrevive.
  chain.select = (cols, opts) => { if (!q.op) q.op = 'select'; else q.returning = cols || '*'; if (opts && opts.head) q.head = true; return chain; };
  // **`single` y `maybeSingle` NO son la misma cosa, y tratarlas igual dejaba invisible media
  // decision.** Sobre cero filas `maybeSingle` devuelve `{data:null,error:null}` y `single`
  // devuelve `PGRST116` **en `error`** — o sea que con `.single()` un "no existe" legitimo entra
  // por la rama de "la lectura se cayo". Con las dos colapsadas, volver `maybeSingle` a
  // `single` en `routes/admin.js` dejaba la suite verde y el 404 disfrazado de 500.
  // Es el mismo modo de falla que el RETURNING sin modelar, un archivo mas alla.
  chain.single = () => { q.single = 'single'; return chain; };
  chain.maybeSingle = () => { q.single = 'maybe'; return chain; };
  chain.then = (resolve, reject) => {
    ops.push(q);
    const r = { data: null, error: null, ...(router(q) || {}) };
    const vacio = r.data === null || r.data === undefined || (Array.isArray(r.data) && r.data.length === 0);
    if (q.single === 'single' && !r.error && vacio) {
      r.error = { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' };
    }
    return Promise.resolve(r).then(resolve, reject);
  };
  return { chain, q };
}

const dbMock = {
  supabase: {
    from: (t) => ({
      select: (...a) => makeChain(t).chain.select(...a),
      insert: (p) => { const { chain, q } = makeChain(t, 'insert'); q.payload = p; return chain; },
      update: (p) => { const { chain, q } = makeChain(t, 'update'); q.payload = p; return chain; },
    }),
    storage: { from: () => ({ upload: async () => ({ error: null }) }) },
  },
};
const logMock = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn() };
const waMock = { enviarWhatsapp: vi.fn().mockResolvedValue(true) };
const notifyMock = { notificarAdmin: vi.fn().mockResolvedValue(true) };
const tgMock = { enviarTelegramFotoConBotones: vi.fn().mockResolvedValue({ ok: true }) };
const notifDbMock = { crearNotificacion: vi.fn().mockResolvedValue(true) };
const gmailMock = { generarUrlAutorizacion: () => 'https://oauth.example/x' };
const helpersMock = { guardarMensaje: vi.fn().mockResolvedValue(true) };
const refMock = {
  procesarConversionProReferido: vi.fn().mockResolvedValue(true),
  resumenReferidoParaAdmin: vi.fn().mockResolvedValue({}),
};

for (const [rel, exports] of [
  ['lib/db.js', dbMock], ['lib/logger.js', logMock], ['lib/whatsapp.js', waMock],
  ['lib/admin-notify.js', notifyMock], ['lib/telegram.js', tgMock],
  ['lib/notifications-db.js', notifDbMock], ['gmail.js', gmailMock],
  ['helpers/db-helpers.js', helpersMock], ['services/referrals.js', refMock],
]) {
  const p = require.resolve(path.join(projectRoot, rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}

const pro = require('../../lib/pro-payment');

const FALLO = { data: null, error: { message: 'read failure', code: '500' } };
const USUARIO = { id: 'u-1', whatsapp: '51999888777', nombre: 'Favio', plan: 'free', premium_vence: null, premium_desde: null };
const escrituras = (tabla) => ops.filter(o => (o.op === 'insert' || o.op === 'update') && (!tabla || o.table === tabla));

beforeEach(() => {
  ops = [];
  for (const m of [logMock.error, logMock.warn, waMock.enviarWhatsapp, notifyMock.notificarAdmin, tgMock.enviarTelegramFotoConBotones, notifDbMock.crearNotificacion, refMock.procesarConversionProReferido]) m.mockClear();
});

describe('reclamarPagoPendiente', () => {
  it('lanza cuando no puede leer el pendiente, en vez de decir "ya procesado"', async () => {
    router = (q) => (q.table === 'pagos' && q.op === 'select') ? FALLO : {};
    await expect(pro.reclamarPagoPendiente({ usuarioId: 'u-1' })).rejects.toThrow(/pago pendiente/i);
    expect(logMock.error).toHaveBeenCalled();
  });

  it('devuelve null sin lanzar cuando de verdad no hay pendiente', async () => {
    router = () => ({ data: null, error: null });
    await expect(pro.reclamarPagoPendiente({ usuarioId: 'u-1' })).resolves.toBeNull();
  });

  it('lanza cuando el claim falla por error', async () => {
    router = (q) => (q.table === 'pagos' && q.op === 'update') ? FALLO : { data: { id: 'pago-1' } };
    await expect(pro.reclamarPagoPendiente({ pagoId: 'pago-1' })).rejects.toThrow(/claim/i);
  });

  it('devuelve null sin lanzar cuando otro tap ya gano la fila (doble-tap sigue idempotente)', async () => {
    router = (q) => (q.table === 'pagos' && q.op === 'update') ? { data: null, error: null } : { data: { id: 'pago-1' } };
    await expect(pro.reclamarPagoPendiente({ pagoId: 'pago-1' })).resolves.toBeNull();
  });

  it('devuelve la fila reclamada en el camino feliz', async () => {
    router = (q) => (q.op === 'update') ? { data: { id: 'pago-1', usuario_id: 'u-1' } } : { data: { id: 'pago-1' } };
    await expect(pro.reclamarPagoPendiente({ usuarioId: 'u-1' })).resolves.toEqual({ id: 'pago-1', usuario_id: 'u-1' });
  });
});

/**
 * El claim de la ENTRADA (`reclamarSolicitudPro`), hermano del de la aprobación. Su semántica
 * contra PostgREST de verdad —incluido que `or=(is.false,is.null)` es una forma válida— se
 * verificó a mano contra la DB el 2026-08-23; acá se fija el contrato que ve el resto del código.
 */
describe('reclamarSolicitudPro', () => {
  it('gana cuando el UPDATE condicional matcheó la fila', async () => {
    router = () => ({ data: { id: 'u-1' }, error: null });
    await expect(pro.reclamarSolicitudPro('u-1')).resolves.toBe(true);
  });

  it('no gana cuando otro comprobante ya abrió la solicitud', async () => {
    router = () => ({ data: null, error: null });
    await expect(pro.reclamarSolicitudPro('u-1')).resolves.toBe(false);
  });

  it('lanza cuando la consulta falla, en vez de hacerlo pasar por "otro ganó"', async () => {
    // La lección literal de `reclamarPagoPendiente`: devolver false acá le contesta al usuario
    // "ya tenemos tu comprobante en verificación" sobre una solicitud que no existe.
    router = () => FALLO;
    await expect(pro.reclamarSolicitudPro('u-1')).rejects.toThrow(/reclamar la solicitud/i);
    expect(logMock.error).toHaveBeenCalled();
  });

  it('el UPDATE es condicional, apunta a UNA fila, y cubre el NULL de `pago_pendiente`', async () => {
    // Sin el `or`, PostgREST descarta las filas en NULL igual que SQL, y esa columna es
    // nullable. Sin la condición entera, el claim gana siempre y no cierra ninguna carrera.
    //
    // Y el `eq('id')` se afirma explícitamente porque **ningún otro test puede verlo**: los
    // almacenes falsos tienen UNA fila, y un almacén de una fila no distingue un WHERE que
    // apunta a esa fila de uno que apunta a todas. Sin `eq`, este UPDATE marca
    // `pago_pendiente=true` a TODO el padrón. Lo midió la segunda revisión adversarial:
    // quitarlo pasaba los 1835 tests.
    router = () => ({ data: { id: 'u-1' }, error: null });
    await pro.reclamarSolicitudPro('u-1');
    const q = ops.find((o) => o.table === 'usuarios' && o.op === 'update');
    expect(q.payload).toMatchObject({ pago_pendiente: true, estado_pago: 'pendiente', esperando_comprobante: false });
    expect(q.methods, 'el claim escribe sin apuntar a una fila').toContainEqual(['eq', 'id', 'u-1']);
    const or = q.methods.find((m) => m[0] === 'or');
    expect(or, 'el claim perdió su condición: gana siempre').toBeTruthy();
    expect(or[1]).toContain('pago_pendiente.is.null');
  });
});

describe('registrarSolicitudPro con la solicitud ya reclamada', () => {
  const args = {
    usuario: USUARIO, monto: 10, montoDetectado: 10, tipoPlan: 'mensual',
    metodoPago: 'Yape', comprobanteBuffer: null, mimeType: 'image/jpeg', origen: 'whatsapp',
  };

  it('no repite el UPDATE de `usuarios`: lo escribió el claim', async () => {
    router = (q) => (q.table === 'pagos' && q.op === 'insert' ? { data: { id: 'pago-1' } } : {});
    const r = await pro.registrarSolicitudPro({ ...args, yaReclamado: true });
    expect(escrituras('usuarios')).toHaveLength(0);
    // Y lo reporta como marcado, porque LO ESTÁ. Devolver false acá dispara la alarma de
    // "solicitud incompleta" del canal silencioso sobre una solicitud sana.
    expect(r.usuarioMarcado).toBe(true);
  });

  it('control: sin reclamar, sigue marcando al usuario como antes', async () => {
    // El canal webapp (`routes/pro.js`) no pasa por el claim y depende de este UPDATE.
    router = (q) => (q.table === 'pagos' && q.op === 'insert' ? { data: { id: 'pago-1' } } : {});
    const r = await pro.registrarSolicitudPro(args);
    const w = escrituras('usuarios');
    expect(w).toHaveLength(1);
    expect(w[0].payload).toMatchObject({ pago_pendiente: true, esperando_comprobante: false });
    expect(r.usuarioMarcado).toBe(true);
  });
});

/**
 * La contraparte del claim. `registrarSolicitudPro` NO lanza cuando el INSERT en `pagos` falla
 * (try/catch propio), así que sin esto el usuario queda con `pago_pendiente=true` sobre una
 * solicitud que no existe: WhatsApp le dice "en verificación", la webapp le esconde el
 * formulario, el panel prende el badge sin nada que aprobar, y las dos rutas que limpian el
 * flag necesitan un `pagoId`. Para el del canal silencioso, que no tiene número, ni siquiera
 * queda el `/pago` manual. Lo encontró la revisión adversarial del diff.
 */
describe('el claim se suelta si la solicitud no quedó', () => {
  const args = { usuario: USUARIO, parsed: { monto: 10, metodo_pago: 'Yape' }, imgBuffer: null, mimeType: 'image/jpeg', from: '51999888777' };
  const liberaciones = () => ops.filter((o) => o.table === 'usuarios' && o.op === 'update'
    && o.payload && o.payload.pago_pendiente === false);

  it('con el INSERT en `pagos` caído, suelta el claim', async () => {
    router = (q) => (q.table === 'pagos' && q.op === 'insert') ? FALLO : {};
    await pro.procesarComprobantePro({ ...args, yaReclamado: true });
    expect(liberaciones()).toHaveLength(1);
    // Mismo motivo que en el claim: con un almacén de una fila, un UPDATE sin `eq` es
    // indistinguible de uno con `eq`. Sin él, esto apaga `pago_pendiente` de TODO el padrón.
    expect(liberaciones()[0].methods, 'suelta sin apuntar a una fila').toContainEqual(['eq', 'id', 'u-1']);
  });

  it('si hay una solicitud pendiente de verdad, NO suelta', async () => {
    // El INSERT pudo commitear y perderse la respuesta, o la webapp —que guarda contra `pagos`
    // y no contra `pago_pendiente`— pudo abrir la suya durante la subida a Storage. Soltar ahí
    // apaga el badge de una solicitud real y reabre la carrera. Lo midió la segunda revisión.
    router = (q) => {
      if (q.table === 'pagos' && q.op === 'insert') return FALLO;
      if (q.table === 'pagos' && q.op === 'select') return { data: { id: 'pago-9' } };
      return {};
    };
    await pro.procesarComprobantePro({ ...args, yaReclamado: true });
    expect(liberaciones()).toHaveLength(0);
    expect(logMock.warn).toHaveBeenCalled();
  });

  it('si no se puede COMPROBAR si la hay, tampoco suelta', async () => {
    // Una lectura caída no es "no hay ninguna". Se deja el claim puesto: es el estado previo,
    // el admin ya tiene su aviso, y equivocarse al otro lado duplica una solicitud de plata.
    router = (q) => {
      if (q.table === 'pagos' && q.op === 'insert') return FALLO;
      if (q.table === 'pagos' && q.op === 'select') return FALLO;
      return {};
    };
    await pro.procesarComprobantePro({ ...args, yaReclamado: true });
    expect(liberaciones()).toHaveLength(0);
    expect(logMock.error).toHaveBeenCalled();
  });

  it('con la solicitud creada, NO lo suelta', async () => {
    // El control: sin esto, lo de arriba pasaría igual con un `liberar` incondicional, que es
    // la mutación que borra el claim de todo el mundo y reabre la carrera entera.
    router = (q) => (q.table === 'pagos' && q.op === 'insert') ? { data: { id: 'pago-1' } } : {};
    await pro.procesarComprobantePro({ ...args, yaReclamado: true });
    expect(liberaciones()).toHaveLength(0);
  });

  it('sin claim tomado (canal webapp) tampoco lo suelta: no era suyo', async () => {
    router = (q) => (q.table === 'pagos' && q.op === 'insert') ? FALLO : {};
    await pro.procesarComprobantePro(args);
    expect(liberaciones()).toHaveLength(0);
  });
});

describe('registrarPagoAprobado', () => {
  it('no inserta una fila aprobada cuando no puede leer el pendiente', async () => {
    router = (q) => (q.table === 'pagos' && q.op === 'select') ? FALLO : {};
    await pro.registrarPagoAprobado('u-1', { tipoPlan: 'mensual', premiumDesde: '2026-07-22', premiumVence: '2026-08-22' });
    expect(escrituras('pagos')).toHaveLength(0);
    expect(logMock.error).toHaveBeenCalled();
    expect(notifyMock.notificarAdmin).toHaveBeenCalled();
  });

  it('inserta cuando la lectura confirma que no hay pendiente', async () => {
    router = () => ({ data: null, error: null });
    await pro.registrarPagoAprobado('u-1', { tipoPlan: 'mensual', premiumDesde: '2026-07-22', premiumVence: '2026-08-22' });
    const ins = escrituras('pagos');
    expect(ins).toHaveLength(1);
    expect(ins[0].op).toBe('insert');
    expect(ins[0].payload.estado).toBe('aprobado');
  });

  it('marca aprobado el pendiente existente sin insertar', async () => {
    router = (q) => (q.op === 'select') ? { data: { id: 'pago-1' } } : {};
    await pro.registrarPagoAprobado('u-1', { tipoPlan: 'mensual', premiumDesde: '2026-07-22', premiumVence: '2026-08-22' });
    const w = escrituras('pagos');
    expect(w).toHaveLength(1);
    expect(w[0].op).toBe('update');
  });
});

describe('activarPro', () => {
  it('no avisa "Pago confirmado" si el UPDATE del plan falla', async () => {
    router = (q) => (q.table === 'usuarios' && q.op === 'update') ? FALLO : {};
    await expect(pro.activarPro({ usuario: USUARIO, tipoPlan: 'mensual', pagoId: 'pago-1' })).rejects.toThrow(/activar Pro/i);
    expect(waMock.enviarWhatsapp).not.toHaveBeenCalled();
    expect(notifDbMock.crearNotificacion).not.toHaveBeenCalled();
  });

  it('devuelve el pago a pendiente para que el admin pueda reintentar', async () => {
    router = (q) => (q.table === 'usuarios' && q.op === 'update') ? FALLO : {};
    await expect(pro.activarPro({ usuario: USUARIO, tipoPlan: 'mensual', pagoId: 'pago-1' })).rejects.toThrow();
    const rollback = escrituras('pagos').find(o => o.payload && o.payload.estado === 'pendiente');
    expect(rollback).toBeTruthy();
    expect(rollback.methods).toContainEqual(['eq', 'id', 'pago-1']);
  });

  it('avisa al admin si ni siquiera se pudo revertir el pago', async () => {
    router = () => FALLO;
    await expect(pro.activarPro({ usuario: USUARIO, tipoPlan: 'mensual', pagoId: 'pago-1' })).rejects.toThrow();
    expect(notifyMock.notificarAdmin).toHaveBeenCalled();
  });

  it('camino feliz: activa, avisa por WhatsApp y notifica in-app', async () => {
    router = () => ({ data: null, error: null });
    const { venceStr } = await pro.activarPro({ usuario: USUARIO, tipoPlan: 'mensual', pagoId: 'pago-1' });
    expect(venceStr).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(escrituras('usuarios')[0].payload.plan).toBe('premium');
    expect(waMock.enviarWhatsapp).toHaveBeenCalledTimes(1);
    expect(notifDbMock.crearNotificacion).toHaveBeenCalledTimes(1);
  });
});

// Regresion 2026-07-31: un usuario que eligio Pro durante el alta queda en onboarding_paso 2
// (espera del comprobante). Solo el comando /pago lo devolvia a 0, via flag opcional; el boton
// de Telegram, el panel admin y /activar no. Resultado real: pago aprobado el 2026-07-21,
// plan premium, y el usuario respondido con "elige tu plan / mandame la captura" ante cada
// mensaje durante 10 dias, porque esperaComprobante() mira onboarding_paso === 2.
describe('activarPro: desatasco del onboarding', () => {
  const enPaso2 = { ...USUARIO, onboarding_paso: 2, onboarding_completado: false };

  it('saca del paso 2 y marca el alta completa (sin flag, por cualquier ruta de aprobacion)', async () => {
    router = () => ({ data: null, error: null });
    await pro.activarPro({ usuario: enPaso2, tipoPlan: 'mensual', pagoId: 'pago-1' });
    const payload = escrituras('usuarios')[0].payload;
    expect(payload.onboarding_paso).toBe(0);
    expect(payload.onboarding_completado).toBe(true);
  });

  it('el estado resultante ya no dispara esperaComprobante (el usuario puede volver a usar Neto)', async () => {
    router = () => ({ data: null, error: null });
    await pro.activarPro({ usuario: enPaso2, tipoPlan: 'mensual', pagoId: 'pago-1' });
    const payload = escrituras('usuarios')[0].payload;
    expect(pro.esperaComprobante({ ...enPaso2, ...payload })).toBe(false);
  });

  it('marcar el alta completa evita que el trigger de usuario nuevo lo mande de vuelta al paso 100', async () => {
    router = () => ({ data: null, error: null });
    await pro.activarPro({ usuario: enPaso2, tipoPlan: 'mensual', pagoId: 'pago-1' });
    const final = { ...enPaso2, ...escrituras('usuarios')[0].payload };
    // Replica del trigger en handlers/onboarding.js: sin token de Gmail, onboarding_completado
    // en false manda al usuario a "¿como te llamas?" aunque ya haya dado nombre y correo.
    expect(!final.gmail_access_token && !final.onboarding_completado).toBe(false);
  });

  it('no toca el onboarding de un usuario que ya lo termino (renovacion no pisa estado)', async () => {
    router = () => ({ data: null, error: null });
    await pro.activarPro({ usuario: { ...USUARIO, onboarding_paso: 0, onboarding_completado: true }, tipoPlan: 'mensual', pagoId: 'pago-1' });
    const payload = escrituras('usuarios')[0].payload;
    expect(payload).not.toHaveProperty('onboarding_paso');
    expect(payload).not.toHaveProperty('onboarding_completado');
  });

  it('no arrastra al usuario parado en otro paso del alta (ej. 101, dando su correo)', async () => {
    router = () => ({ data: null, error: null });
    await pro.activarPro({ usuario: { ...USUARIO, onboarding_paso: 101, onboarding_completado: false }, tipoPlan: 'mensual', pagoId: 'pago-1' });
    const payload = escrituras('usuarios')[0].payload;
    expect(payload).not.toHaveProperty('onboarding_paso');
    expect(payload).not.toHaveProperty('onboarding_completado');
  });
});

// Regresion 2026-08-02: el camino COMP (Pro regalado, sin pago). Lo usan POST /admin/activar
// y el comando /activar de WhatsApp, los dos con esConversionPagada:false. La ruta HTTP escribia
// su propio UPDATE de 4 columnas en vez de llamar activarPro, y de esa divergencia salian los
// tres agujeros de abajo: el trial sin sellar (checkTrialExpiry bajaba el comp a free al dia 15),
// el periodo contado siempre desde hoy (un comp ACORTABA una suscripcion vigente) y el
// onboarding_paso 2 sin desatascar.
describe('activarPro: comp (esConversionPagada false)', () => {
  const { PRO_PRECIOS } = require('../../lib/config');
  const comp = (usuario) => pro.activarPro({
    usuario, tipoPlan: 'mensual', aprobadoPor: 'admin:comp',
    enviarLinkGmail: false, esConversionPagada: false,
  });

  it('sella el trial como convertido: el cron de vencimiento ya no lo baja a free', async () => {
    router = () => ({ data: null, error: null });
    await comp({ ...USUARIO, trial_estado: 'activo', trial_vence: '2099-03-10' });
    // checkTrialExpiry (cron/checks.js) baja a `plan:'free'` todo lo que siga en 'activo'.
    expect(escrituras('usuarios')[0].payload.trial_estado).toBe('convertido');
  });

  it('escribe el set completo de columnas que el UPDATE a mano se saltaba', async () => {
    router = () => ({ data: null, error: null });
    await comp(USUARIO);
    const payload = escrituras('usuarios')[0].payload;
    for (const col of ['plan', 'estado_pago', 'tipo_plan', 'fecha_pago', 'fecha_vencimiento',
      'premium_desde', 'premium_vence', 'pago_pendiente', 'esperando_comprobante', 'trial_estado']) {
      expect(payload, 'falta ' + col).toHaveProperty(col);
    }
    expect(payload.estado_pago).toBe('pagado');
    expect(payload.tipo_plan).toBe('mensual');
  });

  it('no acorta una suscripcion vigente: apila sobre premium_vence', async () => {
    router = () => ({ data: null, error: null });
    const { venceStr } = await comp({ ...USUARIO, premium_vence: '2099-01-15' });
    expect(venceStr > '2099-01-15', 'el comp acorto el vencimiento').toBe(true);
    expect(venceStr).toMatch(/^2099-02-/);
  });

  it('durante el trial apila sobre trial_vence (no cobra los dias que faltaban)', async () => {
    router = () => ({ data: null, error: null });
    const { venceStr } = await comp({ ...USUARIO, trial_estado: 'activo', trial_vence: '2099-03-10' });
    expect(venceStr).toMatch(/^2099-04-/);
  });

  it('no premia al referrer: un comp no puede encadenar meses gratis', async () => {
    router = () => ({ data: null, error: null });
    await comp(USUARIO);
    expect(refMock.procesarConversionProReferido).not.toHaveBeenCalled();
  });

  it('registra el pago en S/0: un comp no es caja del mes', async () => {
    router = () => ({ data: null, error: null });   // sin pendiente que reclamar -> inserta
    await comp(USUARIO);
    const ins = escrituras('pagos');
    expect(ins).toHaveLength(1);
    expect(ins[0].payload.monto).toBe(0);
    expect(ins[0].payload.aprobado_por).toBe('admin:comp');
  });

  it('el aviso al usuario sale igual por los dos canales (no se perdio al sacarlo de la ruta)', async () => {
    router = () => ({ data: null, error: null });
    await comp(USUARIO);
    expect(waMock.enviarWhatsapp).toHaveBeenCalledTimes(1);
    expect(notifDbMock.crearNotificacion).toHaveBeenCalledTimes(1);
  });

  it('no le confirma un cobro que no existio: sin "Pago confirmado" y sin precio', async () => {
    router = () => ({ data: null, error: null });
    const { mensaje } = await comp(USUARIO);
    expect(mensaje).not.toMatch(/pago confirmado/i);
    expect(mensaje, 'el comp no menciona precio').not.toMatch(/S\/\s*\d/);
    expect(mensaje).toMatch(/sin costo/i);
  });

  it('contraprueba: la conversion PAGADA si premia y se registra al precio de lista', async () => {
    router = () => ({ data: null, error: null });
    const { mensaje } = await pro.activarPro({ usuario: USUARIO, tipoPlan: 'mensual', aprobadoPor: 'admin:webapp', esConversionPagada: true });
    expect(refMock.procesarConversionProReferido).toHaveBeenCalledTimes(1);
    expect(escrituras('pagos')[0].payload.monto).toBe(PRO_PRECIOS.mensual);
    expect(mensaje).toMatch(/pago confirmado/i);
    expect(mensaje).toContain('S/' + PRO_PRECIOS.mensual);
  });
});

describe('registrarSolicitudPro', () => {
  it('no ofrece botones de Telegram cuando el insert del pago fallo (callback_data seria null)', async () => {
    process.env.TELEGRAM_ADMIN_CHAT_ID = '123';
    router = (q) => (q.table === 'pagos' && q.op === 'insert') ? FALLO : {};
    const { pagoId } = await pro.registrarSolicitudPro({ usuario: USUARIO, monto: 10, montoDetectado: 10, tipoPlan: 'mensual', comprobanteBuffer: Buffer.from('x'), mimeType: 'image/jpeg', origen: 'whatsapp' });
    expect(pagoId).toBeNull();
    expect(tgMock.enviarTelegramFotoConBotones).not.toHaveBeenCalled();
    expect(notifyMock.notificarAdmin).toHaveBeenCalled();
    expect(notifyMock.notificarAdmin.mock.calls[0][0]).toContain('/pago ');
  });

  it('ofrece los botones cuando el insert dio un pagoId', async () => {
    process.env.TELEGRAM_ADMIN_CHAT_ID = '123';
    router = (q) => (q.table === 'pagos' && q.op === 'insert') ? { data: { id: 'pago-9' } } : {};
    const { pagoId } = await pro.registrarSolicitudPro({ usuario: USUARIO, monto: 10, montoDetectado: 10, tipoPlan: 'mensual', comprobanteBuffer: Buffer.from('x'), mimeType: 'image/jpeg', origen: 'whatsapp' });
    expect(pagoId).toBe('pago-9');
    expect(tgMock.enviarTelegramFotoConBotones).toHaveBeenCalledTimes(1);
    expect(notifyMock.notificarAdmin).not.toHaveBeenCalled();
  });
});

describe('solicitarComprobante', () => {
  it('loguea cuando el flag no se pudo setear (la proxima captura seria un gasto)', async () => {
    router = () => FALLO;
    await pro.solicitarComprobante('u-1');
    expect(logMock.error).toHaveBeenCalled();
  });
});

// Guard estatico, hermano del de tests/notificaciones-duales.test.js.
//
// El modo de falla que previene es el que acaba de costar caro: una ruta que "activa Pro" con
// su propio UPDATE. Empieza identica a activarPro y se queda atras en cada columna que se
// agrega despues (trial_estado, esperando_comprobante, el desatasco del onboarding_paso 2) y en
// cada regla que se agrega despues (no acortar una suscripcion vigente). No falla en produccion:
// el usuario queda premium, el admin ve exito, y el agujero aparece semanas mas tarde en el cron
// de vencimiento o en las metricas de MRR.
//
// Los tres escritores declarados NO son tres formas de activar Pro: son tres eventos distintos.
// Solo el primero es una activacion por aprobacion.
describe('la activacion de Pro tiene un solo dueno', () => {
  const ESCRITORES = new Map([
    ['lib/pro-payment.js', 'activarPro: la activacion por aprobacion (fuente unica de los 4 canales)'],
    ['lib/trial.js', 'el alta del trial de 14 dias, que no pasa por ninguna aprobacion'],
    ['services/referrals.js', 'el premio al referrer, que NO re-entra a activarPro a proposito (anti-cadena)'],
  ]);
  const ACTIVA_PLAN = /plan:\s*['"]premium['"]/;
  const DIRS = ['routes', 'handlers', 'services', 'lib', 'cron'];

  const jsDe = (dir) => readdirSync(dir).flatMap((n) => {
    const full = path.join(dir, n);
    return statSync(full).isDirectory() ? jsDe(full) : (full.endsWith('.js') ? [full] : []);
  });
  const FUENTES = DIRS
    .map((d) => path.join(projectRoot, d))
    .filter(existsSync)
    .flatMap(jsDe)
    .map((full) => ({ rel: path.relative(projectRoot, full).replace(/\\/g, '/'), src: readFileSync(full, 'utf-8') }));

  it('el barrido ve el backend y ve la escritura real (si no, lo de abajo miente)', () => {
    expect(FUENTES.length).toBeGreaterThan(40);
    const conEscritura = FUENTES.filter((f) => ACTIVA_PLAN.test(f.src)).map((f) => f.rel);
    expect(conEscritura).toContain('lib/pro-payment.js');
  });

  it('nadie fuera de los declarados escribe plan premium a mano', () => {
    const intrusos = FUENTES
      .filter((f) => ACTIVA_PLAN.test(f.src))
      .map((f) => f.rel)
      .filter((rel) => !ESCRITORES.has(rel));
    // Si esto se pone rojo: no subas el numero, llama a activarPro. POST /admin/activar y el
    // comando /activar de WhatsApp son comps y pasan `esConversionPagada: false`.
    expect(intrusos).toEqual([]);
  });

  it('los comps del panel y de WhatsApp entran por activarPro', () => {
    for (const rel of ['routes/admin.js', 'handlers/admin-commands.js']) {
      const f = FUENTES.find((x) => x.rel === rel);
      expect(f, rel + ' no entro al barrido').toBeDefined();
      expect(f.src, rel + ' dejo de delegar en activarPro').toMatch(/activarPro\(/);
      expect(f.src, rel + ' no declara esConversionPagada en el comp').toMatch(/esConversionPagada:\s*false/);
    }
  });
});

/**
 * ══ 9A-bis · pagos y plan ═════════════════════════════════════════════════════════════════
 *
 * Los tres sitios de `lib/pro-payment.js` que loguean y siguen ante el error de una escritura,
 * más la lectura muda del OTRO canal admin (`routes/admin.js`). Son la misma clase que 9A —el
 * error de supabase-js descartado— una llamada más abajo, pero el síntoma no es un mensaje: es
 * un estado que nadie puede deshacer y una caja que subcuenta sola.
 */

/**
 * **Un almacén de filas de verdad, y no un `router` que devuelve una fila fija.**
 *
 * El caso que importa acá no se prueba con un mensaje: se prueba RE-LEYENDO la fila y volviendo
 * a correr el claim sobre el mismo estado. Con un stub de una sola fila, un WHERE que falta —o
 * un flag que quedó en true— se ve exactamente igual que el camino sano.
 *
 * **Límites declarados**, para que nadie lea de acá una garantía que no da:
 *  · Sólo se modelan `eq`, `is` y la forma de `or` que usa este archivo
 *    (`col.is.false,col.is.null`). Cualquier otro operador se ignora, o sea que NO filtra.
 *  · Una escritura que falla no toca las filas, que es lo que hace Postgres y lo que este test
 *    necesita para poder afirmar "quedó como estaba".
 *  · Los datos vuelven sólo si la escritura pidió RETURNING (`.select()`): sin eso, quitarle el
 *    `.select('id')` al código no cambiaría nada y la mutación sobreviviría.
 */
function almacen(tablas, fallos = {}) {
  const db = {};
  /**
   * **El WHERE, expuesto — la pieza que le faltaba a este mock y su hermano ya tenía.**
   *
   * `escrituras()` dice "hubo un update sobre `usuarios`", nunca "con este WHERE". Medido por
   * la revisión adversarial: quitarle el `.eq('id', usuario.id)` al UPDATE del rechazo deja un
   * `UPDATE usuarios SET pago_pendiente=false, estado_pago=null` **sin WHERE** —un rechazo pisa
   * a TODOS los usuarios— y los 2024 tests seguían verdes. Lo mismo con `.eq('id', pagoId)`
   * sobre `pagos`, que marcaría la tabla entera como rechazada.
   *
   * `escrituras-de-plata.test.js` creció su `filtros()` exactamente por esto ("quitarle
   * CUALQUIERA de sus filtros a un DELETE destructivo dejaba la suite verde"). Acá los UPDATE
   * son igual de destructivos y el accesor no existía: la lección estaba escrita en el archivo
   * de al lado y no se había transferido.
   */
  const filtrosDe = (tabla, op, n = 0) => {
    const q = ops.filter((o) => o.table === tabla && o.op === op)[n];
    return q ? q.methods.filter(([m]) => m === 'eq' || m === 'is').map(([, ...a]) => a) : null;
  };
  // `sanar()` levanta el fallo inyectado dejando las filas como quedaron. Es lo que hace la
  // realidad —el hipo de red pasa, el flag sigue trabado— y es lo que permite correr el claim
  // DESPUÉS sobre una DB sana: sin esto el claim fallaría por el fallo inyectado y el test
  // estaría midiendo la inyección en vez del estado. Un negativo verde por otra condición.
  const sanar = () => { for (const k of Object.keys(fallos)) delete fallos[k]; };
  for (const [t, filas] of Object.entries(tablas)) db[t] = filas.map((f) => ({ ...f }));

  const orCumple = (expr) => (fila) => String(expr).split(',').some((term) => {
    const [col, op, val] = term.split('.');
    if (op !== 'is') return false;
    if (val === 'null') return fila[col] === null || fila[col] === undefined;
    if (val === 'false') return fila[col] === false;
    if (val === 'true') return fila[col] === true;
    return false;
  });

  const cumple = (metodos) => (fila) => metodos.every(([m, ...a]) => {
    if (m === 'eq' || m === 'is') return fila[a[0]] === a[1];
    if (m === 'or') return orCumple(a[0])(fila);
    return true; // order/limit/… no filtran
  });

  const router = (q) => {
    if (fallos[q.table + ':' + q.op]) return { data: null, error: { message: fallos[q.table + ':' + q.op] } };
    const filas = db[q.table] || (db[q.table] = []);
    const match = filas.filter(cumple(q.methods));
    let data;
    if (q.op === 'insert') {
      const nuevas = (Array.isArray(q.payload) ? q.payload : [q.payload]).map((f) => ({ ...f }));
      filas.push(...nuevas);
      data = q.returning ? nuevas : null;
    } else if (q.op === 'update') {
      match.forEach((f) => Object.assign(f, q.payload));
      data = q.returning ? match : null;
    } else {
      data = match;
    }
    if (q.single) return { data: (data && data[0]) || null, error: null };
    return { data, error: null };
  };
  return { db, router, sanar, filtros: filtrosDe };
}

describe('9A-bis · rechazarSolicitudPro: el claim que se pierde para siempre', () => {
  const TRABABLE = () => ({ id: 'u-1', whatsapp: '51999888777', nombre: 'Favio', pago_pendiente: true, estado_pago: 'pendiente', esperando_comprobante: false });

  it('si no se puede limpiar pago_pendiente: la fila queda trabada Y el claim ya no se gana', async () => {
    const a = almacen({ usuarios: [TRABABLE()], pagos: [{ id: 'p-1', estado: 'pendiente', usuario_id: 'u-1' }] },
      { 'usuarios:update': 'db caída' });
    router = a.router;

    const r = await pro.rechazarSolicitudPro({ pagoId: 'p-1', usuario: { id: 'u-1', whatsapp: '51999888777' }, motivo: 'Ilegible' });

    // 1) se INTENTÓ limpiar — si no, el rojo de abajo vendría de un camino que ni corrió
    expect(escrituras('usuarios').some((o) => o.payload && o.payload.pago_pendiente === false), 'nunca intentó limpiar el flag').toBe(true);
    // 2) el estado, releído de la fila: no un mensaje
    expect(a.db.usuarios[0].pago_pendiente).toBe(true);
    // 3) y esto es lo que lo vuelve sin salida: con la DB YA SANA, el claim de la próxima
    //    captura sigue sin ganarse —pide `pago_pendiente is false|null`— y no se va a ganar
    //    nunca. El usuario reenvía y WhatsApp le contesta "ya tenemos tu comprobante en
    //    verificación" hasta el fin de los tiempos. Sanar primero es lo que separa "el claim se
    //    perdió" de "el claim no se pudo ni intentar".
    a.sanar();
    await expect(pro.reclamarSolicitudPro('u-1')).resolves.toBe(false);
    // 4) la única salida es manual, así que alguien tiene que enterarse
    expect(notifyMock.notificarAdmin).toHaveBeenCalled();

    expect(String(notifyMock.notificarAdmin.mock.calls[0][0])).toMatch(/pago_pendiente/i);
    // el log también: es el único rastro que queda si el aviso no llega, y borrarlo sobrevivía
    expect(logMock.error.mock.calls.some((c) => /sin poder volver a pagar/i.test(String(c[1])))).toBe(true);
    // 5) y el canal admin recibe el estado, no un "listo"
    expect(r).toEqual({ claimLimpio: false });
  });

  it('si no se puede marcar el pago rechazado, eso queda escrito', async () => {
    // La guarda de la PRIMERA escritura de la función (la de `pagos`), que no tenía aserción:
    // neutralizarla sobrevivía. Si esa fila sigue `pendiente` se puede aprobar después de
    // haberle dicho al usuario que su pago no era válido — lo dice su propio comentario.
    const a = almacen({ usuarios: [TRABABLE()], pagos: [{ id: 'p-1', estado: 'pendiente' }] }, { 'pagos:update': 'db caída' });
    router = a.router;
    await pro.rechazarSolicitudPro({ pagoId: 'p-1', usuario: { id: 'u-1', whatsapp: '51999888777' }, motivo: 'Ilegible' });
    expect(logMock.error.mock.calls.some((c) => /marcar el pago como rechazado/i.test(String(c[1])))).toBe(true);
    // y NO corta: limpiar el claim es más importante que la fila de `pagos`
    expect(a.db.usuarios[0].pago_pendiente).toBe(false);
  });

  it('si el aviso al admin TAMPOCO sale, eso queda escrito', async () => {
    // Al usuario ya se le dijo "ya avisamos al equipo, no hace falta que hagas nada", y lo que
    // produce este camino —una caída— es lo mismo que puede tumbar el aviso: el canal de
    // respaldo del admin usa el mismo token de Telegram. Esta línea es lo único que impide que
    // esa frase sea falsa sin dejar rastro. Descartar el booleano de `notificarAdmin` sobrevivía.
    const a = almacen({ usuarios: [TRABABLE()], pagos: [{ id: 'p-1', estado: 'pendiente' }] }, { 'usuarios:update': 'db caída' });
    router = a.router;
    notifyMock.notificarAdmin.mockResolvedValueOnce(false);
    await pro.rechazarSolicitudPro({ pagoId: 'p-1', usuario: { id: 'u-1', whatsapp: '51999888777' }, motivo: 'Ilegible' });
    expect(logMock.error.mock.calls.some((c) => /NO salió por ningún canal/i.test(String(c[1])))).toBe(true);
  });

  it('el mensaje al usuario NO lo manda por un camino cerrado', async () => {
    const a = almacen({ usuarios: [TRABABLE()], pagos: [{ id: 'p-1', estado: 'pendiente' }] }, { 'usuarios:update': 'db caída' });
    router = a.router;
    await pro.rechazarSolicitudPro({ pagoId: 'p-1', usuario: { id: 'u-1', whatsapp: '51999888777' }, motivo: 'Ilegible' });
    const texto = waMock.enviarWhatsapp.mock.calls.map((c) => JSON.stringify(c)).join(' ');
    // "reenvíanos la captura correcta" describe algo que con el claim trabado no existe:
    // es la confirmación falsa de 9A con otra ropa.
    expect(texto).not.toMatch(/reenvíanos la captura/i);
    expect(texto).toMatch(/no vas a poder reenviar/i);
  });

  it('control: con la escritura sana, la fila queda libre y el claim se vuelve a ganar', async () => {
    const a = almacen({ usuarios: [TRABABLE()], pagos: [{ id: 'p-1', estado: 'pendiente' }] });
    router = a.router;
    const r = await pro.rechazarSolicitudPro({ pagoId: 'p-1', usuario: { id: 'u-1', whatsapp: '51999888777' }, motivo: 'Ilegible' });
    // **Los dos WHERE, afirmados.** Sin esto, el UPDATE de `usuarios` sin `.eq('id', …)` pisa a
    // todos los usuarios y el de `pagos` marca la tabla entera como rechazada, con la suite en
    // verde: `escrituras()` ve que hubo un update, nunca sobre qué.
    expect(a.filtros('usuarios', 'update'), 'el UPDATE de usuarios perdió su WHERE').toEqual([['id', 'u-1']]);
    expect(a.filtros('pagos', 'update'), 'el UPDATE de pagos perdió su WHERE').toEqual([['id', 'p-1']]);
    expect(a.db.usuarios[0].pago_pendiente).toBe(false);
    await expect(pro.reclamarSolicitudPro('u-1')).resolves.toBe(true);
    expect(notifyMock.notificarAdmin).not.toHaveBeenCalled();
    expect(r).toEqual({ claimLimpio: true });
    // **Y NO sale el diagnostico de 0 filas.** Sin esta linea, quitarle el `.select('id')` al
    // codigo dejaba la suite entera en verde: `filasLimpias` seria `null` en TODO rechazo sano,
    // esa rama dispararia siempre, y como ahi lo unico que pasa es un `log.warn` nada mas
    // cambiaba. Medido por la revision adversarial: 785 tests verdes con la mutacion puesta.
    // Es la misma forma que salva a la compensacion de `restaurar_eliminado`, cuyo control
    // afirma que NINGUNO de los dos diagnosticos salio.
    expect(logMock.warn.mock.calls.some((c) => /no afectó ninguna fila/i.test(String(c[1]))), 'la guarda de 0 filas disparó sobre una escritura que SÍ entró').toBe(false);
    const texto = waMock.enviarWhatsapp.mock.calls.map((c) => JSON.stringify(c)).join(' ');
    expect(texto).toMatch(/reenvíanos la captura/i);
  });

  it('si la escritura RECHAZA en vez de devolver error, tambien cuenta como trabado', async () => {
    // La rama del `catch`, que no tenia caso. postgrest-js no produce este rechazo (convierte
    // el fallo de fetch en `error`), asi que solo se puede ejercitar fabricandolo — igual que
    // el `lanza` del harness de transacciones. Sin esto, `claimLimpio = false` y el aviso al
    // admin del catch eran codigo sin medir.
    const a = almacen({ usuarios: [TRABABLE()], pagos: [{ id: 'p-1', estado: 'pendiente' }] });
    router = (q) => {
      if (q.table === 'usuarios' && q.op === 'update') throw new Error('conexión cortada');
      return a.router(q);
    };
    const r = await pro.rechazarSolicitudPro({ pagoId: 'p-1', usuario: { id: 'u-1', whatsapp: '51999888777' }, motivo: 'Ilegible' });
    expect(r).toEqual({ claimLimpio: false });
    expect(notifyMock.notificarAdmin).toHaveBeenCalled();
    // y el usuario NO recibe la instruccion de reenviar por un camino cerrado
    const texto = waMock.enviarWhatsapp.mock.calls.map((c) => JSON.stringify(c)).join(' ');
    expect(texto).not.toMatch(/reenvíanos la captura/i);
  });

  it('0 filas NO es el estado trabado: se anota, no se despierta a nadie', async () => {
    // El WHERE es sólo por `id`, así que cero filas significa que el usuario ya no está. Sin
    // fila no hay flag que trabe nada: avisar mandaría a buscar un `pago_pendiente` inexistente.
    // La distinción sólo existe gracias al `.select('id')`; sin él los dos casos llegan con
    // `error: null` y son literalmente el mismo camino.
    const a = almacen({ usuarios: [], pagos: [{ id: 'p-1', estado: 'pendiente' }] });
    router = a.router;
    const r = await pro.rechazarSolicitudPro({ pagoId: 'p-1', usuario: { id: 'u-1', whatsapp: '51999888777' }, motivo: 'Ilegible' });
    expect(escrituras('usuarios').length, 'ni siquiera intentó el update').toBe(1);
    expect(notifyMock.notificarAdmin).not.toHaveBeenCalled();
    expect(r).toEqual({ claimLimpio: true });
    expect(logMock.warn.mock.calls.some((c) => /no afectó ninguna fila/i.test(String(c[1])))).toBe(true);
  });
});

describe('9A-bis · registrarPagoAprobado: la fila incompleta que subcuenta el MRR', () => {
  const PERIODO = { tipoPlan: 'mensual', premiumDesde: '2026-08-24', premiumVence: '2026-09-24' };

  it('fila ya reclamada: si el update falla, el admin se entera (Pro quedó activo igual)', async () => {
    // No puede cortar —`activarPro` ya escribió el plan y el usuario ya leyó "¡Pago
    // confirmado!"—, así que el único desenlace útil es que alguien complete la fila. Sin el
    // aviso, `cajaDelMes` suma menos de lo cobrado y nadie vuelve a mirar esa fila.
    router = (q) => (q.table === 'pagos' && q.op === 'update') ? FALLO : { data: null, error: null };
    await pro.registrarPagoAprobado('u-1', { ...PERIODO, monto: 10, pagoId: 'p-1' });
    expect(notifyMock.notificarAdmin).toHaveBeenCalled();
    expect(String(notifyMock.notificarAdmin.mock.calls[0][0])).toMatch(/p-1/);
    expect(logMock.error).toHaveBeenCalled();
  });

  it('camino legacy: si el pendiente no se marca aprobado, se avisa que sigue PENDIENTE', async () => {
    // Distinto del anterior y por eso otro texto: esta fila no fue reclamada atómicamente, así
    // que sigue aprobable desde el panel y un segundo Aprobar regala otro mes.
    router = (q) => {
      if (q.table === 'pagos' && q.op === 'select') return { data: { id: 'p-9' }, error: null };
      if (q.table === 'pagos' && q.op === 'update') return FALLO;
      return { data: null, error: null };
    };
    await pro.registrarPagoAprobado('u-1', PERIODO);
    expect(notifyMock.notificarAdmin).toHaveBeenCalled();
    expect(String(notifyMock.notificarAdmin.mock.calls[0][0])).toMatch(/pendiente/i);
  });

  it('sin pendiente: si el insert falla, no queda constancia del cobro y se avisa', async () => {
    router = (q) => {
      if (q.table === 'pagos' && q.op === 'select') return { data: null, error: null };
      if (q.table === 'pagos' && q.op === 'insert') return FALLO;
      return { data: null, error: null };
    };
    await pro.registrarPagoAprobado('u-1', PERIODO);
    expect(notifyMock.notificarAdmin).toHaveBeenCalled();
    expect(String(notifyMock.notificarAdmin.mock.calls[0][0])).toMatch(/insert/i);
  });

  it('si el aviso al admin RECHAZA, no rompe la aprobación (best-effort de verdad)', async () => {
    // El try/catch de `avisarAdminPagos` no tenía caso: `notificarAdmin` no rechaza en los
    // mocks, así que quitárselo sobrevivía. Y en producción propagar acá es peor que el bug —
    // esta función corre DESPUÉS de que Pro se activó, así que tirar deja al admin leyendo
    // "no se activó" sobre un usuario que sí tiene Pro.
    router = (q) => (q.table === 'pagos' && q.op === 'update') ? FALLO : { data: null, error: null };
    notifyMock.notificarAdmin.mockRejectedValueOnce(new Error('telegram caído'));
    await expect(pro.registrarPagoAprobado('u-1', { tipoPlan: 'mensual', premiumDesde: '2026-08-24', premiumVence: '2026-09-24', monto: 10, pagoId: 'p-1' })).resolves.toBeUndefined();
    expect(notifyMock.notificarAdmin).toHaveBeenCalled();
  });

  it('control: con las escrituras sanas no se despierta a nadie', async () => {
    router = (q) => (q.table === 'pagos' && q.op === 'select') ? { data: { id: 'p-9' }, error: null } : { data: null, error: null };
    await pro.registrarPagoAprobado('u-1', PERIODO);
    expect(notifyMock.notificarAdmin).not.toHaveBeenCalled();
  });
});

/**
 * `routes/admin.js` — el OTRO canal admin. Acá el claim viene DESPUÉS de la lectura, así que un
 * fallo no traba el pago: lo que estaba roto es el diagnóstico. El admin leía "Usuario no
 * encontrado" sobre una lectura que nunca respondió y se iba a buscar una fila que sí existe.
 *
 * El caso de al lado es el que obliga a `maybeSingle`: con `.single()`, postgrest devuelve
 * `PGRST116` en `error` cuando no hay fila, o sea que leer el error a secas convertiría el 404
 * legítimo en un 500. Los dos casos juntos son la prueba; uno solo pasa por la razón equivocada.
 */
describe('9A-bis · POST /admin/aprobar-pago distingue la lectura caída del usuario ausente', () => {
  process.env.ADMIN_KEY = 'clave-de-prueba-1234';
  const adminRouter = require('../../routes/admin');
  const capa = adminRouter.stack.find((l) => l.route && l.route.path === '/aprobar-pago');
  const handler = capa && capa.route.stack[capa.route.stack.length - 1].handle;

  const correrRuta = async (body) => {
    const salida = {};
    const req = {
      body,
      get: (h) => (h.toLowerCase() === 'x-admin-key' ? process.env.ADMIN_KEY : ''),
    };
    const res = {
      status(c) { salida.status = c; return res; },
      json(j) { salida.body = j; return res; },
    };
    await handler(req, res);
    return salida;
  };

  it('el barrido encontró la ruta (si no, todo lo de abajo pasa sin ejercitar nada)', () => {
    expect(handler, 'la ruta /aprobar-pago cambió de nombre o de forma').toBeTypeOf('function');
  });

  it('la lectura CAE → 500, y no "Usuario no encontrado"', async () => {
    router = (q) => (q.table === 'usuarios' && q.op === 'select') ? FALLO : { data: null, error: null };
    const r = await correrRuta({ usuario_id: 'u-1', tipo_plan: 'mensual' });
    expect(r.status).toBe(500);
    expect(String(r.body.msg)).not.toMatch(/no encontrado/i);
    expect(logMock.error).toHaveBeenCalled();
  });

  it('la lectura ANDA y no hay fila → 404 "Usuario no encontrado" (control)', async () => {
    router = () => ({ data: null, error: null });
    const r = await correrRuta({ usuario_id: 'u-404', tipo_plan: 'mensual' });
    expect(r.status).toBe(404);
    expect(String(r.body.msg)).toMatch(/no encontrado/i);
  });

  it('ninguno de los dos casos llega a reclamar el pago', async () => {
    // Si el claim corriera igual, el pago quedaría aprobado sobre un usuario que no se pudo
    // leer — que es el orden que 9A invirtió en el canal de Telegram.
    router = (q) => (q.table === 'usuarios' && q.op === 'select') ? FALLO : { data: null, error: null };
    await correrRuta({ usuario_id: 'u-1', tipo_plan: 'mensual' });
    expect(escrituras('pagos').length).toBe(0);
  });
});
