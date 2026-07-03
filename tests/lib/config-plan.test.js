import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { detectarTipoPlan, resolverTipoPlan } = require('../../lib/config');

describe('detectarTipoPlan', () => {
  it('deduce anual con el monto del plan anual (S/99)', () => {
    expect(detectarTipoPlan(99)).toBe('anual');
    expect(detectarTipoPlan('99.00')).toBe('anual');
  });
  it('deduce mensual con el monto del plan mensual (S/10)', () => {
    expect(detectarTipoPlan(10)).toBe('mensual');
  });
  it('cae a mensual si el monto no es un precio conocido o es inválido', () => {
    expect(detectarTipoPlan(45)).toBe('mensual');
    expect(detectarTipoPlan(null)).toBe('mensual');
    expect(detectarTipoPlan('x')).toBe('mensual');
  });
});

describe('resolverTipoPlan', () => {
  it('el monto detectado manda sobre el tipo_plan guardado (bug Juan/Diego)', () => {
    // Usuario venía marcado "mensual" pero pagó el anual: debe resolver "anual".
    expect(resolverTipoPlan(99, 'mensual')).toBe('anual');
  });
  it('detecta mensual aunque el guardado diga anual', () => {
    expect(resolverTipoPlan(10, 'anual')).toBe('mensual');
  });
  it('sin monto detectable, usa el tipo_plan guardado', () => {
    expect(resolverTipoPlan(null, 'anual')).toBe('anual');
    expect(resolverTipoPlan(undefined, 'mensual')).toBe('mensual');
  });
  it('sin monto ni guardado, default mensual (opción segura, la más barata)', () => {
    expect(resolverTipoPlan(null, null)).toBe('mensual');
  });
});
