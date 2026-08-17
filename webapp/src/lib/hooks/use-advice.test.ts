import { describe, it, expect } from 'vitest';
import { adviceQueryKey, ADVICE_STALE_TIME, type AdviceContext } from './use-advice';

const base: AdviceContext = {
  totalGastos: 1234,
  totalIngresos: 2000,
  topCategorias: 'Alimentación (40%), Transporte (30%)',
  scoreFinanciero: 58,
  subscriptionTotal: 45,
};

describe('adviceQueryKey', () => {
  it('es estable entre montajes con el mismo contexto', () => {
    // Este es el invariante que evita pagar otra llamada a OpenAI por montar el
    // componente de nuevo. Si la key llevara algo del montaje (un id, un
    // Date.now(), un contador), este test muere.
    expect(adviceQueryKey({ ...base })).toEqual(adviceQueryKey({ ...base }));
  });

  it('no depende del ORDEN ni de la identidad del objeto', () => {
    const otroObjeto: AdviceContext = {
      subscriptionTotal: 45,
      scoreFinanciero: 58,
      topCategorias: 'Alimentación (40%), Transporte (30%)',
      totalIngresos: 2000,
      totalGastos: 1234,
    };
    expect(adviceQueryKey(otroObjeto)).toEqual(adviceQueryKey(base));
  });

  it('cambia cuando cambia el prompt, porque ahí el consejo SÍ es otro', () => {
    // Mensual y anual traen totales distintos: son consejos legítimamente
    // distintos y deben tener entradas de cache separadas, no compartir una.
    expect(adviceQueryKey({ ...base, totalGastos: 9999 })).not.toEqual(adviceQueryKey(base));
    expect(adviceQueryKey({ ...base, totalIngresos: 1 })).not.toEqual(adviceQueryKey(base));
    expect(adviceQueryKey({ ...base, scoreFinanciero: 12 })).not.toEqual(adviceQueryKey(base));
    expect(adviceQueryKey({ ...base, topCategorias: 'Otros (100%)' })).not.toEqual(adviceQueryKey(base));
    expect(adviceQueryKey({ ...base, subscriptionTotal: 999 })).not.toEqual(adviceQueryKey(base));
  });

  it('trata un subscriptionTotal ausente igual que cero', () => {
    const { subscriptionTotal: _omitido, ...sinSubs } = base;
    expect(adviceQueryKey(sinSubs)).toEqual(adviceQueryKey({ ...base, subscriptionTotal: 0 }));
  });

  it('ignora diferencias que el prompt del servidor redondea igual', () => {
    // `/api/advice` hace Math.round sobre los montos antes de armar el prompt,
    // así que dos contextos que difieren en centavos producen EL MISMO consejo.
    // Si la key no redondeara, un recálculo de decimales dispararía una llamada
    // nueva para un prompt idéntico.
    expect(adviceQueryKey({ ...base, totalGastos: 1234.4 })).toEqual(adviceQueryKey(base));
  });

  it('el staleTime cubre una sesión de dashboard entera', () => {
    // Con el default de 5min del QueryClient, volver al dashboard después de
    // mirar transacciones un rato ya pagaba otra llamada.
    expect(ADVICE_STALE_TIME).toBeGreaterThanOrEqual(1000 * 60 * 15);
  });
});
