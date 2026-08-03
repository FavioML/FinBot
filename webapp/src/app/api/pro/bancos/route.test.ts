import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * La otra mitad de la lectura de correos: elegir de qué bancos leer.
 *
 * No consume cupo de Google por sí sola, pero cobra igual que conectar — sin Gmail conectado
 * no lee nada, así que dejarla abierta configuraba una lectura que nunca iba a ocurrir. El
 * punto fino es el mismo que en `gmail-auth-url`: durante el trial `plan` ya vale `'premium'`
 * (migración 052), así que un gate escrito como `plan === 'premium'` deja pasar al que prueba.
 * Por eso el caso trial se afirma explícitamente: es el único que distingue el gate correcto
 * del incorrecto.
 *
 * Esta ruta se quedó sin red cuando el guard de las puertas de OAuth
 * (`app/tests/gmail-oauth-gates.test.js`) cubrió los tres callsites del backend: el POST NO
 * pasa por Railway, escribe `usuarios.bancos_seleccionados` directo con service-role.
 */

const requireNetoUser = vi.fn();
const fetchMock = vi.fn();
const update = vi.fn();
const eq = vi.fn();

vi.mock('@/lib/supabase/auth', () => ({
  requireNetoUser: (...args: unknown[]) => requireNetoUser(...args),
}));

vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: () => true }));

vi.mock('@/lib/supabase/service', () => ({
  getServiceClient: () => ({ from: () => ({ update, eq }) }),
}));

vi.stubGlobal('fetch', fetchMock);
process.env.INTERNAL_API_KEY = 'test-key';

const { GET, POST } = await import('./route');

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true, bancos: [{ id: 'bcp', label: 'BCP' }] }) });
  eq.mockResolvedValue({ error: null });
  update.mockReturnValue({ eq });
});

function sesion(plan: string | null, trial_estado: string | null) {
  requireNetoUser.mockResolvedValue({ ok: true, user: { id: 'u1', plan, trial_estado }, authId: 'a1' });
}

function post(body: unknown) {
  return new Request('https://app.neto.pe/api/pro/bancos', { method: 'POST', body: JSON.stringify(body) });
}

/** Lo que se escribió en `bancos_seleccionados` en la última llamada. */
function guardado() {
  return update.mock.calls[0][0].bancos_seleccionados;
}

describe('GET /api/pro/bancos', () => {
  it('pide plan y trial_estado: una fila parcial decidiría con undefined y abriría el gate', async () => {
    sesion('premium', 'convertido');
    await GET();
    expect(requireNetoUser).toHaveBeenCalledWith(expect.stringContaining('trial_estado'));
    expect(requireNetoUser).toHaveBeenCalledWith(expect.stringContaining('plan'));
  });

  it('403 al usuario en trial, y sin llamar al backend', async () => {
    sesion('premium', 'activo');
    const res = await GET();
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({ motivo: 'pro_pagado_requerido' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('403 al usuario en el muro', async () => {
    sesion('free', 'vencido');
    expect((await GET()).status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // Sin este caso, un gate que niegue SIEMPRE se vería idéntico a uno bueno.
  it('deja pasar al Pro pagado y devuelve el catálogo del backend', async () => {
    sesion('premium', 'convertido');
    const res = await GET();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true, bancos: [{ id: 'bcp' }] });
  });
});

describe('POST /api/pro/bancos', () => {
  it('403 al usuario en trial, y sin escribir en la base', async () => {
    sesion('premium', 'activo');
    const res = await POST(post({ bancos: ['bcp'] }));
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({ motivo: 'pro_pagado_requerido' });
    expect(update).not.toHaveBeenCalled();
  });

  it('403 al usuario en el muro, y sin escribir en la base', async () => {
    sesion('free', 'vencido');
    expect((await POST(post({ bancos: ['bcp'] }))).status).toBe(403);
    expect(update).not.toHaveBeenCalled();
  });

  it('el Pro pagado guarda su selección', async () => {
    sesion('premium', 'convertido');
    const res = await POST(post({ bancos: ['bcp', 'yape'] }));
    expect(res.status).toBe(200);
    expect(guardado()).toEqual(['bcp', 'yape']);
  });

  /**
   * `null` no es "sin bancos": es el set COMPLETO, y además auto-incluye los bancos que
   * agreguemos después. Que un body raro colapse a `null` es el default seguro (leer de más
   * en un buzón que el usuario ya autorizó), pero tiene que ser deliberado y no un accidente:
   * si algún día `null` pasara a significar "ninguno", estos casos cambian de sentido.
   */
  describe('normalización del body', () => {
    it.each([
      ['todos marcados en la UI', { bancos: null }],
      ['sin la clave', {}],
      ['un objeto en vez de array', { bancos: { bcp: true } }],
      ['un string suelto', { bancos: 'bcp' }],
    ])('%s → null (= todos los bancos)', async (_caso, body) => {
      sesion('premium', 'convertido');
      await POST(post(body));
      expect(guardado()).toBeNull();
    });

    it('descarta los elementos que no son string en vez de guardarlos crudos', async () => {
      sesion('premium', 'convertido');
      await POST(post({ bancos: ['bcp', 42, null, { id: 'bbva' }, 'yape'] }));
      expect(guardado()).toEqual(['bcp', 'yape']);
    });

    // Un array vacío SÍ es una selección explícita, distinta de null. Hoy se guarda tal cual.
    it('el array vacío se guarda como array vacío, no como null', async () => {
      sesion('premium', 'convertido');
      await POST(post({ bancos: [] }));
      expect(guardado()).toEqual([]);
    });
  });
});
