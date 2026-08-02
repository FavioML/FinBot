import { describe, it, expect } from 'vitest';
import { isRevenueUser, computeRevenue, esProPagado } from './admin-revenue';
import { PRO_PRICE_MONTHLY_PEN, PRO_PRICE_YEARLY_PEN } from './constants';

/**
 * Quién entra al MRR. Es la métrica con la que se decide si el producto funciona, así que el
 * modo de falla que importa no es un crash: es un número creíble y falso.
 *
 * Pasó el 2026-08-02. `isRevenueUser` excluía cuentas internas por una lista de números de
 * WhatsApp, y dos cuentas de prueba con `plan: 'premium'` (un seed de demo web-first, sin
 * número que listar, y un QA nuevo que nadie agregó a la lista) sumaban S/20 sobre ~S/56 de
 * MRR real. El panel exageraba un tercio y no había forma de notarlo mirándolo.
 */
const base = { plan: 'premium', tipo_plan: 'mensual', trial_estado: 'convertido' };

describe('isRevenueUser', () => {
  it('una cuenta de prueba nunca es ingreso, aunque no tenga whatsapp que listar', () => {
    // El caso exacto que se coló: seed de demo web-first, premium, sin número.
    expect(isRevenueUser({ whatsapp: null, is_test_user: true })).toBe(false);
  });

  it('una cuenta de prueba con número tampoco, aunque no esté en la lista', () => {
    // El otro caso: QA nuevo (…9996) mientras la lista solo tenía …9997.
    expect(isRevenueUser({ whatsapp: '51999999996', is_test_user: true })).toBe(false);
  });

  it('el fundador sigue excluido por lista (no está marcado como test)', () => {
    expect(isRevenueUser({ whatsapp: '51970398192', is_test_user: false })).toBe(false);
  });

  it('un cliente web-first (sin whatsapp) SÍ es negocio real', () => {
    // La regla no puede volverse "sin número no cuenta": el alta web-first es el camino nuevo.
    expect(isRevenueUser({ whatsapp: null })).toBe(true);
    expect(isRevenueUser({ whatsapp: null, is_test_user: null })).toBe(true);
  });

  it('un cliente normal con número cuenta', () => {
    expect(isRevenueUser({ whatsapp: '51987654321' })).toBe(true);
  });
});

describe('computeRevenue', () => {
  it('no factura las cuentas de prueba', () => {
    const rev = computeRevenue([
      { ...base, whatsapp: '51987654321' },
      { ...base, whatsapp: null, is_test_user: true },
      { ...base, whatsapp: '51999999996', is_test_user: true },
    ]);
    expect(rev.proCount).toBe(1);
    expect(rev.mrr).toBe(PRO_PRICE_MONTHLY_PEN);
  });

  it('un trial activo entrega Pro pero no factura', () => {
    const rev = computeRevenue([
      { ...base, whatsapp: '51987654321', trial_estado: 'activo' },
      { ...base, whatsapp: '51987654322' },
    ]);
    expect(rev.proCount).toBe(1);
    expect(rev.mrr).toBe(PRO_PRICE_MONTHLY_PEN);
  });

  it('el anual se normaliza a mensual (precio/12)', () => {
    const rev = computeRevenue([{ ...base, tipo_plan: 'anual', whatsapp: '51987654321' }]);
    expect(rev.proYearly).toBe(1);
    expect(rev.mrr).toBeCloseTo(PRO_PRICE_YEARLY_PEN / 12, 2);
  });
});

describe('esProPagado', () => {
  it('premium + trial activo NO paga; premium + convertido sí', () => {
    expect(esProPagado({ plan: 'premium', tipo_plan: 'mensual', trial_estado: 'activo' })).toBe(false);
    expect(esProPagado({ plan: 'premium', tipo_plan: 'mensual', trial_estado: 'convertido' })).toBe(true);
    expect(esProPagado({ plan: 'free', tipo_plan: 'mensual', trial_estado: 'vencido' })).toBe(false);
  });
});
