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

const { DEDUP_WINDOW_MS } = await import('../../services/transactions.js');

// Nota: los tests de necesitaConsulta/mensajeConsulta se eliminaron junto con el flujo
// de consultas pendientes (el bot ya no pide categorizar por WhatsApp; la categoria se
// revisa y ajusta en app.neto.pe).

describe('dedup window (str-001/002)', () => {
  it('uses a short dedup window (≤30s) so rapid manual entries are not collapsed', () => {
    // Was 5min (300_000ms); legitimate rapid entries collided into one row.
    // Webhook double-fires retry within seconds, so a much shorter window suffices.
    expect(DEDUP_WINDOW_MS).toBeLessThanOrEqual(30 * 1000);
    expect(DEDUP_WINDOW_MS).toBeGreaterThan(0);
  });
});
