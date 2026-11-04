import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { createRequire } from 'module';
import path from 'path';
import { readdirSync, readFileSync, statSync } from 'node:fs';

/**
 * La prueba dura 7 días, y las que ya corrían terminan con sus 14 (04-nov-2026).
 *
 * El estudio de usuarios de ese día encontró que el grupo que más usa la prueba deja de escribir
 * cerca del día 8, y el muro llegaba el día 15: casi nadie veía el precio mientras todavía usaba
 * Neto. La decisión (`memory/reports/neto-plan-conversion-2026-11-04.md`) fue acortar la prueba a 7
 * días y sumar un aviso en el chat la víspera del cierre, con el precio y el link, a quien la está
 * usando. Este archivo fija las tres partes:
 *
 *   1. una prueba NUEVA vence a los 7 días;
 *   2. una prueba que arrancó con 14 conserva su `trial_vence`: nada lo recalcula desde
 *      `trial_inicio + TRIAL_DIAS`, ni el cron ni ningún otro archivo de runtime;
 *   3. el aviso de la víspera (`trial_d6`) sale solo con sus dos condiciones (3+ días con
 *      movimientos y la ventana de 24h de WhatsApp abierta), y el viejo "faltan 3 días" ya no.
 *
 * Se corre el cron de verdad con `notificarUsuario` mockeado y un doble de Supabase que FILTRA,
 * ordena y pagina: con una cadena en no-op, el aviso de la víspera y el downgrade leerían la misma
 * población y los negativos pasarían por accidente.
 */

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(
  path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]):/, '$1:'),
  '../..',
);

/** Filas por tabla. Lo que no esté acá devuelve []. */
let tablas = {};
/** Error inyectable por tabla, para las ramas de lectura caída. */
let errores = {};
/** Cada UPDATE con su payload, para afirmar qué se escribió. */
const updates = [];
const notificar = vi.fn();

function makeChain(table, op = 'select', payload = null) {
  const filtros = [];
  let conteo = null;   // null | 'exact' | 'head'
  let orden = null;
  let tope = null;
  let rango = null;
  const chain = {};
  chain.ilike = () => chain;
  chain.or = () => chain;
  const noEsNull = (f, col) => f[col] !== null && f[col] !== undefined;
  const cmp = (fn) => (col, val) => { filtros.push((f) => noEsNull(f, col) && fn(f[col], val)); return chain; };
  chain.gt = cmp((a, b) => a > b);
  chain.gte = cmp((a, b) => a >= b);
  chain.lt = cmp((a, b) => a < b);
  chain.lte = cmp((a, b) => a <= b);
  chain.eq = (col, val) => { filtros.push((f) => f[col] === val); return chain; };
  chain.neq = (col, val) => { filtros.push((f) => noEsNull(f, col) && f[col] !== val); return chain; };
  chain.in = (col, arr) => { filtros.push((f) => arr.includes(f[col])); return chain; };
  chain.is = (col, val) => {
    if (val === null) filtros.push((f) => f[col] === null || f[col] === undefined);
    return chain;
  };
  chain.not = (col, op2, val) => {
    if (op2 === 'is' && val === null) filtros.push((f) => noEsNull(f, col));
    return chain;
  };
  chain.order = (col, opts) => { orden = { col, asc: !(opts && opts.ascending === false) }; return chain; };
  chain.limit = (n) => { tope = n; return chain; };
  chain.range = (a, b) => { rango = [a, b]; return chain; };
  chain.select = (_cols, opts) => {
    if (opts && opts.count) conteo = opts.head ? 'head' : 'exact';
    return chain;
  };
  const resolver = () => {
    if (errores[table]) return { data: null, count: null, error: { message: 'lectura caída: ' + table } };
    let filas = (tablas[table] || []).filter((f) => filtros.every((p) => p(f)));
    if (op === 'update') {
      updates.push({ table, payload, filas: filas.map((f) => f.id) });
      for (const f of filas) Object.assign(f, payload);
    }
    const total = filas.length;
    if (orden) {
      const { col, asc } = orden;
      filas = [...filas].sort((a, b) => (a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : 0) * (asc ? 1 : -1));
    }
    if (rango) filas = filas.slice(rango[0], rango[1] + 1);
    if (tope != null) filas = filas.slice(0, tope);
    if (conteo === 'head') return { data: null, count: total, error: null };
    return { data: filas, count: conteo === 'exact' ? total : null, error: null };
  };
  chain.single = () => {
    const r = resolver();
    return Promise.resolve({ data: r.data ? r.data[0] || null : null, error: r.error });
  };
  chain.maybeSingle = chain.single;
  chain.then = (resolve) => resolve(resolver());
  return chain;
}

const dbMock = {
  supabase: {
    from: vi.fn((t) => ({
      ...makeChain(t),
      insert: () => makeChain(t, 'insert'),
      update: (payload) => makeChain(t, 'update', payload),
      delete: () => makeChain(t, 'delete'),
    })),
  },
};
const logMock = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn() };

for (const [rel, exports] of [
  ['lib/db.js', dbMock],
  ['lib/logger.js', logMock],
  ['lib/whatsapp.js', { enviarWhatsapp: vi.fn().mockResolvedValue({ ok: true }), META_ERR_FUERA_VENTANA: 131047 }],
  ['lib/notifications-db.js', { crearNotificacion: vi.fn().mockResolvedValue(true) }],
  ['lib/analytics.js', { capture: vi.fn() }],
  ['lib/admin-notify.js', { notificarAdmin: vi.fn() }],
  ['lib/pro-payment.js', { solicitarComprobante: vi.fn(), esperaComprobante: vi.fn() }],
  ['gmail.js', { revocarAccesoGmail: vi.fn().mockResolvedValue({ revocadas: 0 }) }],
  ['services/summaries.js', {
    generarResumenMensual: vi.fn(), generarResumenSemanal: vi.fn(), generarResumenDiario: vi.fn(),
  }],
  ['services/recommendations.js', { verificarAlertasProactivas: vi.fn() }],
  ['services/debts.js', {
    obtenerDeudasProximasVencer: vi.fn().mockResolvedValue([]),
    obtenerDeudasParaResumenSemanal: vi.fn().mockResolvedValue([]),
  }],
  ['services/spending-alerts.js', { generarAlertasFugas: vi.fn(), generarMensajeFugas: vi.fn(), guardarAlertas: vi.fn() }],
  ['services/neto-score.js', { upsertScore: vi.fn(), obtenerTendenciaScore: vi.fn(), scoreLabel: () => 'bien' }],
  ['services/metas.js', { calcularRitmoAhorro: () => ({ enRitmo: true, montoMensual: 100 }) }],
  ['services/shared-spaces.js', { obtenerBalanceEspacio: vi.fn(), ownerEsPro: vi.fn() }],
  ['services/subscriptions/index.js', { detectarSuscripciones: vi.fn() }],
  ['services/survey-triggers.js', { checkSurveyTriggers: vi.fn() }],
]) {
  const p = require.resolve(path.join(projectRoot, rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}

// `notificarUsuario` se reemplaza preservando `CANALES`: el cron lo desestructura al cargar.
const notifyPath = require.resolve(path.join(projectRoot, 'lib/notify-user.js'));
const notifyReal = require(notifyPath);
require.cache[notifyPath] = {
  id: notifyPath, filename: notifyPath, loaded: true,
  exports: { ...notifyReal, notificarUsuario: notificar },
};

const checks = require('../../cron/checks');
const trial = require('../../lib/trial');

vi.useFakeTimers({ toFake: ['Date'] });
afterAll(() => { vi.useRealTimers(); });

/** Martes 10-nov-2026 en Lima. La víspera es de quien vence el 11. */
const lima = (hhmm) => new Date('2026-11-10T' + hhmm + ':00-05:00');

const EN_PRUEBA = {
  trial_estado: 'activo', plan: 'premium', whatsapp: '51900000001', nombre: 'Ana Torres',
  recordatorios_activos: true, cuenta_borrada_at: null, is_test_user: false,
  estado_pago: null, premium_desde: null, premium_vence: null,
  supabase_auth_id: 'auth-x', email: 'ana@ejemplo.pe',
  // Prueba de 7 días que arrancó el miércoles 04-nov a las 10am Lima.
  trial_inicio: '2026-11-04T15:00:00+00:00', trial_vence: '2026-11-11',
};
const usuario = (id, extra) => ({ ...EN_PRUEBA, id, ...extra });

/** Transacciones en días DISTINTOS de Lima (17h UTC = mediodía Lima). */
const txEnDias = (uid, dias) => dias.map((d, i) => ({
  id: uid + '-tx' + i, usuario_id: uid, tipo: 'gasto', created_at: '2026-11-' + d + 'T17:00:00+00:00',
}));
/** El último mensaje ENTRANTE del usuario, a una hora UTC dada. */
const turno = (uid, isoUtc) => ({ id: uid + '-c', usuario_id: uid, rol: 'usuario', created_at: isoUtc });

const llamadas = () => notificar.mock.calls.map((c) => c[0]);
const llamadaDe = (id, tipo) => llamadas().find((a) => a && a.usuarioId === id && a.tipo === tipo);
const tiposDe = (id) => llamadas().filter((a) => a && a.usuarioId === id).map((a) => a.tipo);

beforeEach(() => {
  tablas = { notificaciones: [], transacciones: [], conversaciones: [] };
  errores = {};
  updates.length = 0;
  vi.clearAllMocks();
  notificar.mockResolvedValue({ wa: { ok: true }, inApp: true, email: { ok: true } });
  vi.setSystemTime(lima('10:00'));
});

describe('una prueba NUEVA dura 7 días', () => {
  it('TRIAL_DIAS es 7', () => {
    expect(trial.TRIAL_DIAS).toBe(7);
  });

  it('iniciarTrialSiCorresponde escribe trial_vence = hoy + 7', async () => {
    tablas.usuarios = [{ id: 'u-nuevo', plan: 'free', trial_estado: null }];

    const r = await trial.iniciarTrialSiCorresponde('u-nuevo');

    expect(r.iniciado).toBe(true);
    const upd = updates.find((u) => u.table === 'usuarios' && u.payload && u.payload.trial_estado === 'activo');
    expect(upd, 'no se hizo el UPDATE que arranca la prueba').toBeTruthy();
    expect(upd.payload.trial_vence).toBe('2026-11-17');
    expect(r.trialVence).toBe('2026-11-17');
  });

  it('a quien ya tiene una prueba de 14 en curso no se le vuelve a escribir trial_vence', async () => {
    tablas.usuarios = [usuario('u-viejo', { trial_inicio: '2026-10-31T15:00:00+00:00', trial_vence: '2026-11-14' })];

    const r = await trial.iniciarTrialSiCorresponde('u-viejo');

    expect(r.iniciado).toBe(false);
    expect(tablas.usuarios[0].trial_vence).toBe('2026-11-14');
  });
});

describe('una prueba de 14 que ya corría termina con sus 14', () => {
  it('a 4 días de su vencimiento (día 10 de 14) no baja al muro ni recibe aviso', async () => {
    tablas.usuarios = [usuario('u-viejo', { trial_inicio: '2026-10-31T15:00:00+00:00', trial_vence: '2026-11-14' })];
    tablas.transacciones = txEnDias('u-viejo', ['01', '03', '09']);
    tablas.conversaciones = [turno('u-viejo', '2026-11-10T13:00:00+00:00')];

    await checks.checkTrialExpiry();

    expect(tiposDe('u-viejo')).toEqual([]);
    expect(updates.filter((u) => u.table === 'usuarios')).toEqual([]);
    expect(tablas.usuarios[0].plan).toBe('premium');
  });

  it('el día 7 desde su primer gasto NO es su último día: el cierre lo decide trial_vence', async () => {
    // Arrancó el 03-nov con 14 días: hoy es su día 7. Con un cálculo desde trial_inicio + 7
    // recibiría "termina hoy"; con trial_vence guardado, no.
    tablas.usuarios = [usuario('u-viejo', { trial_inicio: '2026-11-03T15:00:00+00:00', trial_vence: '2026-11-17' })];

    await checks.checkTrialExpiry();

    expect(tiposDe('u-viejo')).toEqual([]);
    expect(tablas.usuarios[0].trial_estado).toBe('activo');
  });

  it('el día después de su trial_vence sí baja al muro (control)', async () => {
    tablas.usuarios = [usuario('u-viejo', { trial_inicio: '2026-10-26T15:00:00+00:00', trial_vence: '2026-11-09' })];

    await checks.checkTrialExpiry();

    expect(tablas.usuarios[0].plan).toBe('free');
    expect(tablas.usuarios[0].trial_estado).toBe('vencido');
    expect(llamadaDe('u-viejo', 'trial_vencido')).toBeTruthy();
  });

  it('su víspera (día 13 de 14) también recibe el aviso si la está usando', async () => {
    tablas.usuarios = [usuario('u-viejo', { trial_inicio: '2026-10-28T15:00:00+00:00', trial_vence: '2026-11-11' })];
    tablas.transacciones = txEnDias('u-viejo', ['01', '05', '09']);
    tablas.conversaciones = [turno('u-viejo', '2026-11-10T13:00:00+00:00')];

    await checks.checkTrialExpiry();

    expect(llamadaDe('u-viejo', 'trial_d6')).toBeTruthy();
  });

  it('diasRestantesTrial lee trial_vence: a una prueba de 14 en su día 10 le quedan 4', () => {
    // El guard de abajo es de FORMA y tiene límites (un alias de la constante lo esquiva: lo
    // midió la revisión adversarial del 04-nov). Lo que de verdad sostiene la regla son los
    // casos de comportamiento como éste, uno por cada lector del vencimiento.
    const viejo = usuario('u-viejo', { trial_inicio: '2026-10-31T15:00:00+00:00', trial_vence: '2026-11-14' });
    expect(trial.diasRestantesTrial(viejo, '2026-11-10')).toBe(4);
    const nuevo = usuario('u-nuevo', { trial_inicio: '2026-11-08T15:00:00+00:00', trial_vence: '2026-11-15' });
    expect(trial.diasRestantesTrial(nuevo, '2026-11-10')).toBe(5);
  });

  it('ningún archivo de runtime deriva un vencimiento de TRIAL_DIAS fuera de iniciarTrialSiCorresponde', () => {
    // Si alguien calcula "trial_inicio + TRIAL_DIAS" para decidir quién vence, las pruebas de 14
    // que ya corrían pasan a vencer a los 7. La fecha se escribe una vez y se LEE.
    //
    // Límite declarado: mira la forma directa (la constante y la aritmética de fechas en el mismo
    // statement). Un alias (`const D = TRIAL_DIAS`) o un literal `7` lo esquivan; por eso cada
    // lector del vencimiento tiene además su caso de comportamiento (arriba y en
    // `webapp/src/lib/plan-trial-dias.test.ts`).
    const excluir = new Set(['node_modules', 'tests', 'qa-e2e', 'docs', 'scripts', 'migrations', '.git', '.github', '.next']);
    const archivos = [];
    const barrer = (dir) => {
      for (const n of readdirSync(dir)) {
        if (excluir.has(n)) continue;
        const p = path.join(dir, n);
        if (statSync(p).isDirectory()) barrer(p);
        else if (/\.(js|mjs|cjs|ts|tsx)$/.test(n) && !/\.test\.(js|ts|tsx)$/.test(n) && !/\.d\.ts$/.test(n)) archivos.push(p);
      }
    };
    barrer(projectRoot);
    expect(archivos.length, 'el barrido no encontró archivos: el guard no mira nada').toBeGreaterThan(50);

    const sospechosos = [];
    for (const p of archivos) {
      const src = readFileSync(p, 'utf8');
      const rel = path.relative(projectRoot, p).replace(/\\/g, '/');
      if (!/TRIAL_DIAS/.test(src)) continue;
      // Cualquier aritmética de fechas con TRIAL_DIAS en el mismo statement.
      const statements = src.split(/;\s*\n/);
      for (const s of statements) {
        if (/TRIAL_DIAS/.test(s) && /(sumarDias|setDate|getDate|86400|addDays|\bDate\b)/.test(s)) {
          sospechosos.push(rel + ': ' + s.trim().slice(0, 120));
        }
      }
    }
    // El único que puede hacerlo es el que arranca la prueba, y lo hace leyendo `dias` (que por
    // defecto es TRIAL_DIAS), no la constante en el cálculo.
    expect(sospechosos).toEqual([]);
  });
});

describe('el aviso de la víspera (trial_d6)', () => {
  const califica = (id, extra) => {
    tablas.usuarios = [...(tablas.usuarios || []), usuario(id, extra)];
    tablas.transacciones.push(...txEnDias(id, ['04', '06', '09']));
    tablas.conversaciones.push(turno(id, '2026-11-10T13:00:00+00:00'));   // 8am Lima: hace 2h
  };

  it('sale por WhatsApp y campana, sin correo, con el precio y el link', async () => {
    califica('u-ana');

    await checks.checkTrialExpiry();

    const a = llamadaDe('u-ana', 'trial_d6');
    expect(a, 'el aviso de la víspera no salió').toBeTruthy();
    expect(a.canales).toBe('ambos');
    expect(a.email).toBeUndefined();
    expect(a.claimInApp).toBe(true);
    expect(a.titulo).toBe('Tu prueba Pro termina mañana');
    expect(a.mensaje).toMatch(/termina \*?mañana/);
    expect(a.mensaje).toContain('S/10');
    expect(a.mensaje).toContain('https://app.neto.pe/dashboard/pro');
    expect(a.mensaje).toMatch(/3 días/);
  });

  it('sin cuenta web también lleva precio y link (el link firmado o el panel)', async () => {
    califica('u-solo-wa', { supabase_auth_id: null, email: null });

    await checks.checkTrialExpiry();

    const a = llamadaDe('u-solo-wa', 'trial_d6');
    expect(a).toBeTruthy();
    expect(a.mensaje).toContain('S/10');
    expect(a.mensaje).toMatch(/https:\/\/\S+/);
  });

  it('no sale con solo 2 días de movimientos', async () => {
    tablas.usuarios = [usuario('u-poco')];
    tablas.transacciones = txEnDias('u-poco', ['04', '04', '09']);   // 3 gastos, 2 días
    tablas.conversaciones = [turno('u-poco', '2026-11-10T13:00:00+00:00')];

    await checks.checkTrialExpiry();

    expect(llamadaDe('u-poco', 'trial_d6')).toBeFalsy();
  });

  it('cuenta el día del primer gasto aunque se haya insertado antes de sellar trial_inicio', async () => {
    // El gasto que abre la prueba entra a `transacciones` y RECIÉN después
    // `iniciarTrialSiCorresponde` sella `trial_inicio`: su created_at es un instante anterior.
    tablas.usuarios = [usuario('u-dia0')];
    tablas.transacciones = [
      { id: 'u-dia0-primero', usuario_id: 'u-dia0', tipo: 'gasto', created_at: '2026-11-04T14:59:58+00:00' },
      ...txEnDias('u-dia0', ['06', '09']),
    ];
    tablas.conversaciones = [turno('u-dia0', '2026-11-10T13:00:00+00:00')];

    await checks.checkTrialExpiry();

    expect(llamadaDe('u-dia0', 'trial_d6')).toBeTruthy();
  });

  it('no cuenta los días de antes de la prueba', async () => {
    tablas.usuarios = [usuario('u-dormido')];
    tablas.transacciones = [
      ...txEnDias('u-dormido', ['01', '02']).map((t) => ({ ...t, created_at: t.created_at.replace('-11-', '-10-') })),
      ...txEnDias('u-dormido', ['05', '09']),
    ];
    tablas.conversaciones = [turno('u-dormido', '2026-11-10T13:00:00+00:00')];

    await checks.checkTrialExpiry();

    expect(llamadaDe('u-dormido', 'trial_d6')).toBeFalsy();
  });

  it('no sale con la ventana de 24h cerrada (último mensaje hace 25h)', async () => {
    califica('u-lejos');
    tablas.conversaciones = [turno('u-lejos', '2026-11-09T14:00:00+00:00')];

    await checks.checkTrialExpiry();

    expect(llamadaDe('u-lejos', 'trial_d6')).toBeFalsy();
  });

  it('mira el ÚLTIMO mensaje entrante, no el primero ni uno de Neto', async () => {
    califica('u-orden');
    tablas.conversaciones = [
      turno('u-orden', '2026-11-05T14:00:00+00:00'),
      { ...turno('u-orden', '2026-11-10T14:30:00+00:00'), id: 'c-bot', rol: 'asistente' },
      { ...turno('u-orden', '2026-11-10T12:00:00+00:00'), id: 'c-ultimo' },
    ];

    await checks.checkTrialExpiry();
    expect(llamadaDe('u-orden', 'trial_d6')).toBeTruthy();

    // Y si el único reciente es de Neto, la ventana está cerrada.
    notificar.mockClear();
    tablas.notificaciones = [];
    tablas.conversaciones = tablas.conversaciones.filter((c) => c.id !== 'c-ultimo');
    await checks.checkTrialExpiry();
    expect(llamadaDe('u-orden', 'trial_d6')).toBeFalsy();
  });

  it('no sale sin ningún mensaje entrante (anota solo desde la web)', async () => {
    califica('u-web');
    tablas.conversaciones = [];

    await checks.checkTrialExpiry();

    expect(llamadaDe('u-web', 'trial_d6')).toBeFalsy();
  });

  it('espera a que abra la ventana: a las 8am no sale, a las 2pm sí', async () => {
    califica('u-tarde');
    tablas.conversaciones = [turno('u-tarde', '2026-11-10T18:30:00+00:00')];   // escribe 1:30pm

    vi.setSystemTime(lima('08:30'));
    await checks.checkTrialExpiry();
    expect(llamadaDe('u-tarde', 'trial_d6')).toBeFalsy();

    vi.setSystemTime(lima('14:00'));
    await checks.checkTrialExpiry();
    expect(llamadaDe('u-tarde', 'trial_d6')).toBeTruthy();
  });

  it('no sale de noche (21h en adelante)', async () => {
    califica('u-noche');
    tablas.conversaciones = [turno('u-noche', '2026-11-11T01:00:00+00:00')];   // 8pm Lima
    vi.setSystemTime(lima('21:30'));

    await checks.checkTrialExpiry();

    expect(llamadaDe('u-noche', 'trial_d6')).toBeFalsy();
  });

  it('no sale a quien pidió no recibir recordatorios', async () => {
    califica('u-baja', { recordatorios_activos: false });

    await checks.checkTrialExpiry();

    expect(llamadaDe('u-baja', 'trial_d6')).toBeFalsy();
  });

  it('no sale dos veces el mismo día', async () => {
    califica('u-dup');
    tablas.notificaciones = [{
      id: 'n1', usuario_id: 'u-dup', tipo: 'recordatorio', titulo: 'Tu prueba Pro termina mañana',
      fecha: '2026-11-10T14:00:00.000Z',
    }];

    await checks.checkTrialExpiry();

    expect(llamadaDe('u-dup', 'trial_d6')).toBeFalsy();
  });

  it('con la lectura de transacciones caída no sale y lo dice', async () => {
    califica('u-err');
    errores.transacciones = true;

    await checks.checkTrialExpiry();

    expect(llamadaDe('u-err', 'trial_d6')).toBeFalsy();
    expect(logMock.error).toHaveBeenCalled();
  });

  it('con la lectura de conversaciones caída no sale y lo dice', async () => {
    califica('u-err2');
    errores.conversaciones = true;

    await checks.checkTrialExpiry();

    expect(llamadaDe('u-err2', 'trial_d6')).toBeFalsy();
    expect(logMock.error).toHaveBeenCalled();
  });
});

describe('los demás avisos', () => {
  it('ya no hay aviso de "faltan 3 días"', async () => {
    tablas.usuarios = [usuario('u-3', { trial_vence: '2026-11-13' })];
    tablas.transacciones = txEnDias('u-3', ['04', '06', '09']);
    tablas.conversaciones = [turno('u-3', '2026-11-10T13:00:00+00:00')];

    await checks.checkTrialExpiry();

    expect(tiposDe('u-3')).toEqual([]);
  });

  it('el último día sale "termina hoy" (trial_d7) por los tres canales, use o no Neto', async () => {
    tablas.usuarios = [usuario('u-hoy', { trial_vence: '2026-11-10' })];

    await checks.checkTrialExpiry();

    const a = llamadaDe('u-hoy', 'trial_d7');
    expect(a).toBeTruthy();
    expect(a.titulo).toBe('Tu prueba Pro termina hoy');
    expect(a.email && a.email.to).toBe('ana@ejemplo.pe');
  });
});
