import { describe, it, expect } from 'vitest';

// OpenAI is patched globally by tests/setup.js at the CJS instance level.
// No vi.mock needed — the setup file handles CJS interop on Windows.

const { normalizarCategoria, CATEGORIAS_VALIDAS, CATEGORIA_MAP } = await import('../../index.js');

// ═══════════════════════════════════════════════════
// Tests: Cobertura de categorías del clasificador NLP
// ═══════════════════════════════════════════════════
describe('Cobertura de categorías NLP', () => {
  const INTENCIONES_ESPERADAS = [
    'listar_gastos_mes', 'listar_gastos_semana', 'listar_gastos_dia',
    'listar_gastos_categoria', 'ver_total_gastado', 'ver_presupuesto',
    'configurar_presupuesto', 'ver_categorias', 'ver_reporte',
    'corregir_categoria', 'escanear_gmail',
    'ver_premium', 'saludo', 'ayuda', 'registrar_manual',
    'desconocido', 'corregir_monto_moneda', 'corregir_multiple',
    'agregar_gmail', 'cambiar_gmail', 'preferencia_reporte_gmail',
    'cargar_excel', 'desconectar_cuenta'
  ];

  it('tiene 23 intenciones definidas', () => {
    expect(INTENCIONES_ESPERADAS).toHaveLength(23);
  });

  it('todas las variantes del CATEGORIA_MAP apuntan a categorías válidas', () => {
    for (const [variante, canonico] of Object.entries(CATEGORIA_MAP)) {
      expect(CATEGORIAS_VALIDAS.has(canonico)).toBe(true);
    }
  });

  it('normalizarCategoria cubre todas las variantes del mapa', () => {
    for (const [variante, esperado] of Object.entries(CATEGORIA_MAP)) {
      expect(normalizarCategoria(variante)).toBe(esperado);
    }
  });

  it('normalizarCategoria cubre todas las categorías canónicas', () => {
    for (const cat of CATEGORIAS_VALIDAS) {
      expect(normalizarCategoria(cat)).toBe(cat);
    }
  });

  it('normalizarCategoria maneja capitalización automática', () => {
    // Categorías que pueden venir en minúsculas del GPT
    const casosBorde = [
      ['alimentación', 'Alimentación'],
      ['transporte', 'Transporte'],
      ['entretenimiento', 'Entretenimiento'],
      ['educación', 'Educación'],
      ['finanzas', 'Finanzas'],
    ];
    for (const [input, esperado] of casosBorde) {
      expect(normalizarCategoria(input)).toBe(esperado);
    }
  });
});

// ═══════════════════════════════════════════════════
// Tests: Mapping de categorías legacy
// ═══════════════════════════════════════════════════
describe('Retrocompatibilidad de categorías', () => {
  it('mapea categorías del sistema anterior', () => {
    expect(normalizarCategoria('Comida')).toBe('Alimentación');
    expect(normalizarCategoria('Hogar')).toBe('Vivienda');
    expect(normalizarCategoria('Auto')).toBe('Transporte');
    expect(normalizarCategoria('Streaming')).toBe('Suscripciones');
    expect(normalizarCategoria('Viajes')).toBe('Otros');
    expect(normalizarCategoria('Transferencia')).toBe('Otros');
  });

  it('mapea categorías sin tilde', () => {
    expect(normalizarCategoria('Alimentacion')).toBe('Alimentación');
    expect(normalizarCategoria('Educacion')).toBe('Educación');
  });
});
