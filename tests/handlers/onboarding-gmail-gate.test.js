import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

/**
 * El paso 30 es el emisor REAL de la URL de OAuth.
 *
 * `/conectar` (webhook) y `agregar_gmail` (consultas) no entregan nada: dejan al usuario en
 * `onboarding_paso = 30` con el menú de bancos, y la URL sale de acá cuando responde. O sea
 * que el estado vive en la base ENTRE dos mensajes, y el gate del llamador ya quedó atrás.
 * Sin un gate propio, alcanza con que el trial venza entre el comando y la respuesta para
 * entregar el enlace — y cada enlace canjeado quema uno de los 100 cupos de Google.
 */

// onboarding.js destructura sus dependencias al cargar, así que hay que parchear antes.
const supabaseMock = {
  from: vi.fn(() => {
    const c = {};
    for (const m of ['select', 'eq', 'single', 'maybeSingle']) c[m] = vi.fn(() => c);
    c.update = vi.fn(() => { const u = { eq: vi.fn(() => Promise.resolve({ data: null, error: null })) }; return u; });
    return c;
  }),
};
require('../../lib/db').supabase = supabaseMock;

const generarUrlAutorizacion = vi.fn(() => 'https://oauth.example/start');
require('../../gmail').generarUrlAutorizacion = generarUrlAutorizacion;
require('../../gmail').obtenerCuentasGmail = vi.fn().mockResolvedValue([]);

const { manejarOnboarding } = require('../../handlers/onboarding');

function enPaso30(extra) {
  return { id: 'u1', nombre: 'Ana', onboarding_paso: 30, ...extra };
}

describe('paso 30 — el enlace de OAuth solo sale para Pro pagado', () => {
  beforeEach(() => generarUrlAutorizacion.mockClear());

  // `plan: 'premium'` a secas es TRUE durante el trial (migración 052). Este es el caso que
  // el gate viejo dejaba pasar, y el motivo de que el predicado mire las dos columnas.
  it('no entrega el enlace a quien está en su trial, aunque plan valga premium', async () => {
    const res = await manejarOnboarding({
      usuario: enPaso30({ plan: 'premium', trial_estado: 'activo' }),
      msg: 'todos', cmd: 'todos', from: '+51999',
    });
    expect(res).toContain('Pro pagado');
    expect(res).not.toContain('https://oauth');
    expect(generarUrlAutorizacion).not.toHaveBeenCalled();
  });

  it('no entrega el enlace a quien cayó al muro', async () => {
    const res = await manejarOnboarding({
      usuario: enPaso30({ plan: 'free', trial_estado: 'vencido' }),
      msg: 'todos', cmd: 'todos', from: '+51999',
    });
    expect(generarUrlAutorizacion).not.toHaveBeenCalled();
    expect(res).not.toContain('https://oauth');
  });

  // Sin este caso los dos de arriba pasarían aunque el paso 30 estuviera roto del todo y no
  // entregara el enlace a nadie: un gate que niega siempre se ve idéntico a uno que funciona.
  it('SÍ entrega el enlace al Pro pagado', async () => {
    const res = await manejarOnboarding({
      usuario: enPaso30({ plan: 'premium', trial_estado: 'convertido' }),
      msg: 'todos', cmd: 'todos', from: '+51999',
    });
    expect(res).toContain('https://oauth');
    expect(generarUrlAutorizacion).toHaveBeenCalled();
  });

  // El gate saca al usuario del paso 30. Si no, queda atrapado: cada mensaje suyo se
  // interpreta como selección de bancos y le responde el mismo rechazo para siempre.
  it('deja al usuario fuera del paso 30 al rechazarlo', async () => {
    const chain = { update: vi.fn(() => ({ eq: vi.fn(() => Promise.resolve({ data: null, error: null })) })) };
    supabaseMock.from.mockReturnValueOnce(chain);
    await manejarOnboarding({
      usuario: enPaso30({ plan: 'premium', trial_estado: 'activo' }),
      msg: 'todos', cmd: 'todos', from: '+51999',
    });
    expect(chain.update).toHaveBeenCalledWith(expect.objectContaining({ onboarding_paso: 0 }));
  });
});
