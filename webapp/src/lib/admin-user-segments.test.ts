import { describe, it, expect } from 'vitest';
import {
  classifyUser,
  countBySegment,
  daysUntilProExpiry,
  isProExpiringSoon,
  POWER_TX_THRESHOLD,
  estadoComercial,
  countByEstado,
  diasHastaFinTrial,
  isTrialExpiringSoon,
  type EstadoComercial,
} from './admin-user-segments';

describe('classifyUser', () => {
  it('power = activo en 14d y >= umbral de tx totales', () => {
    expect(classifyUser({ transacciones: POWER_TX_THRESHOLD, tx_14d: 3, tx_30d: 8 })).toBe('power');
    expect(classifyUser({ transacciones: 120, tx_14d: 1, tx_30d: 5 })).toBe('power');
  });

  it('activo = tx en 14d pero por debajo del umbral de power', () => {
    expect(classifyUser({ transacciones: 5, tx_14d: 2, tx_30d: 4 })).toBe('activo');
    // Justo debajo del umbral aunque sea activo
    expect(classifyUser({ transacciones: POWER_TX_THRESHOLD - 1, tx_14d: 1, tx_30d: 1 })).toBe(
      'activo',
    );
  });

  it('en riesgo = sin tx en 14d pero con actividad en 30d', () => {
    expect(classifyUser({ transacciones: 10, tx_14d: 0, tx_30d: 3 })).toBe('en_riesgo');
  });

  it('dormido = 0 tx nunca, o sin tx en >30d', () => {
    expect(classifyUser({ transacciones: 0, tx_14d: 0, tx_30d: 0 })).toBe('dormido');
    expect(classifyUser({ transacciones: 40, tx_14d: 0, tx_30d: 0 })).toBe('dormido');
  });

  it('trata los campos de actividad faltantes como 0 (dormido)', () => {
    expect(classifyUser({ transacciones: 12 })).toBe('dormido');
  });
});

describe('countBySegment', () => {
  it('suma exactamente el total (cada usuario cae en un solo segmento)', () => {
    const users = [
      { transacciones: 50, tx_14d: 4, tx_30d: 10 }, // power
      { transacciones: 3, tx_14d: 1, tx_30d: 2 }, // activo
      { transacciones: 8, tx_14d: 0, tx_30d: 2 }, // en_riesgo
      { transacciones: 0, tx_14d: 0, tx_30d: 0 }, // dormido
      { transacciones: 5, tx_14d: 0, tx_30d: 0 }, // dormido
    ];
    const c = countBySegment(users);
    expect(c).toEqual({ power: 1, activo: 1, en_riesgo: 1, dormido: 2 });
    const sum = c.power + c.activo + c.en_riesgo + c.dormido;
    expect(sum).toBe(users.length);
  });
});

describe('daysUntilProExpiry / isProExpiringSoon', () => {
  const now = new Date('2026-07-30T00:00:00Z').getTime();

  it('null cuando no es premium o no tiene fecha', () => {
    expect(daysUntilProExpiry({ plan: 'free', premium_vence: '2026-08-01' }, now)).toBeNull();
    expect(daysUntilProExpiry({ plan: 'premium', premium_vence: null }, now)).toBeNull();
    expect(daysUntilProExpiry({ plan: 'premium', premium_vence: 'no-date' }, now)).toBeNull();
  });

  it('cuenta los días hasta el vencimiento', () => {
    expect(daysUntilProExpiry({ plan: 'premium', premium_vence: '2026-08-05' }, now)).toBe(6);
    expect(daysUntilProExpiry({ plan: 'premium', premium_vence: '2026-07-28' }, now)).toBe(-2);
  });

  it('por vencer = dentro de los próximos 7 días o ya vencido pero aún premium', () => {
    expect(isProExpiringSoon({ plan: 'premium', premium_vence: '2026-08-05' }, now)).toBe(true);
    expect(isProExpiringSoon({ plan: 'premium', premium_vence: '2026-07-28' }, now)).toBe(true);
    expect(isProExpiringSoon({ plan: 'premium', premium_vence: '2026-09-01' }, now)).toBe(false);
    expect(isProExpiringSoon({ plan: 'free', premium_vence: '2026-08-01' }, now)).toBe(false);
  });
});

describe('estadoComercial', () => {
  // Los seis casos salen de la base de producción del 27-ago-2026, con los conteos que
  // había ese día. No es decoración: el panel colapsaba estas seis poblaciones en dos
  // etiquetas ("Pro" y "Free"), y cada fila de acá es un grupo que el panel escondía.
  const CASOS: Array<[string, Parameters<typeof estadoComercial>[0], EstadoComercial]> = [
    ['pagador vivo (3 usuarios)', { plan: 'premium', trial_estado: 'convertido' }, 'pro_pagado'],
    ['probando ahora (28)', { plan: 'premium', trial_estado: 'activo' }, 'trial'],
    ['prueba vencida (10)', { plan: 'free', trial_estado: 'vencido' }, 'muro_vencido'],
    ['ex pagador churneado (5)', { plan: 'free', trial_estado: 'convertido' }, 'muro_ex_pagador'],
    ['nunca registró un gasto (72)', { plan: 'free', trial_estado: null }, 'sin_estrenar'],
    ['mandó comprobante', { plan: 'free', trial_estado: 'vencido', pago_pendiente: true }, 'pago_pendiente'],
  ];
  for (const [nombre, user, esperado] of CASOS) {
    it(nombre + ' → ' + esperado, () => {
      expect(estadoComercial(user)).toBe(esperado);
    });
  }

  it('el comprobante en revisión gana incluso sobre el trial corriendo', () => {
    // Mismo orden de precedencia que `pantallaPro`. Si se invirtiera, alguien que pagó
    // durante su prueba desaparecería de la cola de aprobación.
    expect(estadoComercial({ plan: 'premium', trial_estado: 'activo', pago_pendiente: true }))
      .toBe('pago_pendiente');
  });

  it('premium sin trial_estado cuenta como pagado, no como prueba', () => {
    // Es el Pro activado a mano desde Operación: nunca pasó por el trial.
    expect(estadoComercial({ plan: 'premium', trial_estado: null })).toBe('pro_pagado');
  });

  it('trial_estado activo con plan free NO es prueba: es el muro', () => {
    // La desincronización real que produjo la migración 054 (checkPremiumExpiry le bajó el
    // plan y le dejó el estado en 'activo'). Mirar una sola columna pintaba el banner de
    // prueba encima del paywall. Acá tiene que ganar el plan, que es lo que de verdad
    // entrega o niega el producto.
    expect(estadoComercial({ plan: 'free', trial_estado: 'activo' })).toBe('sin_estrenar');
  });

  it('countByEstado reparte sin perder a nadie', () => {
    const users = CASOS.map(([, u]) => u);
    const counts = countByEstado(users);
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(users.length);
    expect(counts.trial).toBe(1);
    expect(counts.pro_pagado).toBe(1);
  });
});

describe('diasHastaFinTrial / isTrialExpiringSoon', () => {
  const HOY = '2026-08-27';
  const enPrueba = (vence: string) => ({ plan: 'premium', trial_estado: 'activo', trial_vence: vence });

  it('cuenta los días en fecha Lima', () => {
    expect(diasHastaFinTrial(enPrueba('2026-08-31'), HOY)).toBe(4);
    expect(diasHastaFinTrial(enPrueba('2026-08-27'), HOY)).toBe(0);
  });

  it('una prueba ya pasada da 0, no negativo', () => {
    expect(diasHastaFinTrial(enPrueba('2026-08-20'), HOY)).toBe(0);
  });

  it('null para quien no está en prueba', () => {
    expect(diasHastaFinTrial({ plan: 'premium', trial_estado: 'convertido', trial_vence: '2026-08-31' }, HOY))
      .toBeNull();
    expect(diasHastaFinTrial({ plan: 'free', trial_estado: 'vencido', trial_vence: '2026-08-20' }, HOY))
      .toBeNull();
  });

  it('atrapa al pelotón que daysUntilProExpiry deja invisible', () => {
    // ESTA es la regresión que el panel tenía el 27-ago-2026: 16 pruebas venciendo el 31 y
    // la única alerta de vencimientos vacía. `premium_vence` es NULL durante el trial a
    // propósito, así que el detector de Pro pagado no puede verlas — y por eso hacen falta
    // los dos. Si alguien "simplifica" esto a una sola función, este test muere.
    const u = { plan: 'premium', trial_estado: 'activo', trial_vence: '2026-08-31', premium_vence: null };
    expect(daysUntilProExpiry(u, new Date(HOY + 'T12:00:00-05:00').getTime())).toBeNull();
    expect(isTrialExpiringSoon(u, 5, HOY)).toBe(true);
  });

  it('no marca la prueba que todavía tiene aire', () => {
    expect(isTrialExpiringSoon(enPrueba('2026-09-09'), 5, HOY)).toBe(false);
  });
});
