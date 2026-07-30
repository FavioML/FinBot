import { describe, it, expect } from 'vitest';
import {
  classifyUser,
  countBySegment,
  daysUntilProExpiry,
  isProExpiringSoon,
  POWER_TX_THRESHOLD,
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
