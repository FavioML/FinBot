import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * El estado que esta ruta no sabía representar: **conectado Y caído**.
 *
 * Cuando Google revoca el refresh token, la fila de `gmail_cuentas` queda en `activa = true`
 * (a propósito: el cupo sigue gastado y el correo vinculado manda el `login_hint`). Como
 * `gmailConectado` salía de esa columna y nada más, la tarjeta de /dashboard/pro afirmaba
 * "Gmail conectado ✓" mientras no leía un solo correo, y el enlace de reconexión tenía que
 * estar siempre visible contradiciéndola.
 *
 * Los dos flags viajan juntos y los dos en `true` a la vez es la combinación que importa:
 * un test que solo mirara `gmailNecesitaReconexion` pasaría igual si alguien "arreglara" el
 * bug apagando `gmailConectado`, que rompería el `login_hint` y el modelo de una-cuenta.
 */

const requireNetoUser = vi.fn();

/** Filas que devuelve la base, por tabla. */
let filas: Record<string, unknown> = {};
/** Columnas que pidió cada `.select()`, por tabla. */
let selects: Record<string, string> = {};

vi.mock('@/lib/supabase/auth', () => ({
  requireNetoUser: (...args: unknown[]) => requireNetoUser(...args),
}));

vi.mock('@/lib/supabase/service', () => ({
  getServiceClient: () => ({
    from(tabla: string) {
      const q = {
        select(cols: string) {
          selects[tabla] = cols;
          return q;
        },
        eq: () => q,
        order: () => q,
        limit: () => q,
        maybeSingle: async () => ({ data: filas[tabla] ?? null, error: null }),
      };
      return q;
    },
  }),
}));

const { GET } = await import('./route');

beforeEach(() => {
  vi.clearAllMocks();
  filas = {};
  selects = {};
  requireNetoUser.mockResolvedValue({
    ok: true,
    authId: 'a1',
    user: {
      id: 'u1',
      plan: 'premium',
      trial_estado: 'convertido',
      trial_vence: null,
      pago_pendiente: false,
      premium_vence: '2027-01-01',
      tipo_plan: 'mensual',
      bancos_seleccionados: null,
      gmail_access_token: null,
      referido_dscto_pct: null,
      referido_dscto_vence: null,
    },
  });
});

async function body() {
  return (await (await GET()).json()) as Record<string, unknown>;
}

describe('GET /api/pro/status — estado de la conexión de Gmail', () => {
  it('pide auth_error_at en el select', async () => {
    // Sin este assert el resto pasaría por vacuidad: el mock devuelve la columna venga o no
    // en el `select`, así que una ruta que dejara de pedirla seguiría viéndose verde.
    filas.gmail_cuentas = { email: 'x@gmail.com', auth_error_at: null };
    await GET();
    expect(selects.gmail_cuentas).toContain('auth_error_at');
  });

  it('cuenta con el token muerto: conectado Y necesita reconexión, los dos true', async () => {
    filas.gmail_cuentas = { email: 'x@gmail.com', auth_error_at: '2026-08-03T12:00:00.000Z' };
    const b = await body();
    expect(b.gmailConectado).toBe(true);
    expect(b.gmailNecesitaReconexion).toBe(true);
    expect(b.gmailAuthErrorAt).toBe('2026-08-03T12:00:00.000Z');
  });

  it('cuenta sana: conectado sin nada que reconectar', async () => {
    filas.gmail_cuentas = { email: 'x@gmail.com', auth_error_at: null };
    const b = await body();
    expect(b.gmailConectado).toBe(true);
    expect(b.gmailNecesitaReconexion).toBe(false);
    expect(b.gmailAuthErrorAt).toBeNull();
  });

  it('sin cuenta: ni conectado ni caído (un false no puede significar las dos cosas)', async () => {
    const b = await body();
    expect(b.gmailConectado).toBe(false);
    expect(b.gmailNecesitaReconexion).toBe(false);
  });

  it('token legacy sin fila: conectado, y NO caído — de esos tokens no sabemos nada', async () => {
    requireNetoUser.mockResolvedValue({
      ok: true,
      authId: 'a1',
      user: { id: 'u1', plan: 'premium', trial_estado: 'convertido', gmail_access_token: 'legacy' },
    });
    const b = await body();
    expect(b.gmailConectado).toBe(true);
    expect(b.gmailNecesitaReconexion).toBe(false);
  });
});
