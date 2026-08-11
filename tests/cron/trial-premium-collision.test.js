import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { createRequire } from 'module';
import path from 'path';

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]):/, '$1:'), '../..');

// checkPremiumExpiry y el trial se pisaban, y no había forma de notarlo mirando producción:
// el cron corre, no falla, simplemente baja a alguien que no le tocaba.
//
// Lo que pasó el 2026-08-01, con nombre y hora: el backfill de la 052 le dio 30 días de
// cortesía a un ex-pagador (15:23 UTC). Su `premium_vence` de julio seguía en la fila, así
// que la query de expirados — `plan='premium' AND premium_vence IS NOT NULL AND
// premium_vence < hoy` — lo agarró en la corrida siguiente (16:41 UTC): plan a 'free',
// WhatsApp "tu plan NETO Pro venció", y `trial_estado` intacto en 'activo'. Quedó con el
// banner de prueba y el paywall en la misma pantalla durante 30 días.
//
// Dos redes independientes, y este archivo cubre las dos:
//   1. iniciarTrialSiCorresponde limpia `premium_vence` → el trial es invisible al cron.
//   2. checkPremiumExpiry excluye `trial_estado='activo'` → aunque (1) falle, no baja a nadie
//      que esté probando. El downgrade es la operación destructiva; va con cinturón y tirantes.

const queries = [];   // todas las queries hechas sobre `usuarios`
let usuariosData = [];
let updatePayload = null;
// `updatePayload` guarda solo el último. El downgrade de checkPremiumExpiry hace
// varias escrituras (plan, y después lo que toque revocarAccesoGmail), así que
// para afirmar sobre ESE update hace falta verlos todos.
const updatePayloads = [];
// Error inyectable en los UPDATE sobre `usuarios`. Sin esto no hay forma de
// ejercitar la rama "la escritura del downgrade no entró".
let updateError = null;

function makeChain(table) {
  const q = { table, methods: [], payload: null };
  const chain = {};
  for (const m of ['select', 'eq', 'neq', 'gte', 'lte', 'lt', 'gt', 'limit', 'order', 'not', 'in', 'is', 'or']) {
    chain[m] = (...args) => { q.methods.push([m, ...args]); return chain; };
  }
  chain.maybeSingle = () => Promise.resolve({ data: q.payload ? { id: 'u1' } : null, error: null });
  chain.single = () => Promise.resolve({ data: null, error: null });
  chain.then = (resolve) => {
    if (table === 'usuarios') return resolve({ data: usuariosData, error: null });
    return resolve({ data: [], error: null, count: 0 });
  };
  if (table === 'usuarios') queries.push(q);
  return chain;
}

const dbMock = {
  supabase: {
    from: vi.fn((t) => {
      const base = makeChain(t);
      return {
        ...base,
        update: (p) => {
          if (t === 'usuarios') { updatePayload = p; updatePayloads.push(p); }
          const c = makeChain(t);
          c.payload = p;
          if (t === 'usuarios' && updateError) {
            c.then = (resolve) => resolve({ data: null, error: updateError });
          }
          // maybeSingle tiene que devolver fila para que el CAS se lea como "ganó".
          c.maybeSingle = () => Promise.resolve({ data: { id: 'u1', referido_dscto_pct: null }, error: null });
          return c;
        },
      };
    }),
  },
};
const logMock = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn() };
const waMock = { enviarWhatsapp: vi.fn().mockResolvedValue({ ok: true }) };

for (const [rel, exports] of [
  ['lib/db.js', dbMock],
  ['lib/logger.js', logMock],
  ['lib/whatsapp.js', waMock],
  ['lib/notifications-db.js', { crearNotificacion: vi.fn().mockResolvedValue(true) }],
  ['lib/analytics.js', { capture: vi.fn() }],
  ['lib/admin-notify.js', { notificarAdmin: vi.fn() }],
]) {
  const p = require.resolve(path.join(projectRoot, rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}

const { checkPremiumExpiry, checkTrialExpiry } = require('../../cron/checks');
const { iniciarTrialSiCorresponde, enTrial } = require('../../lib/trial');

vi.useFakeTimers({ toFake: ['Date'] });
afterAll(() => { vi.useRealTimers(); });

beforeEach(() => {
  queries.length = 0;
  usuariosData = [];
  updatePayload = null;
  updatePayloads.length = 0;
  updateError = null;
  logMock.error.mockClear();
  waMock.enviarWhatsapp.mockClear();
});

/** Los filtros de una query, como pares legibles: [['eq','plan','premium'], ...] */
const filtros = (q) => q.methods.filter(([m]) => m !== 'select');
const tieneGuardDeTrial = (q) =>
  q.methods.some(([m, arg]) => m === 'or' && String(arg).includes('trial_estado'));

describe('checkPremiumExpiry no puede tocar a alguien que está probando', () => {
  // 10am Lima: pasado el gate horario, así que corren las tres queries.
  const MEDIA_MANANA = '2026-08-15T15:00:00Z';

  it('las TRES queries llevan el guard de trial activo', async () => {
    vi.setSystemTime(new Date(MEDIA_MANANA));
    await checkPremiumExpiry();

    const sobrePremium = queries.filter((q) =>
      q.methods.some(([m, col, val]) => m === 'eq' && col === 'plan' && val === 'premium'));
    expect(sobrePremium.length, 'aviso 3d + aviso hoy + expirados').toBe(3);
    for (const q of sobrePremium) {
      expect(tieneGuardDeTrial(q), 'query sin guard: ' + JSON.stringify(filtros(q))).toBe(true);
    }
  });

  it('el guard es NULL-safe: .neq() solo habría dejado pasar a los que tienen la columna', async () => {
    vi.setSystemTime(new Date(MEDIA_MANANA));
    await checkPremiumExpiry();
    const guards = queries.flatMap((q) => q.methods.filter(([m]) => m === 'or')).map(([, a]) => a);
    expect(guards.length).toBeGreaterThan(0);
    for (const g of guards) {
      // `NULL <> 'activo'` es NULL en SQL, así que un .neq() a secas descartaría a los 61
      // usuarios con trial_estado en NULL, que son justo los que este cron sí debe barrer.
      expect(g).toContain('trial_estado.is.null');
    }
  });
});

describe('el downgrade no deja a un ex-pagador marcado como pagado', () => {
  // `estado_pago` viajaba sola: el cron bajaba `plan` a 'free' y dejaba
  // `estado_pago='pagado'` intacto. La columna dejaba de significar "está pagado"
  // y pasaba a significar "alguna vez pagó", lista para que la primera lectura que
  // gatee por ella sola le entregue Pro gratis a quien ya se fue. Hallazgo D3: 2
  // usuarios reales en ese estado, con `premium_vence` de abril.
  it('el UPDATE del downgrade saca estado_pago de "pagado"', async () => {
    vi.setSystemTime(new Date('2026-08-15T15:00:00Z'));
    usuariosData = [{ id: 'u1', whatsapp: '51999', nombre: 'Ex Pagador', premium_vence: '2026-08-01', estado_pago: 'pagado' }];
    await checkPremiumExpiry();

    const downgrade = updatePayloads.find((p) => p && p.plan === 'free');
    expect(downgrade, 'no se hizo el UPDATE de downgrade').toBeTruthy();
    // La invariante es "no queda pagado", no un literal: si mañana se decide null
    // en vez de 'vencido', esto tiene que seguir protegiendo.
    expect(downgrade).toHaveProperty('estado_pago');
    expect(downgrade.estado_pago).not.toBe('pagado');
  });

  it('a quien NO venía pagando no le inventa un estado de pago', async () => {
    // Acá también caen Pro que nunca pagaron: meses ganados por referido y comps.
    // Marcarlos 'vencido' los convierte en pagadores-que-churnearon en el panel y
    // en el CSV de operación. Y un 'pendiente' es un comprobante esperando
    // aprobación: pisarlo le borra el ⏳ al admin.
    vi.setSystemTime(new Date('2026-08-15T15:00:00Z'));
    for (const estado of [null, 'pendiente']) {
      updatePayloads.length = 0;
      usuariosData = [{ id: 'u1', whatsapp: '51999', nombre: 'Comp', premium_vence: '2026-08-01', estado_pago: estado }];
      await checkPremiumExpiry();
      const downgrade = updatePayloads.find((p) => p && p.plan === 'free');
      expect(downgrade, 'no se hizo el UPDATE de downgrade').toBeTruthy();
      expect('estado_pago' in downgrade, `pisó estado_pago=${estado}`).toBe(false);
    }
  });

  it('si el UPDATE del downgrade falla, NO revoca el Gmail ni avisa que venció', async () => {
    // Sin esto: se revoca el grant de Google (el cupo no vuelve) y se le manda "tu
    // plan venció" a alguien que en la base sigue en 'premium' — y a la hora
    // siguiente el cron lo vuelve a agarrar y repite el ciclo, cada hora.
    vi.setSystemTime(new Date('2026-08-15T15:00:00Z'));
    usuariosData = [{ id: 'u1', whatsapp: '51999', nombre: 'Ex Pagador', premium_vence: '2026-08-01', estado_pago: 'pagado' }];
    updateError = { message: 'connection reset', code: '500' };
    await checkPremiumExpiry();

    expect(logMock.error).toHaveBeenCalled();
    const avisoVencido = waMock.enviarWhatsapp.mock.calls
      .find((c) => typeof c[1] === 'string' && c[1].includes('venció'));
    expect(avisoVencido, 'le avisó que venció sin haber podido bajarle el plan').toBeUndefined();
  });
});

describe('iniciarTrialSiCorresponde deja la fila invisible para checkPremiumExpiry', () => {
  it('limpia premium_vence al arrancar el trial', async () => {
    vi.setSystemTime(new Date('2026-08-15T15:00:00Z'));
    await iniciarTrialSiCorresponde('u1');
    expect(updatePayload, 'no se hizo el UPDATE').toBeTruthy();
    expect(updatePayload.plan).toBe('premium');
    expect(updatePayload.trial_estado).toBe('activo');
    // La línea que impide el incidente: un trial no hereda el vencimiento de una
    // suscripción que ya terminó.
    expect(updatePayload).toHaveProperty('premium_vence', null);
  });

  it('el filtro de plan es NULL-safe (la columna es nullable pese al default)', async () => {
    vi.setSystemTime(new Date('2026-08-15T15:00:00Z'));
    await iniciarTrialSiCorresponde('u1');
    const upd = queries.find((q) => q.methods.some(([m, c]) => m === 'is' && c === 'trial_estado'));
    expect(upd, 'no se encontró el CAS del trial').toBeTruthy();
    const orPlan = upd.methods.find(([m, a]) => m === 'or' && String(a).includes('plan'));
    expect(orPlan, 'el filtro de plan tiene que ser .or(), no .neq()').toBeTruthy();
    expect(orPlan[1]).toContain('plan.is.null');
    expect(upd.methods.some(([m, c]) => m === 'neq' && c === 'plan')).toBe(false);
  });
});

describe('enTrial exige las dos columnas', () => {
  it('plan premium + estado activo = está probando', () => {
    expect(enTrial({ plan: 'premium', trial_estado: 'activo' })).toBe(true);
  });

  it('estado activo con el plan caído NO es un trial: es el estado roto que producía la pantalla contradictoria', () => {
    expect(enTrial({ plan: 'free', trial_estado: 'activo' })).toBe(false);
  });

  it('Pro pagado no es un trial', () => {
    expect(enTrial({ plan: 'premium', trial_estado: 'convertido' })).toBe(false);
    expect(enTrial({ plan: 'premium', trial_estado: null })).toBe(false);
  });

  it('sin usuario no revienta', () => {
    expect(enTrial(null)).toBe(false);
  });
});

describe('D6 — el downgrade POR TRIAL tampoco deja a nadie marcado como pagado', () => {
  // El cron hermano (checkPremiumExpiry) ya limpiaba `estado_pago` desde D3, pero
  // checkTrialExpiry no, y por ahí se cuela un caso REAL: el usuario de cortesía de la
  // migración 054 quedó `plan='premium'`, `premium_vence=NULL` y `trial_estado='activo'`.
  // Con `premium_vence` en NULL, checkPremiumExpiry no lo ve —sus tres queries filtran por
  // esa columna— así que quien lo va a bajar el 31-ago es ESTE cron, y lo dejaba con
  // `estado_pago='pagado'` para siempre. Es D3 con otra causa y con fecha puesta.
  it('el UPDATE del downgrade por trial saca estado_pago de "pagado"', async () => {
    vi.setSystemTime(new Date('2026-09-01T15:00:00Z'));
    usuariosData = [{ id: 'u1', whatsapp: '51999', nombre: 'Cortesia 054',
      trial_estado: 'activo', trial_vence: '2026-08-31', premium_vence: null, estado_pago: 'pagado' }];
    await checkTrialExpiry();

    const downgrade = updatePayloads.find((p) => p && p.plan === 'free');
    expect(downgrade, 'no se hizo el UPDATE de downgrade').toBeTruthy();
    // La invariante es "no queda pagado", no un literal.
    expect(downgrade).toHaveProperty('estado_pago');
    expect(downgrade.estado_pago).not.toBe('pagado');
    // Y lo que este cron sí hacía tiene que seguir haciéndolo.
    expect(downgrade.trial_estado).toBe('vencido');
  });

  it('a quien NO venía pagando no le inventa un estado de pago', async () => {
    vi.setSystemTime(new Date('2026-09-01T15:00:00Z'));
    for (const estado of [null, 'pendiente']) {
      updatePayloads.length = 0;
      usuariosData = [{ id: 'u1', whatsapp: '51999', nombre: 'Trial normal',
        trial_estado: 'activo', trial_vence: '2026-08-31', premium_vence: null, estado_pago: estado }];
      await checkTrialExpiry();
      const downgrade = updatePayloads.find((p) => p && p.plan === 'free');
      expect(downgrade, 'no se hizo el UPDATE de downgrade').toBeTruthy();
      expect('estado_pago' in downgrade, `pisó estado_pago=${estado}`).toBe(false);
    }
  });

  it('el select del cron trae estado_pago (una fila parcial no puede decidir)', async () => {
    vi.setSystemTime(new Date('2026-09-01T15:00:00Z'));
    usuariosData = [{ id: 'u1', whatsapp: '51999', nombre: 'X',
      trial_estado: 'activo', trial_vence: '2026-08-31', estado_pago: 'pagado' }];
    await checkTrialExpiry();
    const selects = queries.flatMap((q) => q.methods.filter(([m]) => m === 'select')).map(([, a]) => String(a));
    expect(selects.some((s) => s.includes('estado_pago')), 'ningún select pide estado_pago').toBe(true);
  });
});
