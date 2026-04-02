import { describe, it, expect, vi, beforeEach } from 'vitest';

// Shared mock reference
const mockCreate = vi.fn();

// Mock lib/ai directly — parsers.js imports openai from here, not from 'openai' package
vi.mock('../../lib/ai', () => ({
  openai: { chat: { completions: { create: mockCreate } } }
}));

// Mock Supabase
vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    from: vi.fn(() => ({
      select: vi.fn().mockReturnThis(),
      insert: vi.fn().mockReturnThis(),
      update: vi.fn().mockReturnThis(),
      delete: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: null }),
      order: vi.fn().mockReturnThis(),
      range: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      gte: vi.fn().mockReturnThis(),
      not: vi.fn().mockReturnThis(),
    }))
  }))
}));

// Mock gmail
vi.mock('../../gmail', () => ({
  generarUrlAutorizacion: vi.fn(),
  guardarTokens: vi.fn(),
  leerCorreosBancarios: vi.fn(),
  oauth2Client: {},
  obtenerPerfilGoogle: vi.fn(),
  obtenerCuentasGmail: vi.fn(),
}));

vi.mock('dotenv', () => ({ config: vi.fn() }));

const { parsearCorreoBancario } = await import('../../index.js');

// ═══════════════════════════════════════════════════
// Tests: parsearCorreoBancario
// ═══════════════════════════════════════════════════
describe('parsearCorreoBancario', () => {
  beforeEach(() => {
    mockCreate.mockReset();
  });

  it('parsea notificación BCP débito correctamente', async () => {
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({
        tipo: 'gasto', monto: 45.50, moneda: 'PEN',
        comercio: 'Plaza Vea', categoria: 'Alimentación',
        subcategoria: 'supermercado', banco: 'BCP',
        metodo_pago: 'Debito', fecha: '2026-03-21',
        descripcion_original: 'Consumo con TD en SPSA PLAZA VEA'
      })}}]
    });

    const result = await parsearCorreoBancario(
      'Consumo con TD en SPSA PLAZA VEA por S/ 45.50 el 21/03/2026',
      'BCP - Alerta de consumo'
    );

    expect(result.tipo).toBe('gasto');
    expect(result.monto).toBe(45.50);
    expect(result.moneda).toBe('PEN');
    expect(result.comercio).toBe('Plaza Vea');
    expect(result.categoria).toBe('Alimentación');
    expect(result.subcategoria).toBe('supermercado');
    expect(result.banco).toBe('BCP');
  });

  it('parsea notificación BBVA con USD', async () => {
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({
        tipo: 'gasto', monto: 15.99, moneda: 'USD',
        comercio: 'Netflix', categoria: 'Entretenimiento',
        subcategoria: 'suscripciones', banco: 'BBVA',
        metodo_pago: 'Credito', fecha: '2026-03-20',
        descripcion_original: 'DLOCAL*NETFLIX por $15.99'
      })}}]
    });

    const result = await parsearCorreoBancario(
      'Se realizó un consumo con tu TC BBVA por $15.99 en DLOCAL*NETFLIX',
      'BBVA - Consumo con tarjeta'
    );

    expect(result.moneda).toBe('USD');
    expect(result.monto).toBe(15.99);
    expect(result.comercio).toBe('Netflix');
    expect(result.subcategoria).toBe('suscripciones');
  });

  it('parsea notificación Yape', async () => {
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({
        tipo: 'gasto', monto: 25.00, moneda: 'PEN',
        comercio: 'Juan Perez', categoria: 'Otros',
        subcategoria: 'sin_categoria', banco: 'Yape',
        metodo_pago: 'Yape', fecha: '2026-03-21',
        descripcion_original: 'Yapaste S/ 25.00 a Juan Perez'
      })}}]
    });

    const result = await parsearCorreoBancario(
      'Yapaste S/ 25.00 a Juan Perez el 21/03/2026',
      'Yape - Transferencia realizada'
    );

    expect(result.banco).toBe('Yape');
    expect(result.metodo_pago).toBe('Yape');
    expect(result.monto).toBe(25);
  });

  it('parsea notificación Interbank', async () => {
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({
        tipo: 'gasto', monto: 120.00, moneda: 'PEN',
        comercio: 'Luz del Sur', categoria: 'Vivienda',
        subcategoria: 'electricidad', banco: 'Interbank',
        metodo_pago: 'Debito', fecha: '2026-03-15',
        descripcion_original: 'Pago de servicio Luz del Sur'
      })}}]
    });

    const result = await parsearCorreoBancario(
      'Pago de servicio: Empresa: Luz del Sur, Monto: S/ 120.00',
      'Interbank - Pago de servicio'
    );

    expect(result.categoria).toBe('Vivienda');
    expect(result.subcategoria).toBe('electricidad');
  });

  it('maneja respuesta con markdown wrapping', async () => {
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: '```json\n{"tipo":"gasto","monto":30,"moneda":"PEN","comercio":"Taxi","categoria":"Transporte","subcategoria":"taxi","banco":"BCP","metodo_pago":"Debito","fecha":"2026-03-21","descripcion_original":"taxi"}\n```' }}]
    });

    const result = await parsearCorreoBancario('consumo taxi S/30', '');
    expect(result.monto).toBe(30);
    expect(result.categoria).toBe('Transporte');
  });

  it('retorna todos los campos requeridos', async () => {
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({
        tipo: 'gasto', monto: 50, moneda: 'PEN',
        comercio: 'Test', categoria: 'Otros',
        subcategoria: 'sin_categoria', banco: 'BCP',
        metodo_pago: 'Debito', fecha: '2026-03-21',
        descripcion_original: 'test'
      })}}]
    });

    const result = await parsearCorreoBancario('test', '');
    const campos = ['tipo', 'monto', 'moneda', 'comercio', 'categoria', 'subcategoria', 'banco', 'metodo_pago', 'fecha'];
    for (const campo of campos) {
      expect(result).toHaveProperty(campo);
    }
  });
});
