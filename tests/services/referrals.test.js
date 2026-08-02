import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';
import path from 'path';

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]):/, '$1:'), '../..');

// Regresión de services/referrals.js — modelo de referidos DOS LADOS (rediseño 2026-07-31).
//
// Invariantes cubiertas:
// 1. El premio al referrer se dispara por CONVERSIÓN Pro pagada del referido, no por uso.
//    procesarConversionProReferido premia 1 mes por conversión, idempotente por-referido
//    (claim atómico convertido_pro false->true).
// 2. ANTI-DOBLE-OTORGAMIENTO. El otorgamiento del mes usa un CAS sobre
//    referidos_meses_otorgados: dos conversiones concurrentes del mismo referrer no pisan
//    su premium_vence (last-write-wins daría 1 mes en vez de 2).
// 3. ESCRITURA SOBRE LECTURA FALLIDA. Un SELECT que falla no se interpreta como "no existe".
// 4. Lado del referido: sembrarDescuentoReferido pone 50% off (7 días) solo a un free sin
//    descuento vigente.

let router;
function makeChain(table, op) {
  const q = { table, op, payload: null, methods: [] };
  const chain = {};
  for (const m of ['eq', 'neq', 'gte', 'lte', 'lt', 'gt', 'ilike', 'limit', 'order', 'not', 'in', 'is']) {
    chain[m] = (...a) => { q.methods.push([m, ...a]); return chain; };
  }
  // .update().select('id') sigue siendo escritura: no pisar q.op.
  chain.select = (cols, opts) => { if (!q.op) q.op = 'select'; if (opts && opts.head) q.head = true; return chain; };
  chain.single = () => { q.single = true; return chain; };
  chain.maybeSingle = () => { q.single = true; return chain; };
  chain.then = (resolve, reject) => {
    ops.push(q);
    return Promise.resolve({ data: null, error: null, count: null, ...(router(q) || {}) }).then(resolve, reject);
  };
  return { chain, q };
}

let ops = [];
const dbMock = {
  supabase: {
    from: (t) => ({
      select: (...a) => makeChain(t).chain.select(...a),
      insert: (p) => { const { chain, q } = makeChain(t, 'insert'); q.payload = p; return chain; },
      update: (p) => { const { chain, q } = makeChain(t, 'update'); q.payload = p; return chain; },
    }),
  },
};
const logMock = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn() };
const waMock = {
  // Replica la red de seguridad web-first del helper real: sin numero no hay envio, pero
  // tampoco excepcion (lib/whatsapp.js).
  enviarWhatsapp: vi.fn(async (numero) => (
    numero ? { ok: true, msgId: 'wamid.1' } : { ok: false, skipped: 'no_whatsapp' }
  )),
};
const notifMock = { crearNotificacion: vi.fn().mockResolvedValue(true) };

for (const [rel, exports] of [
  ['lib/db.js', dbMock],
  ['lib/logger.js', logMock],
  ['lib/whatsapp.js', waMock],
  ['lib/notifications-db.js', notifMock],
]) {
  const p = require.resolve(path.join(projectRoot, rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}

const {
  registrarReferido,
  sembrarDescuentoReferido,
  procesarConversionProReferido,
  obtenerEstadisticasReferidos,
  resumenReferidoParaAdmin,
  mensajeMisReferidos,
} = require('../../services/referrals');

const FALLO = { data: null, error: { message: 'read failure', code: '500' } };
const SIN_FILA = { data: null, error: { code: 'PGRST116', message: 'no rows' } };
const HOY = new Date().toISOString().slice(0, 10);
const escrituras = (tabla) => ops.filter(o => (o.op === 'insert' || o.op === 'update') && (!tabla || o.table === tabla));

beforeEach(() => {
  ops = [];
  logMock.error.mockClear();
  logMock.warn.mockClear();
  waMock.enviarWhatsapp.mockClear();
  notifMock.crearNotificacion.mockClear();
});

describe('registrarReferido', () => {
  // Router base: dedup sin fila, referrer con ref_code, referido free sin descuento.
  function routerAlta(extra) {
    return (q) => {
      if (q.table === 'referidos' && q.op === 'select') return SIN_FILA;
      if (q.table === 'usuarios' && q.op === 'select') return { data: { ref_code: 'ABCD1234', plan: 'free', referido_dscto_vence: null } };
      return (extra && extra(q)) || {};
    };
  }

  it('no inserta cuando el SELECT de dedup falla (no puede saber si ya existe)', async () => {
    router = (q) => {
      if (q.table === 'referidos' && q.op === 'select') return FALLO;
      if (q.table === 'usuarios') return { data: { ref_code: 'ABCD1234' } };
      return {};
    };
    await registrarReferido('r1', 'u1');
    expect(escrituras()).toHaveLength(0);
    expect(logMock.error).toHaveBeenCalled();
  });

  it('inserta el vínculo y siembra el descuento cuando el referido es nuevo', async () => {
    router = routerAlta();
    await registrarReferido('r1', 'u1');
    const ins = escrituras('referidos');
    expect(ins).toHaveLength(1);
    expect(ins[0].payload).toEqual({ ref_code: 'ABCD1234', referrer_id: 'r1', referido_id: 'u1' });
    // Y siembra el 50% off al referido.
    const updDscto = escrituras('usuarios').find(o => o.payload.referido_dscto_pct);
    expect(updDscto).toBeTruthy();
    expect(updDscto.payload.referido_dscto_pct).toBe(50);
  });

  it('no loguea error cuando el insert choca con el unique index (ya existía)', async () => {
    router = routerAlta((q) => (q.op === 'insert' ? { data: null, error: { code: '23505', message: 'duplicate key' } } : null));
    await registrarReferido('r1', 'u1');
    expect(logMock.error).not.toHaveBeenCalled();
  });

  it('loguea y no siembra cuando el insert falla por otro motivo', async () => {
    router = routerAlta((q) => (q.op === 'insert' ? { data: null, error: { code: '23502', message: 'null value' } } : null));
    await registrarReferido('r1', 'u1');
    expect(logMock.error).toHaveBeenCalled();
    expect(escrituras('usuarios')).toHaveLength(0); // no llegó a sembrar el descuento
  });
});

describe('sembrarDescuentoReferido', () => {
  it('siembra 50% off por 7 días a un referido free sin descuento', async () => {
    router = (q) => (q.table === 'usuarios' && q.op === 'select') ? { data: { plan: 'free', referido_dscto_vence: null } } : {};
    await sembrarDescuentoReferido('u1');
    const upd = escrituras('usuarios')[0];
    expect(upd.payload.referido_dscto_pct).toBe(50);
    expect(upd.payload.referido_dscto_vence > HOY).toBe(true);
  });

  it('no siembra si el referido ya es premium (no tiene primer mes)', async () => {
    router = (q) => (q.table === 'usuarios' && q.op === 'select') ? { data: { plan: 'premium' } } : {};
    await sembrarDescuentoReferido('u1');
    expect(escrituras('usuarios')).toHaveLength(0);
  });

  it('no reinicia la ventana si el descuento sigue vigente', async () => {
    router = (q) => (q.table === 'usuarios' && q.op === 'select') ? { data: { plan: 'free', referido_dscto_vence: '2099-12-31' } } : {};
    await sembrarDescuentoReferido('u1');
    expect(escrituras('usuarios')).toHaveLength(0);
  });
});

describe('procesarConversionProReferido', () => {
  // DB simulada: fila del referido (claim) + fila del referrer con CAS atómico.
  function montar({ refRow, claim, referrer, updateReferrer } = {}) {
    const estado = {
      referrer: { whatsapp: '51999', nombre: 'Ana Perez', premium_desde: null, premium_vence: null, referidos_meses_otorgados: 0, ...referrer },
    };
    router = (q) => {
      if (q.table === 'referidos' && q.op === 'select' && q.head) return { count: 3 }; // conteo de convertidos (para el aviso)
      if (q.table === 'referidos' && q.op === 'select') return { data: refRow === undefined ? { referrer_id: 'r1', convertido_pro: false } : refRow };
      if (q.table === 'referidos' && q.op === 'update') return { data: claim === undefined ? { referrer_id: 'r1' } : claim }; // claim atómico
      if (q.table === 'usuarios' && q.op === 'select') return { data: { ...estado.referrer } };
      if (q.table === 'usuarios' && q.op === 'update') {
        if (updateReferrer) return updateReferrer;
        const c = q.methods.find(m => m[0] === 'eq' && m[1] === 'referidos_meses_otorgados');
        if (c && c[2] !== estado.referrer.referidos_meses_otorgados) return { data: [] }; // CAS perdió
        estado.referrer = { ...estado.referrer, ...q.payload };
        return { data: [{ id: 'r1' }] };
      }
      return {};
    };
    return estado;
  }

  it('premia al referrer con 1 mes cuando el referido convierte a Pro', async () => {
    const db = montar();
    await procesarConversionProReferido('u1');
    expect(db.referrer.plan).toBe('premium');
    expect(db.referrer.referidos_meses_otorgados).toBe(1);
    expect(db.referrer.premium_vence > HOY).toBe(true);
    expect(waMock.enviarWhatsapp).toHaveBeenCalledTimes(1);
  });

  it('no premia si el referido ya estaba convertido (fast path, sin UPDATE)', async () => {
    montar({ refRow: { referrer_id: 'r1', convertido_pro: true } });
    await procesarConversionProReferido('u1');
    expect(escrituras()).toHaveLength(0);
    expect(waMock.enviarWhatsapp).not.toHaveBeenCalled();
  });

  it('no premia si otra ejecución ya se llevó el claim (convertido_pro)', async () => {
    montar({ claim: null });
    await procesarConversionProReferido('u1');
    expect(escrituras('usuarios')).toHaveLength(0);
    expect(waMock.enviarWhatsapp).not.toHaveBeenCalled();
  });

  it('no hace nada si el usuario no fue referido por nadie', async () => {
    montar({ refRow: null });
    await procesarConversionProReferido('u1');
    expect(escrituras()).toHaveLength(0);
    expect(waMock.enviarWhatsapp).not.toHaveBeenCalled();
  });

  it('con el Pro del referrer vencido la base es hoy, no la fecha vieja', async () => {
    const db = montar({ referrer: { premium_vence: '2020-01-15' } });
    await procesarConversionProReferido('u1');
    expect(db.referrer.premium_vence > HOY).toBe(true);
  });

  // El vencimiento se calcula con sumarMeses (no setMonth): un 31 avanza al último día del
  // mes destino, no desborda al siguiente.
  it('apila sobre el vencimiento vigente respetando fin de mes', async () => {
    const db = montar({ referrer: { premium_vence: '2099-01-31' } });
    await procesarConversionProReferido('u1');
    expect(db.referrer.premium_vence).toBe('2099-02-28');
  });

  it('el UPDATE del otorgamiento lleva el claim sobre el contador leído', async () => {
    montar();
    await procesarConversionProReferido('u1');
    const upd = escrituras('usuarios')[0];
    expect(upd.methods).toContainEqual(['eq', 'referidos_meses_otorgados', 0]);
    expect(upd.payload.referidos_meses_otorgados).toBe(1);
  });

  it('dos referidos distintos que convierten dan 2 meses (CAS serializa)', async () => {
    const db = montar();
    await Promise.all([procesarConversionProReferido('u1'), procesarConversionProReferido('u2')]);
    expect(db.referrer.referidos_meses_otorgados).toBe(2);
    expect(waMock.enviarWhatsapp).toHaveBeenCalledTimes(2);
  });

  it('no avisa por WhatsApp si no puede leer al referrer', async () => {
    router = (q) => {
      if (q.table === 'referidos' && q.op === 'select') return { data: { referrer_id: 'r1', convertido_pro: false } };
      if (q.table === 'referidos' && q.op === 'update') return { data: { referrer_id: 'r1' } };
      if (q.table === 'usuarios' && q.op === 'select') return FALLO;
      return {};
    };
    await procesarConversionProReferido('u1');
    expect(escrituras('usuarios')).toHaveLength(0);
    expect(waMock.enviarWhatsapp).not.toHaveBeenCalled();
    expect(logMock.error).toHaveBeenCalled();
  });

  it('no avisa por ningún canal si el UPDATE del otorgamiento falla', async () => {
    montar({ updateReferrer: FALLO });
    await procesarConversionProReferido('u1');
    expect(waMock.enviarWhatsapp).not.toHaveBeenCalled();
    expect(notifMock.crearNotificacion).not.toHaveBeenCalled();
    expect(logMock.error).toHaveBeenCalled();
  });

  it('el referrer web-only (sin whatsapp) recibe el mes Y SE ENTERA por la campana', async () => {
    const db = montar({ referrer: { whatsapp: null } });
    await procesarConversionProReferido('u1');

    expect(db.referrer.plan).toBe('premium');
    // Antes esto cortaba con `if (!referrer.whatsapp) return` y el comentario prometía que
    // "verá el mes reflejado en la webapp" — pero eso era un premium_vence que cambiaba
    // solo, sin una línea que dijera por qué. Es un beneficio ya otorgado e irreversible:
    // el peor candidato para depender de la ventana de 24h de Meta.
    expect(notifMock.crearNotificacion).toHaveBeenCalledTimes(1);
    const [usuarioId, , titulo] = notifMock.crearNotificacion.mock.calls[0];
    expect(usuarioId).toBe('r1');
    expect(titulo).toBe('Ganaste 1 mes de Neto Pro gratis');
  });

  it('el referrer con whatsapp recibe los dos canales', async () => {
    montar({});
    await procesarConversionProReferido('u1');

    const premio = waMock.enviarWhatsapp.mock.calls.find((c) => c[2]?.tipo === 'referido_premio');
    expect(premio).toBeDefined();
    expect(notifMock.crearNotificacion.mock.calls.map((c) => c[0])).toContain('r1');
  });
});

describe('obtenerEstadisticasReferidos', () => {
  it('cuenta invitados (aún no Pro), referidos Pro y meses', async () => {
    router = (q) => (q.table === 'referidos' && q.op === 'select')
      ? { data: [{ convertido_pro: true }, { convertido_pro: false }, { convertido_pro: true }] }
      : {};
    const s = await obtenerEstadisticasReferidos('r1');
    expect(s).toEqual({ invitados: 1, referidosPro: 2, meses: 2 });
  });

  it('devuelve ceros si la lectura falla (no inventa)', async () => {
    router = (q) => (q.table === 'referidos' && q.op === 'select') ? FALLO : {};
    const s = await obtenerEstadisticasReferidos('r1');
    expect(s).toEqual({ invitados: 0, referidosPro: 0, meses: 0 });
  });
});

describe('resumenReferidoParaAdmin', () => {
  it('reporta el descuento vigente y el nombre del referrer', async () => {
    router = (q) => {
      if (q.table === 'usuarios' && q.op === 'select') {
        const idEq = q.methods.find(m => m[0] === 'eq' && m[1] === 'id');
        if (idEq && idEq[2] === 'u1') return { data: { referido_dscto_pct: 50, referido_dscto_vence: '2099-01-01' } };
        return { data: { nombre: 'Ana Perez' } };
      }
      if (q.table === 'referidos' && q.op === 'select') return { data: { referrer_id: 'r1', convertido_pro: false } };
      return {};
    };
    const r = await resumenReferidoParaAdmin('u1');
    expect(r.descuentoPct).toBe(50);
    expect(r.referrerNombre).toBe('Ana Perez');
    expect(r.yaPremiado).toBe(false);
  });

  it('ignora un descuento ya vencido', async () => {
    router = (q) => {
      if (q.table === 'usuarios' && q.op === 'select') return { data: { referido_dscto_pct: 50, referido_dscto_vence: '2000-01-01' } };
      if (q.table === 'referidos' && q.op === 'select') return { data: null };
      return {};
    };
    const r = await resumenReferidoParaAdmin('u1');
    expect(r.descuentoPct).toBe(0);
    expect(r.referrerNombre).toBe(null);
  });
});

describe('mensajeMisReferidos', () => {
  it('arma el mensaje con el link a la mini-landing y el progreso dos-lados', () => {
    const m = mensajeMisReferidos('ABC123', { invitados: 2, referidosPro: 1, meses: 1 });
    expect(m).toContain('neto.pe/r/ABC123');
    expect(m).toContain('1 mes gratis');
    expect(m).toContain('Invitados: 2');
    expect(m).toContain('Referidos Pro: 1');
    expect(m).toContain('Meses ganados: 1');
  });
});
