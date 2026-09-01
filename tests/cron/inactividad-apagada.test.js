import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { createRequire } from 'module';
import path from 'path';

/**
 * El nudge de inactividad está APAGADO desde el 01-sep-2026, y esto es lo que impide que
 * vuelva sin que nadie lo decida.
 *
 * ─── Por qué hace falta un guard para un borrado ────────────────────────────────────────
 *
 * Borrar código no deja rastro que se pueda leer después. El aviso vivía en
 * `checkRecordatorioDiario` (hoy `checkUpsellPro`) y su copy es de los que se re-escriben
 * solos: "hace N días que no registras nada" es lo primero que a cualquiera se le ocurre
 * poner en un cron de retención. Sin un caso que lo prohíba, el próximo que lo escriba no va
 * a encontrar ni una línea que le diga que ya se probó y con qué resultado.
 *
 * Los números que sostienen la decisión, medidos el 01-sep-2026 contra producción:
 * 190 intentos por WhatsApp en 30 días para **4 entregados y 3 leídos**; 94 filas in-app en
 * 14 días con **2 leídas**; y `conversion_within_24h` en **0 de 190**. No es un problema de
 * cadencia: el destinatario está definido como el que no vuelve, así que ningún canal de
 * "empuje a la app" lo alcanza. El reemplazo es `checkRecordatorioInactividadSemanal`, por
 * correo y a UNA cohorte.
 *
 * ─── Por qué es de COMPORTAMIENTO y no un grep ──────────────────────────────────────────
 *
 * Un guard estático sobre la cadena `inactivity` se pondría rojo por su propia documentación
 * (el docblock de `checkUpsellPro` la cita para explicar el apagado), y es la clase
 * `guard-que-se-mide-contra-su-documentacion`, que en este repo ya lleva cuatro. Así que acá
 * se **corre** el cron: se arma el destinatario que ANTES lo disparaba —Pro, alta cerrada,
 * recordatorios prendidos, diez días sin anotar, sin empujes recientes— se barre el día
 * entero hora por hora, y se afirma que nada le manda ese aviso.
 *
 * El barrido sale de `module.exports` de `cron/checks.js`, no de una lista escrita acá: un
 * cron nuevo queda cubierto sin que nadie se acuerde de agregarlo.
 *
 * ─── Lo que este archivo NO prohíbe, y es a propósito ───────────────────────────────────
 *
 * `services/survey-triggers.js` tiene copy casi idéntico —`reminder_d30` se titula "Hace dos
 * semanas que no registras nada" y `wake_up_inactive` "Hace tiempo que no registras nada"— y
 * **se queda**. No es el mismo aviso: bifurca por `txTotal === 0`, o sea que distingue al que
 * nunca empezó del que dejó de anotar, que es justo la distinción que el apagado vino a
 * respetar. Por eso las aserciones miran el `tipo` y el título CON NÚMERO DE DÍAS (que era la
 * forma que apilaba una fila nueva por disparo), y no la frase suelta.
 */

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(
  path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]):/, '$1:'),
  '../..',
);

/** Filas por tabla. Lo que no esté acá devuelve []. */
let tablas = {};
/** Todo INSERT, para poder afirmar que `survey_events` no recibe la marca del aviso muerto. */
let inserts = [];

const notificar = vi.fn().mockResolvedValue({ wa: { ok: true }, inApp: true, email: { ok: false } });

function makeChain(table) {
  const filtros = [];
  let esConteo = false;
  let orden = null;
  let tope = null;
  const chain = {};
  for (const m of ['ilike']) chain[m] = () => chain;
  chain.order = (col, opts) => { orden = { col, asc: !opts || opts.ascending !== false }; return chain; };
  chain.limit = (n) => { tope = n; return chain; };
  const rango = (cmp) => (col, val) => {
    filtros.push((f) => f[col] !== null && f[col] !== undefined && cmp(f[col], val));
    return chain;
  };
  chain.gt = rango((a, b) => a > b);
  chain.gte = rango((a, b) => a >= b);
  chain.lt = rango((a, b) => a < b);
  chain.lte = rango((a, b) => a <= b);
  const noEsNull = (f, col) => f[col] !== null && f[col] !== undefined;
  chain.not = (col, op, val) => {
    if (op === 'is' && val === null) filtros.push((f) => noEsNull(f, col));
    else if (op === 'eq') filtros.push((f) => noEsNull(f, col) && f[col] !== val);
    return chain;
  };
  chain.select = (_cols, opts) => { if (opts && opts.count) esConteo = true; return chain; };
  chain.eq = (col, val) => { filtros.push((f) => f[col] === val); return chain; };
  chain.neq = (col, val) => { filtros.push((f) => noEsNull(f, col) && f[col] !== val); return chain; };
  chain.in = (col, arr) => { filtros.push((f) => arr.includes(f[col])); return chain; };
  chain.is = (col, val) => {
    if (val === null) filtros.push((f) => f[col] === null || f[col] === undefined);
    return chain;
  };
  chain.or = (expr) => {
    filtros.push((f) => String(expr).split(',').some((cond) => {
      const [col, op, val] = cond.split('.');
      if (op === 'is' && val === 'null') return f[col] === null || f[col] === undefined;
      if (op === 'eq') return String(f[col]) === val;
      if (op === 'neq') return f[col] !== undefined && f[col] !== null && String(f[col]) !== val;
      return false;
    }));
    return chain;
  };
  const resolver = () => {
    let filas = (tablas[table] || []).filter((f) => filtros.every((p) => p(f)));
    if (orden) {
      const { col, asc } = orden;
      filas = [...filas].sort((a, b) => (a[col] > b[col] ? 1 : a[col] < b[col] ? -1 : 0) * (asc ? 1 : -1));
    }
    if (tope !== null) filas = filas.slice(0, tope);
    return esConteo ? { data: null, count: filas.length, error: null } : { data: filas, count: filas.length, error: null };
  };
  chain.single = () => Promise.resolve({ data: (resolver().data || [])[0] || null, error: null });
  chain.maybeSingle = chain.single;
  chain.then = (resolve) => resolve(resolver());
  return chain;
}

const dbMock = {
  supabase: {
    from: vi.fn((t) => ({
      ...makeChain(t),
      insert: (patch) => { inserts.push({ tabla: t, patch }); return makeChain(t); },
      update: () => makeChain(t),
      delete: () => makeChain(t),
    })),
    storage: { from: () => ({ createSignedUrl: async () => ({ data: null, error: null }) }) },
  },
};
const logMock = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn() };

const serviciosMock = [
  ['lib/db.js', dbMock],
  ['lib/logger.js', logMock],
  ['lib/whatsapp.js', { enviarWhatsapp: vi.fn().mockResolvedValue({ ok: true }), META_ERR_FUERA_VENTANA: 131047 }],
  ['lib/notifications-db.js', { crearNotificacion: vi.fn().mockResolvedValue(true) }],
  ['lib/analytics.js', { capture: vi.fn() }],
  ['lib/admin-notify.js', { notificarAdmin: vi.fn() }],
  ['lib/pro-payment.js', { solicitarComprobante: vi.fn(), esperaComprobante: vi.fn() }],
  ['gmail.js', { revocarAccesoGmail: vi.fn().mockResolvedValue({ revocadas: 0 }) }],
  ['services/summaries.js', {
    generarResumenMensual: vi.fn().mockResolvedValue('resumen'),
    generarResumenSemanal: vi.fn().mockResolvedValue('resumen'),
    generarResumenDiario: vi.fn().mockResolvedValue('resumen del dia'),
  }],
  ['services/recommendations.js', { verificarAlertasProactivas: vi.fn().mockResolvedValue('alerta') }],
  ['services/debts.js', {
    obtenerDeudasProximasVencer: vi.fn().mockResolvedValue([]),
    obtenerDeudasParaResumenSemanal: vi.fn().mockResolvedValue([]),
  }],
  ['services/spending-alerts.js', {
    generarAlertasFugas: vi.fn().mockResolvedValue([]),
    generarMensajeFugas: vi.fn().mockResolvedValue('fugas'),
    guardarAlertas: vi.fn(),
  }],
  ['services/neto-score.js', {
    upsertScore: vi.fn(),
    obtenerTendenciaScore: vi.fn().mockResolvedValue({ current: 70, diff: 2 }),
    scoreLabel: () => 'bien',
  }],
  ['services/metas.js', { calcularRitmoAhorro: () => ({ enRitmo: true, montoMensual: 100 }) }],
  ['services/shared-spaces.js', {
    obtenerBalanceEspacio: vi.fn().mockResolvedValue({ debts: [] }),
    ownerEsPro: vi.fn().mockResolvedValue(true),
  }],
  ['services/subscriptions/index.js', { detectarSuscripciones: vi.fn().mockResolvedValue({ suscripciones_detectadas: [] }) }],
];
for (const [rel, exports] of serviciosMock) {
  const p = require.resolve(path.join(projectRoot, rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}

// `notificarUsuario` se reemplaza preservando CANALES: los crons lo desestructuran al cargar.
// `services/survey-triggers.js` NO se stubea, al revés que en `lecturas-con-error.test.js`:
// es el productor que SE QUEDA, y correrlo de verdad es lo que demuestra que el guard sabe
// distinguirlo del que se apagó en vez de prohibir la frase.
const notifyPath = require.resolve(path.join(projectRoot, 'lib/notify-user.js'));
const notifyReal = require(notifyPath);
require.cache[notifyPath] = {
  id: notifyPath, filename: notifyPath, loaded: true,
  exports: { ...notifyReal, notificarUsuario: notificar },
};

const checks = require('../../cron/checks');

vi.useFakeTimers({ toFake: ['Date'] });
afterAll(() => { vi.useRealTimers(); });

const enLima = (iso) => new Date(iso + '-05:00');
const dosDigitos = (n) => String(n).padStart(2, '0');

/** Todos los crons exportados, derivados del módulo: uno nuevo entra solo. */
const CRONS = Object.entries(checks)
  .filter(([n, v]) => typeof v === 'function' && /^(check|limpiar)/.test(n))
  .map(([n]) => n);

/**
 * El destinatario que ANTES lo disparaba: Pro, alta cerrada, recordatorios prendidos, con
 * cuenta web (o sea con campana donde verlo) y **diez días sin anotar nada**. Es exactamente
 * la fila que a las 8pm producía "Hace 10 días que no registras nada".
 */
const INACTIVO = {
  id: 'u-inactivo', whatsapp: '51900000001', nombre: 'María Quispe',
  plan: 'premium', onboarding_completado: true, recordatorios_activos: true,
  supabase_auth_id: 'auth-1', manos_libres: false, historico_importado: true,
  cuenta_borrada_at: null, trial_estado: null, is_test_user: false,
  email: 'maria@example.com', created_at: '2026-06-01T00:00:00Z',
  premium_vence: '2027-01-01', estado_pago: 'pagado', activacion_nudge_at: null,
};

/** Corre TODOS los crons a esa hora de Lima, tragándose lo que escape del try/catch propio. */
async function barrer(horaIso) {
  vi.setSystemTime(enLima(horaIso));
  for (const nombre of CRONS) {
    try { await checks[nombre](); } catch { /* el guard mide avisos, no estabilidad */ }
  }
}

beforeEach(() => {
  tablas = {};
  inserts = [];
  vi.clearAllMocks();
  notificar.mockResolvedValue({ wa: { ok: true }, inApp: true, email: { ok: false } });
});

describe('el nudge de inactividad está apagado y no vuelve solo', () => {
  it('el barrido ve crons de verdad (si esta lista se vacía, todo lo de abajo pasa por nada)', () => {
    expect(CRONS.length).toBeGreaterThanOrEqual(20);
    expect(CRONS).toContain('checkUpsellPro');
    expect(CRONS).toContain('checkSurveyTriggers');
  });

  it('ningún cron le manda el aviso de inactividad al que dejó de anotar hace 10 días', async () => {
    tablas.usuarios = [INACTIVO];
    tablas.transacciones = [{ id: 't-1', usuario_id: 'u-inactivo', fecha: '2026-08-11', created_at: '2026-08-11T12:00:00Z' }];
    tablas.survey_events = [];
    tablas.notificaciones = [];

    // El día entero: el aviso salía a las 8pm, pero mover el gate horario es la forma más
    // barata de "arreglarlo" sin que un caso puntual se entere.
    for (let h = 0; h < 24; h++) await barrer('2026-08-21T' + dosDigitos(h) + ':05:00');

    const tipos = notificar.mock.calls.map((c) => c[0] && c[0].tipo);
    expect(tipos, 'volvió el aviso de inactividad por el chokepoint').not.toContain('inactivity');

    // Y la forma que APILABA: un título con el conteo de días adentro abría una fila nueva por
    // disparo en vez de actualizar la anterior. Se prohíbe la forma, no la frase — `reminder_d30`
    // ("Hace dos semanas…") y `wake_up_inactive` ("Hace tiempo…") se quedan y no llevan número.
    const conConteo = notificar.mock.calls
      .map((c) => (c[0] && c[0].titulo) || '')
      .filter((t) => /^Hace \d+ d[ií]as? que no registras nada$/.test(t));
    expect(conConteo, 'volvió el título que apila una fila por disparo').toEqual([]);

    // La marca de dedup del aviso muerto tampoco se escribe: si apareciera, el aviso salió por
    // algún camino que el chokepoint no ve.
    const eventos = inserts.filter((i) => i.tabla === 'survey_events').map((i) => i.patch && i.patch.event_type);
    expect(eventos, 'se escribió la marca de un aviso que ya no existe').not.toContain('inactivity_reminder');
  });

  it('CONTROL: el barrido SÍ alcanza a mandar avisos (si no, el caso de arriba no prueba nada)', async () => {
    // Mismo barrido, con el destinatario del upsell d28: Free y 29 días desde el alta. Sin
    // esta mitad, un mock roto o un gate horario mal puesto darían "no salió nada" y el caso
    // de arriba pasaría en verde sin haber ejercitado un solo cron.
    tablas.usuarios = [{
      ...INACTIVO, plan: 'free', premium_vence: null, estado_pago: null,
      created_at: enLima('2026-07-23T20:05:00').toISOString(),
    }];
    tablas.transacciones = [{ id: 't-1', usuario_id: 'u-inactivo', fecha: '2026-08-11', created_at: '2026-08-11T12:00:00Z' }];
    tablas.survey_events = [];
    tablas.notificaciones = [];

    for (let h = 0; h < 24; h++) await barrer('2026-08-21T' + dosDigitos(h) + ':05:00');

    const tipos = notificar.mock.calls.map((c) => c[0] && c[0].tipo);
    expect(tipos, 'el barrido no mandó NADA: el instrumento está roto, no limpio').toContain('pro_upsell_d28');
    expect(tipos, 'ni con el barrido vivo vuelve la inactividad').not.toContain('inactivity');
  });
});
