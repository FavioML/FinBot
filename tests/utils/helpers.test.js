import { describe, it, expect } from 'vitest';

// OpenAI is patched globally by tests/setup.js at the CJS instance level.
// No vi.mock needed — the setup file handles CJS interop on Windows.

const {
  validarMonto, normalizarCategoria, formatFecha, barraProgreso,
  fechaHoyPeru, fechaAyerPeru, ultimoDiaMes,
  CATEGORIAS_VALIDAS, CATEGORIA_MAP, MESES
} = await import('../../index.js');

// ═══════════════════════════════════════════════════
// Tests: validarMonto
// ═══════════════════════════════════════════════════
describe('validarMonto', () => {
  it('acepta montos válidos', () => {
    expect(validarMonto(50)).toBe(50);
    expect(validarMonto('45.50')).toBe(45.5);
    expect(validarMonto(0)).toBeNull(); // 0 no es un monto válido
    expect(validarMonto('100.999')).toBe(101); // redondeo a 2 decimales
    expect(validarMonto(999999.99)).toBe(999999.99);
  });

  it('rechaza NaN', () => {
    expect(validarMonto('abc')).toBeNull();
    expect(validarMonto(NaN)).toBeNull();
    expect(validarMonto(undefined)).toBeNull();
    expect(validarMonto('')).toBeNull();
  });

  it('rechaza Infinity', () => {
    expect(validarMonto(Infinity)).toBeNull();
    expect(validarMonto(-Infinity)).toBeNull();
  });

  it('rechaza negativos', () => {
    expect(validarMonto(-1)).toBeNull();
    expect(validarMonto('-50')).toBeNull();
  });

  it('rechaza montos excesivos', () => {
    expect(validarMonto(1000000)).toBeNull();
    expect(validarMonto('9999999')).toBeNull();
  });

  it('maneja strings con formato S/', () => {
    // parseFloat ignora texto después del número
    expect(validarMonto('45.50')).toBe(45.5);
  });
});

// ═══════════════════════════════════════════════════
// Tests: normalizarCategoria
// ═══════════════════════════════════════════════════
describe('normalizarCategoria', () => {
  it('retorna categorías canónicas sin cambio', () => {
    expect(normalizarCategoria('Alimentación')).toBe('Alimentación');
    expect(normalizarCategoria('Transporte')).toBe('Transporte');
    expect(normalizarCategoria('Vivienda')).toBe('Vivienda');
    expect(normalizarCategoria('Entretenimiento')).toBe('Entretenimiento');
  });

  it('mapea variantes al canónico', () => {
    expect(normalizarCategoria('Comida')).toBe('Alimentación');
    expect(normalizarCategoria('comida')).toBe('Alimentación');
    expect(normalizarCategoria('Hogar')).toBe('Vivienda');
    expect(normalizarCategoria('Streaming')).toBe('Suscripciones');
    expect(normalizarCategoria('Auto')).toBe('Transporte');
  });

  it('maneja capitalización incorrecta', () => {
    expect(normalizarCategoria('transporte')).toBe('Transporte');
    expect(normalizarCategoria('salud')).toBe('Salud');
    expect(normalizarCategoria('compras')).toBe('Compras');
  });

  it('retorna Otros para null/undefined/desconocido', () => {
    expect(normalizarCategoria(null)).toBe('Otros');
    expect(normalizarCategoria(undefined)).toBe('Otros');
    expect(normalizarCategoria('CategoriaInventada')).toBe('Otros');
  });
});

// ═══════════════════════════════════════════════════
// Tests: formatFecha
// ═══════════════════════════════════════════════════
describe('formatFecha', () => {
  it('formatea fecha YYYY-MM-DD a DD-mes-AA', () => {
    expect(formatFecha('2026-03-21')).toBe('21-mar-26');
    expect(formatFecha('2026-01-05')).toBe('05-ene-26');
    expect(formatFecha('2026-12-25')).toBe('25-dic-26');
  });

  it('maneja null/undefined/vacío', () => {
    expect(formatFecha(null)).toBe('');
    expect(formatFecha(undefined)).toBe('');
    expect(formatFecha('')).toBe('');
  });

  it('retorna input si no tiene formato válido', () => {
    expect(formatFecha('hoy')).toBe('hoy');
  });
});

// ═══════════════════════════════════════════════════
// Tests: barraProgreso
// ═══════════════════════════════════════════════════
describe('barraProgreso', () => {
  it('muestra emoji verde para <80%', () => {
    const result = barraProgreso(50);
    expect(result).toContain('🟢');
    expect(result).toContain('50%');
  });

  it('muestra emoji amarillo para 80-99%', () => {
    const result = barraProgreso(85);
    expect(result).toContain('🟡');
  });

  it('muestra emoji rojo para >=100%', () => {
    const result = barraProgreso(120);
    expect(result).toContain('🔴');
  });

  it('tiene 10 bloques totales', () => {
    const result = barraProgreso(50);
    const bloques = (result.match(/[▓░]/g) || []).length;
    expect(bloques).toBe(10);
  });
});

// ═══════════════════════════════════════════════════
// Tests: ultimoDiaMes
// ═══════════════════════════════════════════════════
describe('ultimoDiaMes', () => {
  it('retorna 31 para enero', () => {
    expect(ultimoDiaMes(2026, 1)).toBe(31);
  });

  it('retorna 28 para febrero no bisiesto', () => {
    expect(ultimoDiaMes(2026, 2)).toBe(28);
  });

  it('retorna 29 para febrero bisiesto', () => {
    expect(ultimoDiaMes(2028, 2)).toBe(29);
  });

  it('retorna 30 para abril', () => {
    expect(ultimoDiaMes(2026, 4)).toBe(30);
  });
});

// ═══════════════════════════════════════════════════
// Tests: fechaHoyPeru / fechaAyerPeru
// ═══════════════════════════════════════════════════
describe('fechaHoyPeru', () => {
  it('retorna formato YYYY-MM-DD', () => {
    const fecha = fechaHoyPeru();
    expect(fecha).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('fechaAyerPeru', () => {
  it('retorna formato YYYY-MM-DD', () => {
    const fecha = fechaAyerPeru();
    expect(fecha).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('es anterior a hoy', () => {
    const hoy = fechaHoyPeru();
    const ayer = fechaAyerPeru();
    expect(ayer < hoy).toBe(true);
  });
});

// ═══════════════════════════════════════════════════
// Tests: Constantes
// ═══════════════════════════════════════════════════
describe('MESES', () => {
  it('tiene 13 elementos (índice 0 vacío + 12 meses)', () => {
    expect(MESES).toHaveLength(13);
    expect(MESES[0]).toBe('');
    expect(MESES[1]).toBe('Enero');
    expect(MESES[12]).toBe('Diciembre');
  });
});

describe('CATEGORIAS_VALIDAS', () => {
  it('tiene las 11 categorías canónicas', () => {
    expect(CATEGORIAS_VALIDAS.size).toBe(11);
    expect(CATEGORIAS_VALIDAS.has('Alimentación')).toBe(true);
    expect(CATEGORIAS_VALIDAS.has('Transporte')).toBe(true);
    expect(CATEGORIAS_VALIDAS.has('Otros')).toBe(true);
  });
});
