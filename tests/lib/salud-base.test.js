import { describe, it, expect } from 'vitest';
import { saludBase } from '../../lib/salud-base.js';

// Doble mínimo de supabase-js: `from().select().limit().abortSignal()` resuelve lo que diga `fin`.
function doble(fin) {
  const cadena = {
    select: () => cadena,
    limit: () => cadena,
    abortSignal: (signal) => fin(signal),
  };
  return { from: () => cadena };
}

describe('saludBase (/health?strict=1)', () => {
  it('ok cuando la lectura vuelve sin error', async () => {
    const r = await saludBase(doble(async () => ({ data: [{ id: 'x' }], error: null })));
    expect(r).toMatchObject({ ok: true, db: true });
  });

  // supabase-js no lanza: un 504 del gateway llega como { error }. Es el caso del 13-oct.
  it('no ok cuando la lectura devuelve error', async () => {
    const r = await saludBase(doble(async () => ({ data: null, error: { message: 'Gateway Timeout' } })));
    expect(r).toMatchObject({ ok: false, db: false, error: 'Gateway Timeout' });
  });

  it('no ok cuando la lectura lanza', async () => {
    const r = await saludBase(doble(async () => { throw new TypeError('fetch failed'); }));
    expect(r).toMatchObject({ ok: false, db: false, error: 'fetch failed' });
  });

  // Una consulta colgada no puede colgar el health: el tope la corta y sale no ok.
  it('no ok cuando la lectura pasa el tope', async () => {
    const colgada = (signal) => new Promise((_, rechazar) => {
      signal.addEventListener('abort', () => rechazar(signal.reason));
    });
    const r = await saludBase(doble(colgada), 50);
    expect(r.ok).toBe(false);
    expect(r.latencyMs).toBeLessThan(2000);
  });
});
