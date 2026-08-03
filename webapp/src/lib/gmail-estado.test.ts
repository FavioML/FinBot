import { describe, it, expect } from 'vitest';
import { estadoGmail, puedeAccionar } from './gmail-estado';

/**
 * El bug que esto cierra: "conectado" y "sano" eran la misma cosa. Cuando Google revocaba el
 * token la fila quedaba en activa=true, así que la app decía "Gmail conectado ✓" mientras no
 * leía un solo correo — y el enlace de reconexión tenía que estar SIEMPRE visible porque no
 * había forma de saber cuándo hacía falta.
 */
describe('estadoGmail', () => {
  it('conectado y sano: no hay nada roto que avisar', () => {
    expect(estadoGmail({ conectado: true, necesitaReconexion: false, proPagado: true })).toBe('sano');
  });

  it('conectado pero con el token muerto es un estado PROPIO, no "desconectado"', () => {
    // Si esto devolviera 'sin-conectar', la fila seguiría en activa=true y le ofreceríamos
    // "conectar" a quien ya tiene el cupo gastado. Si devolviera 'sano', volvemos al bug.
    expect(estadoGmail({ conectado: true, necesitaReconexion: true, proPagado: true })).toBe('caido');
  });

  it('caído gana sobre sano: el orden inverso deja el estado roto inalcanzable', () => {
    const caido = estadoGmail({ conectado: true, necesitaReconexion: true, proPagado: true });
    const sano = estadoGmail({ conectado: true, necesitaReconexion: false, proPagado: true });
    expect(caido).not.toBe(sano);
  });

  it('paga y no conectó: puede conectar', () => {
    expect(estadoGmail({ conectado: false, necesitaReconexion: false, proPagado: true })).toBe('sin-conectar');
  });

  it('no paga y no tiene nada: bloqueado (conectar exige Pro PAGADO, no trial)', () => {
    expect(estadoGmail({ conectado: false, necesitaReconexion: false, proPagado: false })).toBe('bloqueado');
  });

  it('el borde real: dejó de pagar con la cuenta ya caída sigue siendo "caido"', () => {
    // Su cuenta existe y el cupo de Google está gastado. Decirle "bloqueado" (como si nunca
    // hubiera conectado) le escondería POR QUÉ Neto dejó de anotarle los gastos.
    expect(estadoGmail({ conectado: true, necesitaReconexion: true, proPagado: false })).toBe('caido');
  });
});

describe('puedeAccionar', () => {
  it('el estado sano NO ofrece acción: un CTA bajo un "conectado ✓" lo contradice', () => {
    expect(puedeAccionar('sano', true)).toBe(false);
  });

  it('el estado caído sí, si paga: es el único caso donde reconectar tiene sentido', () => {
    expect(puedeAccionar('caido', true)).toBe(true);
  });

  it('caído sin pagar no ofrece botón: /pro/gmail-auth-url le responde 403', () => {
    expect(puedeAccionar('caido', false)).toBe(false);
  });

  it('bloqueado nunca acciona, ni aunque el flag de pago llegue en true', () => {
    expect(puedeAccionar('bloqueado', true)).toBe(false);
  });

  it('sin conectar acciona solo si paga', () => {
    expect(puedeAccionar('sin-conectar', true)).toBe(true);
    expect(puedeAccionar('sin-conectar', false)).toBe(false);
  });
});
