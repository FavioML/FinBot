import { describe, it, expect, vi, beforeEach } from 'vitest';

// Regresión (2026-07-21): `timeout: 30000` viajaba DENTRO del body de chat.completions.create.
// El SDK v6 lo manda tal cual al endpoint, que responde 400 "Unrecognized request argument
// supplied: timeout". redactarConNETO devolvía null en el 100% de los casos y cada handler
// caía a su texto fijo: la redacción con IA de NETO nunca corrió en producción.
// tests/setup.js ya parchea `openai.chat.completions.create` sobre la instancia compartida
// de lib/ai (CJS), que es la misma que ve neto-gpt.js. Se usa ese mock, no uno nuevo.
import { createRequire } from 'module';
const { redactarConNETO } = createRequire(import.meta.url)('../../services/neto-gpt.js');
const create = globalThis.__mockOpenAICreate;

beforeEach(() => {
  create.mockReset();
  create.mockResolvedValue({ choices: [{ message: { content: '  Listo, Netflix quedó en streaming.  ' } }] });
});

describe('redactarConNETO', () => {
  it('manda timeout como request option, nunca dentro del body', async () => {
    await redactarConNETO('SYSTEM', 'contexto', 'hola', []);
    const [body, options] = create.mock.calls[0];
    expect(body).not.toHaveProperty('timeout');
    expect(options).toEqual(expect.objectContaining({ timeout: expect.any(Number) }));
  });

  it('el body solo lleva parámetros que el API reconoce', async () => {
    await redactarConNETO('SYSTEM', 'contexto', 'hola', []);
    const [body] = create.mock.calls[0];
    const permitidos = ['model', 'max_tokens', 'temperature', 'messages'];
    expect(Object.keys(body).filter(k => !permitidos.includes(k))).toEqual([]);
  });

  it('pasa el system prompt de NETO como primer mensaje y devuelve el texto limpio', async () => {
    const r = await redactarConNETO('SYSTEM DE NETO', 'ctx', 'cambia netflix', [
      { rol: 'usuario', mensaje: 'hola' }, { rol: 'neto', mensaje: 'qué tal' },
    ]);
    const [body] = create.mock.calls[0];
    expect(body.messages[0]).toEqual({ role: 'system', content: 'SYSTEM DE NETO' });
    expect(body.messages[1]).toEqual({ role: 'user', content: 'hola' });
    expect(body.messages[2]).toEqual({ role: 'assistant', content: 'qué tal' });
    expect(r).toBe('Listo, Netflix quedó en streaming.');
  });

  it('devuelve null si OpenAI falla (los handlers caen a su texto fijo)', async () => {
    create.mockRejectedValue(new Error('400 Unrecognized request argument supplied: timeout'));
    expect(await redactarConNETO('SYSTEM', 'ctx', 'hola', [])).toBeNull();
  });
});
