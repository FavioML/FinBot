import { describe, it, expect, beforeEach } from 'vitest';

// Reuse the global OpenAI mock from tests/setup.js.
const mockCreate = globalThis.__mockOpenAICreate;

const { parsearRegistroManual } = await import('../../services/parsers.js');

describe('parsearRegistroManual — extracción de monto en prosa larga (str-003)', () => {
  beforeEach(() => mockCreate.mockReset());

  it('respeta el monto que devuelve el modelo (no toma el primer número del mensaje)', async () => {
    // Long-prose scenario: the user writes a 400-char story that mentions
    // several numbers but the actual amount, written out in Spanish, is "75".
    // We assert that the parser surfaces the monto the model returns —
    // i.e. the contract is "the model decides", not "the parser regexes the
    // first number it sees".
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({
        ok: true, tipo: 'gasto', monto: 75, moneda: 'PEN',
        comercio: 'almuerzo', categoria: 'Alimentación',
        subcategoria: 'restaurante', fecha: '2026-05-06',
      }) } }],
    });
    const longMsg = 'Hoy salí a las 8 de la mañana, tomé el bus 30 minutos y al final '
      + 'fui a almorzar con 3 amigos. Me cobraron setenta y cinco soles por el plato. '
      + 'Estoy cansado pero contento.';
    const r = await parsearRegistroManual(longMsg, '2026-05-06');
    expect(r.ok).toBe(true);
    expect(r.monto).toBe(75);
  });

  it('system prompt instruye sobre números escritos en letras y desambiguación', async () => {
    // Captures the actual prompt the parser sends to OpenAI, so we can
    // assert the rule that prevents "first number wins" is present.
    let capturedPrompt = '';
    mockCreate.mockImplementation(async (args) => {
      const sys = (args?.messages || []).find(m => m.role === 'system');
      capturedPrompt = sys ? sys.content : '';
      return { choices: [{ message: { content: JSON.stringify({ ok: true, monto: 1, moneda: 'PEN', tipo: 'gasto' }) } }] };
    });
    await parsearRegistroManual('test', '2026-05-06');
    // Rule: never take the first number — pick the one adjacent to currency/verb.
    expect(capturedPrompt.toLowerCase()).toContain('primer número');
    // Rule: convert spelled-out Spanish numbers.
    expect(capturedPrompt.toLowerCase()).toMatch(/setenta y cinco|letras/);
  });
});
