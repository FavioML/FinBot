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
          if (t === 'usuarios') { updatePayload = p; }
          const c = makeChain(t);
          c.payload = p;
          // maybeSingle tiene que devolver fila para que el CAS se lea como "ganó".
          c.maybeSingle = () => Promise.resolve({ data: { id: 'u1', referido_dscto_pct: null }, error: null });
          return c;
        },
      };
    }),
  },
};
const logMock = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn() };

for (const [rel, exports] of [
  ['lib/db.js', dbMock],
  ['lib/logger.js', logMock],
  ['lib/whatsapp.js', { enviarWhatsapp: vi.fn().mockResolvedValue({ ok: true }) }],
  ['lib/notifications-db.js', { crearNotificacion: vi.fn().mockResolvedValue(true) }],
  ['lib/analytics.js', { capture: vi.fn() }],
  ['lib/admin-notify.js', { notificarAdmin: vi.fn() }],
]) {
  const p = require.resolve(path.join(projectRoot, rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}

const { checkPremiumExpiry } = require('../../cron/checks');
const { iniciarTrialSiCorresponde, enTrial } = require('../../lib/trial');

vi.useFakeTimers({ toFake: ['Date'] });
afterAll(() => { vi.useRealTimers(); });

beforeEach(() => {
  queries.length = 0;
  usuariosData = [];
  updatePayload = null;
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
