import { describe, it, expect, vi } from 'vitest';

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    from: vi.fn(() => ({
      select: vi.fn().mockReturnThis(),
      insert: vi.fn().mockReturnThis(),
      update: vi.fn().mockReturnThis(),
      upsert: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      is: vi.fn().mockReturnThis(),
      gte: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: null }),
    }))
  }))
}));

vi.mock('dotenv', () => ({ config: vi.fn() }));

const budget = await import('../../services/budget.js');

describe('services/budget exports', () => {
  it('exporta guardarPresupuesto', () => {
    expect(typeof budget.guardarPresupuesto).toBe('function');
  });

  it('exporta obtenerPresupuestosMes', () => {
    expect(typeof budget.obtenerPresupuestosMes).toBe('function');
  });

  it('exporta verificarAlertaPresupuesto', () => {
    expect(typeof budget.verificarAlertaPresupuesto).toBe('function');
  });

  it('exporta formatearEstadoPresupuesto', () => {
    expect(typeof budget.formatearEstadoPresupuesto).toBe('function');
  });
});
