import { describe, it, expect, vi } from 'vitest';

// Mock at the dependency level
vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    from: vi.fn(() => ({
      select: vi.fn().mockReturnThis(),
      insert: vi.fn().mockReturnThis(),
      update: vi.fn().mockReturnThis(),
      upsert: vi.fn().mockReturnThis(),
      delete: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      ilike: vi.fn().mockReturnThis(),
      gte: vi.fn().mockReturnThis(),
      lte: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: null }),
      is: vi.fn().mockReturnThis(),
      neq: vi.fn().mockReturnThis(),
      not: vi.fn().mockReturnThis(),
    }))
  }))
}));

vi.mock('dotenv', () => ({ config: vi.fn() }));

const { necesitaConsulta, mensajeConsulta } = await import('../../services/transactions.js');

describe('necesitaConsulta', () => {
  it('retorna false para ingresos', () => {
    expect(necesitaConsulta({ tipo: 'ingreso', comercio: 'Yape', categoria: 'Otros' })).toBe(false);
  });

  it('retorna true para Yape genérico', () => {
    expect(necesitaConsulta({ tipo: 'gasto', comercio: 'Yape', categoria: 'Otros' })).toBe(true);
  });

  it('retorna true para Plin genérico', () => {
    expect(necesitaConsulta({ tipo: 'gasto', comercio: 'Plin', categoria: 'Otros' })).toBe(true);
  });

  it('retorna true para transferencia BCP sin categoría clara', () => {
    expect(necesitaConsulta({ tipo: 'gasto', comercio: 'BCP', categoria: 'Otros' })).toBe(true);
  });

  it('retorna false para gasto con comercio y categoría claros', () => {
    expect(necesitaConsulta({ tipo: 'gasto', comercio: 'Plaza Vea', categoria: 'Alimentación' })).toBe(false);
  });

  it('retorna false para null/undefined', () => {
    expect(necesitaConsulta(null)).toBe(false);
    expect(necesitaConsulta(undefined)).toBe(false);
  });

  it('retorna truthy para categoría Transferencia con comercio', () => {
    expect(necesitaConsulta({ tipo: 'gasto', comercio: 'Juan Perez', categoria: 'Transferencia' })).toBeTruthy();
  });

  it('retorna falsy sin comercio', () => {
    expect(necesitaConsulta({ tipo: 'gasto', comercio: null, categoria: 'Otros' })).toBeFalsy();
  });
});

describe('mensajeConsulta', () => {
  it('genera mensaje con monto y banco', () => {
    const msg = mensajeConsulta({ monto: 45.5, banco: 'BCP', fecha: '2026-03-21' });
    expect(msg).toContain('45.50');
    expect(msg).toContain('BCP');
    expect(msg).toContain('2026-03-21');
  });

  it('usa comercio como fallback si no hay banco', () => {
    const msg = mensajeConsulta({ monto: 20, comercio: 'Yape', fecha: '2026-03-21' });
    expect(msg).toContain('Yape');
  });

  it('maneja monto undefined', () => {
    const msg = mensajeConsulta({ banco: 'Test' });
    expect(msg).toContain('0.00');
  });

  it('incluye pregunta al usuario', () => {
    const msg = mensajeConsulta({ monto: 10, banco: 'Test', fecha: '2026-03-21' });
    expect(msg).toContain('Para qué fue');
  });
});
